/**
 * Database access for lead routes: reading a lead's failure and putting it back in the lead
 * runner's queue.
 *
 * Serves: FR-32 (retry a failed lead); issue #15.
 * Used by: apps/api/src/modules/leads/leads.service.ts, apps/api/src/modules/leads/leads.module.ts.
 */
import { Injectable } from '@hazeljs/core';
import { PrismaProvider } from '../../db/prisma.provider.js';
import type { LeadStatus } from '../../generated/prisma/client.js';

/** What a retry needs to know about a lead. */
export interface LeadFailure {
  status: LeadStatus;
  /** The graph node that failed, e.g. "LABEL_REVIEWS"; null when it never failed. */
  failedStep: string | null;
}

/** Reads and writes `Lead` rows for the lead routes. */
@Injectable()
export class LeadsRepository {
  /**
   * Wires the repository to the process's database client.
   * @param prisma - The process's Prisma client.
   */
  constructor(private readonly prisma: PrismaProvider) {}

  /**
   * Reads a lead's status and failed step.
   * @param id - `Lead.id`.
   * @returns The lead's failure, or null when there is no such lead.
   * @throws Prisma errors when the database cannot be read.
   */
  findFailure(id: string): Promise<LeadFailure | null> {
    return this.prisma.lead.findUnique({
      where: { id },
      select: { status: true, failedStep: true },
    });
  }

  /**
   * Puts a FAILED lead back in the lead runner's queue at `status`, clearing its failure and any
   * claim. One UPDATE that repeats the FAILED check, so two clicks cannot both re-queue it.
   *
   * Does not touch the lead's stored enrichment, reviews or labels: the graph's steps skip them.
   * @param id - `Lead.id`.
   * @param status - Where its next graph run starts: DISCOVERED or ENRICHED.
   * @returns False when the lead was no longer FAILED.
   * @throws Prisma errors when the database cannot be written.
   */
  async requeue(id: string, status: 'DISCOVERED' | 'ENRICHED'): Promise<boolean> {
    const { count } = await this.prisma.lead.updateMany({
      where: { id, status: 'FAILED' },
      data: { status, failedStep: null, error: null, graphClaimedAt: null },
    });
    return count === 1;
  }
}
