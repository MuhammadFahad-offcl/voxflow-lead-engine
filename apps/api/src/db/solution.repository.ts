/**
 * Database access for the solution step: a scored lead as the solution agent reads it.
 *
 * Serves: FR-17 (signals that cite evidence), FR-36 (demo prompts that replay); issue #19.
 * Used by: apps/api/src/llm-record-solution.ts; the lead graph's solution step (#19 part 2b).
 */
import { Inject, Injectable } from '@hazeljs/core';
import type { SolutionLead } from '../agents/solution.agent.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { PrismaProvider } from './prisma.provider.js';

/** Reads leads for the solution agent. */
@Injectable()
export class SolutionRepository {
  /**
   * Wires the repository to a database client.
   * @param prisma - The process's Prisma client; the recorder passes its scratch database's.
   */
  constructor(@Inject(PrismaProvider) private readonly prisma: PrismaClient) {}

  /**
   * Loads a scored lead with its evidenced signals (points > 0), sorted by key.
   *
   * Sorted so the agent's prompt is the same text on every run: demo mode replays recorded
   * answers by a hash of that text. Does not load the 0-point notes: they are not evidence (FR-17).
   * @param leadId - `Lead.id`.
   * @returns The lead as the solution agent reads it.
   * @throws Prisma's not-found error for an unknown lead; Error for a lead not scored yet.
   */
  async forSolution(leadId: string): Promise<SolutionLead> {
    const lead = await this.prisma.lead.findUniqueOrThrow({
      where: { id: leadId },
      select: {
        organizationId: true,
        campaignId: true,
        name: true,
        area: true,
        tier: true,
        score: true,
        signals: {
          where: { points: { gt: 0 } },
          orderBy: { key: 'asc' },
          select: { key: true, dimension: true, points: true, evidence: true },
        },
      },
    });
    const { tier, score, ...rest } = lead;
    if (tier === null || score === null) throw new Error(`Lead ${leadId} has no score yet`);
    return { ...rest, leadId, tier, score };
  }
}
