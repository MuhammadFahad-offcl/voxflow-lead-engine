/**
 * Database access for lead routes: reading one lead for its detail page, reading a lead's failure
 * and putting it back in the lead runner's queue.
 *
 * Serves: FR-32 (retry a failed lead), issue #15; FR-30 (lead detail), FR-17, issue #24.
 * Used by: apps/api/src/modules/leads/leads.service.ts, apps/api/src/modules/leads/leads.module.ts.
 */
import { Injectable } from '@hazeljs/core';
import { PrismaProvider } from '../../db/prisma.provider.js';
import type { LeadStatus, Prisma } from '../../generated/prisma/client.js';

const DETAIL = {
  id: true,
  campaignId: true,
  name: true,
  area: true,
  phone: true,
  phoneType: true,
  website: true,
  rating: true,
  reviewCount: true,
  score: true,
  tier: true,
  status: true,
  failedStep: true,
  error: true,
  filterReason: true,
  scoreBreakdown: true,
  signals: {
    select: { id: true, key: true, dimension: true, points: true, evidence: true, sourceUrl: true },
    // Highest points first, as in the lead table.
    orderBy: [{ points: 'desc' }, { key: 'asc' }],
  },
  reviews: {
    // No `author`: review authors never leave the database (CLAUDE.md).
    select: {
      id: true,
      text: true,
      rating: true,
      publishedAt: true,
      ownerReplied: true,
      labels: true,
    },
    orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
  },
  solution: {
    select: {
      reason: true,
      model: true,
      signalIds: true,
      service: { select: { slug: true, name: true } },
    },
  },
} as const satisfies Prisma.LeadSelect;

/** A lead as its detail page reads it. */
export type LeadDetailRow = Prisma.LeadGetPayload<{ select: typeof DETAIL }>;

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
   * Reads one lead with its signals, reviews and Solution.
   * @param id - `Lead.id`.
   * @returns The lead, or null when there is no such lead.
   * @throws Prisma errors when the database cannot be read.
   */
  findDetail(id: string): Promise<LeadDetailRow | null> {
    return this.prisma.lead.findUnique({ where: { id }, select: DETAIL });
  }

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
   * @param status - Where its next graph run starts: DISCOVERED, ENRICHED or SCORED.
   * @returns False when the lead was no longer FAILED.
   * @throws Prisma errors when the database cannot be written.
   */
  async requeue(id: string, status: 'DISCOVERED' | 'ENRICHED' | 'SCORED'): Promise<boolean> {
    const { count } = await this.prisma.lead.updateMany({
      where: { id, status: 'FAILED' },
      data: { status, failedStep: null, error: null, graphClaimedAt: null },
    });
    return count === 1;
  }
}
