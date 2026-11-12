/**
 * The LLM gate: every LLM call goes through here. It takes the task's model from Settings, refuses
 * a call whose worst case could pass the monthly cap, records every call's cost, and parses the
 * answer with the task's Zod schema, retrying once with the problems appended.
 *
 * Serves: FR-13 (JSON validated by Zod, invalid output rejected), FR-33 and NFR-4 (the $10
 * monthly hard cap, cost per lead and per call), ADR-0006 (model per task); issue #13.
 * Used by: apps/api/src/pipeline/label-reviews.step.ts, apps/api/src/scheduler/lead-runner.ts,
 * apps/api/test/llm-gate.int.spec.ts.
 */
import { Inject, Injectable } from '@hazeljs/core';
import { z } from 'zod';
import { llmCostUsd, llmMaxCostUsd } from '../config/llm-prices.js';
import { LlmSpendRepository, type LlmSpend } from '../db/llm-spend.repository.js';
import { Prisma } from '../generated/prisma/client.js';
import { errorFields, LOGGER, type Logger } from '../logging/logger.js';
import { karachiMonthStart, wouldPassCap } from '../pipeline/spend-cap.js';
import {
  LLM,
  LlmError,
  type LlmPort,
  type LlmReply,
  type LlmRequest,
  type LlmTask,
} from '../ports/llm.port.js';

// One retry: a second bad answer is unlikely to become good on a third try, and each try is paid.
const MAX_ATTEMPTS = 2;

// CostRecord.amountUsd keeps 5 decimals; a token costs $0.0000001, so round up, never down, or the
// stored spend could sit below the real spend under a hard cap.
const toStoredUsd = (usd: Prisma.Decimal): Prisma.Decimal =>
  usd.toDecimalPlaces(5, Prisma.Decimal.ROUND_UP);

/** A call refused because its worst case could take the month's LLM spend past the cap. */
export class SpendCapReachedError extends Error {
  /**
   * Builds the error.
   * @param reason - The sentence for the dashboard banner, with the amounts.
   */
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SpendCapReachedError';
  }
}

/** The model answered twice with something that does not match the task's schema. */
export class LlmOutputInvalidError extends Error {
  /**
   * Builds the error.
   * @param task - The task whose answers were invalid.
   */
  constructor(readonly task: LlmTask) {
    super(`LLM answer for ${task} was invalid twice`);
    this.name = 'LlmOutputInvalidError';
  }
}

/** One call through the gate. */
export interface LlmCall<T> {
  organizationId: string;
  /** The campaign the call works for, or null; stored on the cost record. */
  campaignId: string | null;
  /** The lead the call works on, or null; stored on the cost record. */
  leadId: string | null;
  task: LlmTask;
  /** Instructions; the same for every call of a task. */
  system: string;
  /** The data to work on. */
  user: string;
  /** The shape the answer must have. */
  schema: z.ZodType<T>;
  /** The most tokens one answer may use. */
  maxTokens: number;
}

/** A valid answer and what getting it cost. */
export interface LlmResult<T> {
  data: T;
  /** US dollars, both attempts together when there was a retry. */
  costUsd: Prisma.Decimal;
  /** The model from Settings that answered. */
  model: string;
}

type Parsed<T> = { ok: true; data: T } | { ok: false; problems: string };

/**
 * Checks an answer against the task's schema.
 * @param text - The model's answer.
 * @param schema - The task's schema.
 * @returns The data, or the problems in words for the retry prompt.
 */
const parseAnswer = <T>(text: string, schema: z.ZodType<T>): Parsed<T> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problems: 'The answer was not valid JSON.' };
  }
  const result = schema.safeParse(json);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, problems: z.prettifyError(result.error) };
};

/** Sends LLM calls under the monthly cap, records their cost and validates their answers. */
@Injectable()
export class LlmService {
  /**
   * Wires the gate to its settings and spend, the model, and the logger.
   * @param spend - Reads the model, cap and spend; writes cost records.
   * @param llm - The bound LLM adapter (real, or fake in demo mode).
   * @param logger - Root logger.
   */
  constructor(
    private readonly spend: LlmSpendRepository,
    @Inject(LLM) private readonly llm: LlmPort,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Gets a valid answer for one task, under the monthly cap.
   *
   * Before each attempt, the month's LLM spend (Asia/Karachi month) plus the attempt's worst case
   * must stay within `Settings.spendCaps.llmMonthlyUsd`. Calls in flight at the same moment can
   * each pass that check, so the cap can be passed by at most one worst case per call in flight
   * (about $0.001 for a 2,000-token answer on Haiku 5.5); the same trade as the Perplexity cap (#12).
   * Costs are rounded up to the cent's thousandth (5 decimals), as stored.
   * Every attempt writes a `CostRecord` (service LLM): its true cost, or its worst case when it
   * failed in a way that may have been billed. A failure known not to be billed records nothing.
   * A bad answer is retried once, with its problems appended to the prompt.
   * Logs the task, attempt and stop reason only: never a prompt or an answer.
   * Does not pause a step or set a banner: the caller handles {@link SpendCapReachedError}.
   * @param call - The task, prompts, schema and whom the cost belongs to.
   * @returns The parsed answer, its cost and the model.
   * @throws SpendCapReachedError when an attempt could pass the cap; nothing is sent then.
   * LlmOutputInvalidError after two answers that fail the schema. LlmError when the model call
   * fails. Error when the task's model has no price; nothing is sent then. Prisma and Zod errors for
   * missing or invalid settings.
   */
  async complete<T>(call: LlmCall<T>): Promise<LlmResult<T>> {
    let user = call.user;
    let costUsd: Prisma.Decimal | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const sent = await this.attempt(call, user, attempt);
      costUsd = costUsd === null ? sent.costUsd : costUsd.plus(sent.costUsd);
      const parsed = parseAnswer(sent.reply.text, call.schema);
      if (parsed.ok) return { data: parsed.data, costUsd, model: sent.model };
      this.logger.warn(
        { task: call.task, attempt, stopReason: sent.reply.stopReason, leadId: call.leadId },
        'LLM answer did not match its schema',
      );
      user = `${call.user}\n\nYour previous answer was not valid:\n${parsed.problems}\nAnswer again with only JSON that matches the schema.`;
    }
    throw new LlmOutputInvalidError(call.task);
  }

  /**
   * The current time; a spec overrides it to fix the month.
   * @returns Now.
   */
  protected now(): Date {
    return new Date();
  }

  private async attempt<T>(
    call: LlmCall<T>,
    user: string,
    attempt: number,
  ): Promise<{ reply: LlmReply; costUsd: Prisma.Decimal; model: string }> {
    const since = karachiMonthStart(this.now());
    const { model, capUsd, spentUsd } = await this.spend.budget(
      call.organizationId,
      call.task,
      since,
    );
    const request: LlmRequest = { ...call, model, user };
    // Throws for a model with no price, before anything is sent.
    const maxCostUsd = toStoredUsd(llmMaxCostUsd(request));
    if (wouldPassCap(spentUsd, maxCostUsd, capUsd)) {
      const [spent, next, cap] = [spentUsd, maxCostUsd, capUsd].map((usd) => usd.toFixed(4));
      throw new SpendCapReachedError(
        `LLM monthly cap: $${String(spent)} spent this month, the next call may cost $${String(next)}, the cap is $${String(cap)}`,
      );
    }
    const record = (
      amountUsd: Prisma.Decimal,
      usage: { inputTokens: number; outputTokens: number } | null,
    ) => {
      const { inputTokens, outputTokens } = usage ?? { inputTokens: 0, outputTokens: 0 };
      // `estimated` marks a worst case recorded for a call whose real usage is unknown.
      const note = JSON.stringify({
        task: call.task,
        model,
        attempt,
        inputTokens,
        outputTokens,
        ...(usage === null ? { estimated: true } : {}),
      });
      const spend: LlmSpend = {
        organizationId: call.organizationId,
        campaignId: call.campaignId,
        leadId: call.leadId,
        amountUsd,
        units: inputTokens + outputTokens,
        note,
      };
      return this.spend.record(spend);
    };
    let reply: LlmReply;
    try {
      reply = await this.llm.complete(request);
    } catch (error) {
      // Only a failure known not to be billed is free; anything else counts against the cap.
      if (!(error instanceof LlmError) || error.maybeBilled) {
        // A failed write must not hide why the call failed: log it, then rethrow the call's error.
        await record(maxCostUsd, null).catch((recordError: unknown) => {
          this.logger.error(
            { task: call.task, attempt, ...errorFields(recordError) },
            'LLM worst-case cost could not be recorded',
          );
        });
      }
      throw error;
    }
    // Priced by the Settings model, not the answer's: a dated model id would have no price.
    const costUsd = toStoredUsd(llmCostUsd(model, reply.usage));
    await record(costUsd, reply.usage);
    return { reply, costUsd, model };
  }
}
