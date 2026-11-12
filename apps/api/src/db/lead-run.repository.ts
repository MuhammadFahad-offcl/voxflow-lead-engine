/**
 * Database access for the lead graph: the lead runner's claim on a lead. The status changes a
 * graph run makes come with the graph (#15, next PR); the run itself and its checkpoints live in
 * HazelJS's SQL durable run store, not here.
 *
 * Serves: FR-32 (per-lead status and error), NFR-1, NFR-2, ADR-0001, ADR-0002; issue #15.
 * Used by: apps/api/test/lead-run.int.spec.ts; the lead graph and runner (#15, next PRs).
 */
import { Injectable } from '@hazeljs/core';
import type { Prisma, WebsiteStatus } from '../generated/prisma/client.js';
import { NO_REVIEWS_ERROR } from './review.repository.js';
import { PrismaProvider } from './prisma.provider.js';

/** A lead held by one runner pass; `claimedAt` is the lease value only that pass knows. */
export interface ClaimedLead {
  id: string;
  campaignId: string;
  /** Where its graph starts: DISCOVERED still needs enrichment, ENRICHED goes to labelling. */
  status: 'DISCOVERED' | 'ENRICHED';
  /** PENDING until the website step ran, so a resumed lead does not read its site twice. */
  websiteStatus: WebsiteStatus;
  /** The HazelJS run of its previous graph run, if any. */
  graphRunId: string | null;
  claimedAt: Date;
}

const RUNNABLE = ['DISCOVERED', 'ENRICHED'] as const;

/**
 * Which leads a runner may claim at `now`.
 * @param now - The claim time.
 * @param leaseMs - How old a claim must be to count as abandoned, in milliseconds.
 * @returns The Prisma condition.
 */
const claimable = (now: Date, leaseMs: number) =>
  ({
    status: { in: [...RUNNABLE] },
    // PAUSED, DISCOVERING and later campaigns wait; SCORING still takes a retried lead.
    campaign: { status: { in: ['ENRICHING', 'SCORING'] } },
    AND: [
      {
        OR: [
          { graphClaimedAt: null },
          { graphClaimedAt: { lt: new Date(now.getTime() - leaseMs) } },
        ],
      },
      // Its reviews are settled: stored, or the paid run found none. A lead deferred by the Apify
      // cap waits. One that already started a graph is past reviews even if a failure replaced
      // its error.
      {
        OR: [{ reviews: { some: {} } }, { error: NO_REVIEWS_ERROR }, { graphRunId: { not: null } }],
      },
    ],
  }) satisfies Prisma.LeadWhereInput;

const isRunnable = (status: string): status is ClaimedLead['status'] =>
  (RUNNABLE as readonly string[]).includes(status);

/** Reads and writes what the lead graph needs. */
@Injectable()
export class LeadRunRepository {
  /**
   * Wires the repository to the process's database client.
   * @param prisma - The process's Prisma client.
   */
  constructor(private readonly prisma: PrismaProvider) {}

  /**
   * Claims up to `limit` leads whose graph should run, oldest first.
   *
   * The UPDATE repeats the condition, so when two passes pick the same lead Postgres makes the
   * second wait and re-check: it matches nothing, and the lead is claimed once.
   * Does not claim a FILTERED_OUT, FAILED or SCORED lead, a lead whose campaign is paused, or a
   * lead still waiting for its reviews.
   * @param now - The lease time; it is also each claim's proof of ownership.
   * @param leaseMs - How old a claim must be to count as abandoned, in milliseconds.
   * @param limit - The most leads to claim; the runner's concurrency.
   * @returns The leads this pass now holds; empty when nothing is free.
   */
  async claimNext(now: Date, leaseMs: number, limit: number): Promise<ClaimedLead[]> {
    const where = claimable(now, leaseMs);
    const candidates = await this.prisma.lead.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    if (candidates.length === 0) return [];
    const claimed = await this.prisma.lead.updateManyAndReturn({
      where: { id: { in: candidates.map((lead) => lead.id) }, ...where },
      data: { graphClaimedAt: now },
      select: { id: true, campaignId: true, status: true, websiteStatus: true, graphRunId: true },
    });
    return claimed.flatMap(({ status, ...lead }) =>
      // Always true: the WHERE only matches runnable statuses. The check narrows the type.
      isRunnable(status) ? [{ ...lead, status, claimedAt: now }] : [],
    );
  }
}
