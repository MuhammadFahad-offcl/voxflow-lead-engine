/**
 * Database access for the solution step: a scored lead as the solution agent reads it, and the
 * agent's outcome stored as a Solution row or the lead's exit status.
 *
 * Serves: FR-17 (signals that cite evidence; NEEDS_REVIEW, NO_STRONG_SIGNAL), FR-36 (demo prompts
 * that replay); issue #19.
 * Used by: apps/api/src/pipeline/solution.step.ts, apps/api/src/llm-record-solution.ts,
 * apps/api/test/solution-replay.int.spec.ts, apps/api/test/solution-repository.int.spec.ts.
 */
import { Inject, Injectable } from '@hazeljs/core';
import type { SolutionLead } from '../agents/solution.agent.js';
import type { LeadStatus, PrismaClient } from '../generated/prisma/client.js';
import { PrismaProvider } from './prisma.provider.js';

/** A lead read from the database: its ids are always there, unlike the recorder's scratch leads. */
export interface StoredSolutionLead extends SolutionLead {
  campaignId: string;
  leadId: string;
  /** With `Signal.id`, to store the cited signals by id. */
  signals: (SolutionLead['signals'][number] & { id: string })[];
}

/** What the solution step stores: a pick, or one of the two exit statuses. */
export type StoredOutcome =
  | { kind: 'pick'; serviceSlug: string; reason: string; signalKeys: string[]; model: string }
  | { kind: 'exit'; status: 'NO_STRONG_SIGNAL' | 'NEEDS_REVIEW' };

/** Reads leads for the solution agent and stores what it decided. */
@Injectable()
export class SolutionRepository {
  /**
   * Wires the repository to a database client.
   * @param prisma - The process's Prisma client; the recorder passes its scratch database's.
   */
  constructor(@Inject(PrismaProvider) private readonly prisma: PrismaClient) {}

  /**
   * Loads a scored lead with its evidenced signals (points > 0), sorted by key, and whether it
   * already has a Solution.
   *
   * Sorted so the agent's prompt is the same text on every run: demo mode replays recorded
   * answers by a hash of that text. Does not load the 0-point notes: they are not evidence (FR-17).
   * @param leadId - `Lead.id`.
   * @returns The lead as the solution agent reads it, its status and whether it has a Solution.
   * @throws Prisma's not-found error for an unknown lead; Error for a lead not scored yet.
   */
  async forSolution(
    leadId: string,
  ): Promise<StoredSolutionLead & { status: LeadStatus; solved: boolean }> {
    const lead = await this.prisma.lead.findUniqueOrThrow({
      where: { id: leadId },
      select: {
        organizationId: true,
        campaignId: true,
        name: true,
        area: true,
        tier: true,
        score: true,
        status: true,
        solution: { select: { id: true } },
        signals: {
          where: { points: { gt: 0 } },
          select: { id: true, key: true, dimension: true, points: true, evidence: true },
        },
      },
    });
    const { tier, score, signals, solution, ...rest } = lead;
    if (tier === null || score === null) throw new Error(`Lead ${leadId} has no score yet`);
    // Sorted here, by code point, not in SQL: Postgres orders text by the server's collation,
    // which can differ between machines and would change the prompt.
    const byKey = signals.toSorted((a, b) => {
      if (a.key === b.key) return 0;
      return a.key < b.key ? -1 : 1;
    });
    return { ...rest, signals: byKey, leadId, tier, score, solved: solution !== null };
  }

  /**
   * Stores the agent's outcome for a SCORED lead: a Solution row (the lead stays SCORED until its
   * script, #20), or the exit status.
   *
   * Safe to repeat after a crash: a second Solution for the lead is skipped, and the status only
   * changes while the lead is still SCORED with no Solution.
   * @param lead - The lead, with its signals as {@link forSolution} read them.
   * @param outcome - What to store; the pick's slug and signal keys were checked by the agent.
   * @returns False when nothing was stored: the lead already had a Solution, or had left SCORED.
   * @throws Prisma's not-found error when the picked service is not in the lead's catalog; Error
   * when a cited key is not one of the lead's signals (the agent's check rules both out).
   */
  async saveOutcome(lead: StoredSolutionLead, outcome: StoredOutcome): Promise<boolean> {
    if (outcome.kind === 'exit') {
      const { count } = await this.prisma.lead.updateMany({
        where: { id: lead.leadId, status: 'SCORED', solution: { is: null } },
        data: { status: outcome.status },
      });
      return count > 0;
    }
    const service = await this.prisma.service.findUniqueOrThrow({
      where: {
        organizationId_slug: { organizationId: lead.organizationId, slug: outcome.serviceSlug },
      },
      select: { id: true },
    });
    const signalIds = outcome.signalKeys.map((key) => {
      const signal = lead.signals.find((candidate) => candidate.key === key);
      if (signal === undefined) throw new Error(`Signal ${key} is not on lead ${lead.leadId}`);
      return signal.id;
    });
    // `leadId` is unique: a repeat after a crash adds nothing.
    const { count } = await this.prisma.solution.createMany({
      data: {
        leadId: lead.leadId,
        serviceId: service.id,
        reason: outcome.reason,
        signalIds,
        model: outcome.model,
      },
      skipDuplicates: true,
    });
    return count > 0;
  }
}
