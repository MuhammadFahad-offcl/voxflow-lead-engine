/**
 * The real LLM: one Anthropic Messages API request per call, thinking off, answer constrained to
 * the caller's schema as JSON.
 *
 * Uses `@anthropic-ai/sdk` directly, not `@hazeljs/ai` 2.0.13, whose Anthropic provider cannot turn
 * thinking off or send an output schema and hides the HTTP status behind a plain Error (ADR-0006).
 *
 * Serves: FR-13, FR-33, NFR-4, ADR-0006, ADR-0007; issue #13.
 * API: https://platform.claude.com/docs/en/api/messages
 * Used by: apps/api/src/bootstrap.ts, through `bindAdapter`, when DEMO_MODE=false.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Inject, Injectable } from '@hazeljs/core';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { ENV, type Env } from '../../config/env.js';
import { LOGGER, type Logger } from '../../logging/logger.js';
import { LlmError, type LlmPort, type LlmReply, type LlmRequest } from '../../ports/llm.port.js';

// A labelling answer takes seconds; past this the request is dropped, not waited on.
const TIMEOUT_MS = 60_000;
// Anthropic does not bill 429, 5xx or 529 (overloaded) answers, so only these are retried, twice.
const MAX_RETRIES = 2;
// Failures before the request left this machine: nothing was sent, so nothing was billed.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

// Only what this adapter reads; anything else in the answer is ignored.
const MessageAnswer = z.object({
  model: z.string(),
  stop_reason: z.string().nullable(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

// Walks the cause chain by shape, not instanceof: the fetch error comes from another realm under
// Jest, and the SDK wraps it once more.
const errorCode = (error: unknown): string | null => {
  for (let cause: unknown = error; cause !== null && typeof cause === 'object';) {
    const { code, cause: next } = cause as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    cause = next;
  }
  return null;
};

/**
 * Sorts a failed request into "retry, it was not billed" or the error to throw.
 * @param error - What the SDK threw.
 * @returns The retry reason, or the LlmError with whether the request may have been billed.
 */
const classify = (error: unknown): { retry: string } | LlmError => {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError('Anthropic API timed out', true);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    // Either way but "refused" the request may have reached Anthropic before it went wrong.
    if (NOT_SENT.has(errorCode(error.cause) ?? '')) return { retry: 'not sent' };
    return new LlmError('Anthropic API connection failed', true);
  }
  if (error instanceof Anthropic.APIError && typeof error.status === 'number') {
    if (error.status === 429 || error.status >= 500)
      return { retry: `HTTP ${String(error.status)}` };
    return new LlmError(`Anthropic API refused the request: HTTP ${String(error.status)}`, false);
  }
  // Not an SDK error: something unforeseen, so count it as possibly billed.
  return new LlmError('Anthropic API call failed unexpectedly', true);
};

/** Calls Claude through the Anthropic Messages API. */
@Injectable()
export class AnthropicLlmAdapter implements LlmPort {
  /** The API root, or undefined for Anthropic's; a spec points it at a local stub. */
  protected readonly baseUrl: string | undefined = undefined;
  /** How long one request may take, in milliseconds. */
  protected readonly timeoutMs: number = TIMEOUT_MS;
  /** The wait before the first retry, in milliseconds; each later retry waits twice as long. */
  protected readonly retryDelayMs: number = 1000;
  private readonly apiKey: string;
  private client: Anthropic | undefined;

  /**
   * Wires the adapter to its key and logger.
   * @param env - Parsed configuration; `loadEnv` guarantees ANTHROPIC_API_KEY when DEMO_MODE=false.
   * @param logger - Root logger.
   */
  constructor(
    @Inject(ENV) env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    // Never empty in practice: `loadEnv` refuses to start without it when DEMO_MODE=false.
    this.apiKey = env.ANTHROPIC_API_KEY ?? '';
  }

  /**
   * Sends one message and returns the answer's text and usage.
   *
   * Turns thinking off: labelling needs none, and thinking tokens are billed as output.
   * Retries only a 429, a 5xx or a request that never left this machine: those are not billed. A
   * timeout or a dropped connection is thrown at once, because the request may already have been
   * billed and a retry would pay twice. The SDK's own retries are off for the same reason.
   * Logs attempt numbers and fixed reasons only: never a prompt, an answer or the key.
   * @inheritDoc
   * @throws LlmError for a schema the API cannot take (never sent), an HTTP error, a timeout, a
   * dropped connection, an answer that is not the Messages API shape, or retries used up; its
   * `maybeBilled` says whether it may have cost money.
   */
  async complete(request: LlmRequest): Promise<LlmReply> {
    let format: ReturnType<typeof zodOutputFormat>;
    try {
      format = zodOutputFormat(request.schema);
    } catch {
      // A schema with no JSON type (z.unknown(), z.any()) is a coding error, caught before sending.
      throw new LlmError('Answer schema cannot be sent as a JSON output format', false);
    }
    const answer = await this.send(request, format);
    const parsed = MessageAnswer.safeParse(answer);
    // Not parsed.error: a Zod message may quote the answer.
    if (!parsed.success) throw new LlmError('Anthropic answer has an unexpected shape', true);
    const { model, stop_reason: stopReason, content, usage } = parsed.data;
    return {
      text: content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join(''),
      usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
      model,
      stopReason: stopReason ?? 'unknown',
    };
  }

  private async send(
    request: LlmRequest,
    format: ReturnType<typeof zodOutputFormat>,
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.api().messages.create({
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          thinking: { type: 'disabled' },
          output_config: { format },
        });
      } catch (error) {
        const outcome = classify(error);
        if (outcome instanceof LlmError) throw outcome;
        if (attempt > MAX_RETRIES) {
          throw new LlmError(`Anthropic API failed after retries: ${outcome.retry}`, false);
        }
        this.logger.warn({ attempt, reason: outcome.retry }, 'Anthropic request will be retried');
        await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  // Built on first use, so a spec's overridden baseUrl and timeout are already set.
  private api(): Anthropic {
    this.client ??= new Anthropic({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
      maxRetries: 0,
      // Set here, not left to ANTHROPIC_LOG and ANTHROPIC_OPEN_TELEMETRY_*: at debug the SDK logs
      // whole requests, and traces can carry message content. Prompts hold review text.
      logLevel: 'off',
      openTelemetry: false,
    });
    return this.client;
  }
}
