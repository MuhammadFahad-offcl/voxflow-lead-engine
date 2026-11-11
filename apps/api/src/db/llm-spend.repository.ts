/**
 * Database access for the LLM gate: a task's model and the monthly cap from Settings, the LLM spend
 * so far this month, and one cost record per call.
 *
 * Serves: FR-33, NFR-4 (cost per lead and per call), ADR-0006 (model per task); issue #13.
 * Used by: apps/api/src/llm/llm.service.ts, apps/api/test/llm-gate.int.spec.ts.
 */
import { Injectable } from '@hazeljs/core';
import { LlmModels, SpendCaps } from '@voxflow/shared';
import { Prisma } from '../generated/prisma/client.js';
import type { LlmTask } from '../ports/llm.port.js';
import { PrismaProvider } from './prisma.provider.js';

/** What the gate needs to know before a call. */
export interface LlmBudget {
  /** The model `Settings.llmModels` names for the task. */
  model: string;
  /** `Settings.spendCaps.llmMonthlyUsd`, in US dollars. */
  capUsd: Prisma.Decimal;
  /** LLM spend recorded since the month began, in US dollars. */
  spentUsd: Prisma.Decimal;
}

/** One LLM call's cost record. */
export interface LlmSpend {
  organizationId: string;
  /** The campaign the call worked for, or null for a call outside a campaign. */
  campaignId: string | null;
  /** The lead the call worked on, or null. */
  leadId: string | null;
  /** US dollars: the true cost, or the worst case when the call may have been billed unseen. */
  amountUsd: Prisma.Decimal;
  /** Input plus output tokens; 0 when the provider never said. */
  units: number;
  /** JSON with the task, model, attempt and token counts; never prompt or answer text. */
  note: string;
}

/** Reads the LLM settings and spend, and writes LLM cost records. */
@Injectable()
export class LlmSpendRepository {
  /**
   * Wires the repository to the process's database client.
   * @param prisma - The process's Prisma client.
   */
  constructor(private readonly prisma: PrismaProvider) {}

  /**
   * Reads the task's model, the monthly cap and the spend so far, fresh for every call, so a
   * changed setting holds from the next call.
   * @param organizationId - Owner of the spend.
   * @param task - What the call is for.
   * @param since - Start of the capped month (Asia/Karachi), as a UTC instant.
   * @returns The model, the cap and the spend, in US dollars.
   * @throws Prisma's not-found error when the organization has no settings; ZodError when its
   * `spendCaps` or `llmModels` are invalid.
   */
  async budget(organizationId: string, task: LlmTask, since: Date): Promise<LlmBudget> {
    const { spendCaps, llmModels } = await this.prisma.settings.findUniqueOrThrow({
      where: { organizationId },
      select: { spendCaps: true, llmModels: true },
    });
    const { _sum: sum } = await this.prisma.costRecord.aggregate({
      where: { organizationId, service: 'LLM', at: { gte: since } },
      _sum: { amountUsd: true },
    });
    return {
      model: LlmModels.parse(llmModels)[task],
      capUsd: new Prisma.Decimal(SpendCaps.parse(spendCaps).llmMonthlyUsd),
      spentUsd: sum.amountUsd ?? new Prisma.Decimal(0),
    };
  }

  /**
   * Writes one LLM cost record.
   * @param spend - What the call cost and whom it worked for.
   * @throws Prisma errors, e.g. a foreign-key error for an unknown lead or campaign.
   */
  async record(spend: LlmSpend): Promise<void> {
    await this.prisma.costRecord.create({ data: { ...spend, service: 'LLM' } });
  }
}
