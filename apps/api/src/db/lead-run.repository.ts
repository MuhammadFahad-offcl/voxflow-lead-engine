/**
 * Database access for the lead graph: the lead runner's claim on a lead, and the status changes
 * a graph run makes to it (ENRICHED, FAILED, the run id). The run itself and its checkpoints live
 * in HazelJS's SQL durable run store, not here.
 *
 * Serves: FR-32 (per-lead status and error), NFR-1, NFR-2, ADR-0001, ADR-0002; issue #15.
 * Used by: apps/api/src/pipeline/lead.graph.ts, apps/api/test/lead-graph.int.spec.ts.
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
   * @throws Prisma errors when the database cannot be read or written; Error when a claimed lead is
   * not DISCOVERED or ENRICHED, which the condition rules out (a bug, not data).
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
    return claimed.map(({ status, ...lead }) => {
      // The WHERE only matches runnable statuses; the check narrows the type. Dropping the lead
      // instead would leave it claimed with no runner until the lease ran out.
      if (!isRunnable(status)) throw new Error(`Claimed lead ${lead.id} is ${status}`);
      return { ...lead, status, claimedAt: now };
    });
  }

  /**
   * Records the HazelJS run id of the lead's new graph run.
   * @param lead - The claimed lead.
   * @param runId - The `AgentRun` id from the durable run store.
   * @returns False when the claim was lost (its lease ran out and another pass took the lead).
   */
  async startRun(lead: Pick<ClaimedLead, 'id' | 'claimedAt'>, runId: string): Promise<boolean> {
    const { count } = await this.prisma.lead.updateMany({
      where: { id: lead.id, graphClaimedAt: lead.claimedAt },
      data: { graphRunId: runId },
    });
    return count === 1;
  }

  /**
   * Marks a lead ENRICHED once its website and web context are in.
   *
   * Does not move a lead that is not DISCOVERED: a repeat leaves ENRICHED as it is.
   * @param leadId - `Lead.id`.
   */
  async markEnriched(leadId: string): Promise<void> {
    await this.prisma.lead.updateMany({
      where: { id: leadId, status: 'DISCOVERED' },
      data: { status: 'ENRICHED' },
    });
  }

  /**
   * Ends the claim after a run finished or paused; the lead keeps the status its steps gave it.
   *
   * Does nothing when the claim was lost: the other pass owns the lead now.
   * @param lead - The claimed lead.
   */
  async release(lead: Pick<ClaimedLead, 'id' | 'claimedAt'>): Promise<void> {
    await this.prisma.lead.updateMany({
      where: { id: lead.id, graphClaimedAt: lead.claimedAt },
      data: { graphClaimedAt: null },
    });
  }

  /**
   * Marks a lead FAILED at a step, with the error's message, and ends the claim (FR-32).
   *
   * Does not touch a lead past enrichment and labelling (the score step moved it on), nor one whose
   * claim was lost. Does not store a stack or any other part of the error.
   * @param lead - The claimed lead.
   * @param step - The graph node that failed, e.g. "ENRICH_WEBSITE".
   * @param message - The error's message.
   */
  async fail(
    lead: Pick<ClaimedLead, 'id' | 'claimedAt'>,
    step: string,
    message: string,
  ): Promise<void> {
    await this.prisma.lead.updateMany({
      where: { id: lead.id, graphClaimedAt: lead.claimedAt, status: { in: [...RUNNABLE] } },
      data: { status: 'FAILED', failedStep: step, error: message, graphClaimedAt: null },
    });
  }
}
