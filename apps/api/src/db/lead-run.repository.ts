/**
 * Database access for the lead runner and the lead graph: the claim on a lead, the status changes
 * a graph run makes to it (ENRICHED, FAILED, the run id), and the campaign changes the runner
 * makes (ENRICHING → SCORING, a pause for an Apify check). The run itself and its checkpoints live
 * in HazelJS's SQL durable run store, not here.
 *
 * Serves: FR-3, FR-32 (per-lead status and error), NFR-1, NFR-2, ADR-0001, ADR-0002; issue #15.
 * Used by: apps/api/src/pipeline/lead.graph.ts, apps/api/src/scheduler/lead-runner.ts,
 * apps/api/test/lead-run.int.spec.ts, apps/api/test/lead-graph.int.spec.ts,
 * apps/api/test/lead-runner.int.spec.ts.
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
   * Lists the campaigns whose leads are being enriched: the ones the reviews step looks at.
   * @returns `Campaign.id`s of ENRICHING campaigns, oldest first.
   * @throws Prisma errors when the database cannot be read.
   */
  async enrichingCampaigns(): Promise<string[]> {
    const campaigns = await this.prisma.campaign.findMany({
      where: { status: 'ENRICHING' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return campaigns.map((campaign) => campaign.id);
  }

  /**
   * Claims an ENRICHING campaign for its pass-2 reviews step, so a second worker never runs the
   * step (and its paid Apify start) at the same time.
   *
   * Uses the campaign runner's lease column: that runner only claims DISCOVERING campaigns, and
   * discover clears the lease when it moves the campaign to ENRICHING. One UPDATE that repeats the
   * condition, so of two workers only one gets the claim.
   * @param campaignId - `Campaign.id`.
   * @param now - The lease time; it is also the claim's proof of ownership.
   * @param leaseMs - How old a claim must be to count as abandoned, in milliseconds.
   * @returns The claim's time, or null when the campaign left ENRICHING (e.g. the founder paused
   * it) or another worker holds it.
   * @throws Prisma errors when the database cannot be written.
   */
  async claimReviews(campaignId: string, now: Date, leaseMs: number): Promise<Date | null> {
    const { count } = await this.prisma.campaign.updateMany({
      where: {
        id: campaignId,
        status: 'ENRICHING',
        OR: [
          { discoveryClaimedAt: null },
          { discoveryClaimedAt: { lt: new Date(now.getTime() - leaseMs) } },
        ],
      },
      data: { discoveryClaimedAt: now },
    });
    return count === 1 ? now : null;
  }

  /**
   * Ends a reviews claim; does nothing when another worker took the campaign over.
   * @param campaignId - `Campaign.id`.
   * @param claimedAt - The value {@link claimReviews} returned.
   * @throws Prisma errors when the database cannot be written.
   */
  async releaseReviews(campaignId: string, claimedAt: Date): Promise<void> {
    await this.prisma.campaign.updateMany({
      where: { id: campaignId, discoveryClaimedAt: claimedAt },
      data: { discoveryClaimedAt: null },
    });
  }

  /**
   * Moves every ENRICHING campaign with no lead left to run (none DISCOVERED or ENRICHED) to
   * SCORING. One UPDATE, so a lead added meanwhile keeps its campaign ENRICHING.
   *
   * Does not move it further: it stays SCORING until Cycle 2 adds scripting. FAILED leads do not
   * hold the campaign back (FR-32).
   * @returns The `Campaign.id`s that moved.
   * @throws Prisma errors when the database cannot be written.
   */
  async finishEnrichment(): Promise<string[]> {
    const moved = await this.prisma.campaign.updateManyAndReturn({
      where: { status: 'ENRICHING', leads: { none: { status: { in: [...RUNNABLE] } } } },
      data: { status: 'SCORING' },
      select: { id: true },
    });
    return moved.map((campaign) => campaign.id);
  }

  /**
   * Pauses an ENRICHING campaign with a reason for the dashboard (FR-3, FR-33); resuming returns it
   * to ENRICHING.
   *
   * Does nothing when the campaign has left ENRICHING (e.g. the founder paused it already).
   * @param campaignId - `Campaign.id`.
   * @param reason - A fixed sentence for the founder.
   * @throws Prisma errors when the database cannot be written.
   */
  async pauseEnrichment(campaignId: string, reason: string): Promise<void> {
    await this.prisma.campaign.updateMany({
      where: { id: campaignId, status: 'ENRICHING' },
      data: { status: 'PAUSED', pausedFrom: 'ENRICHING', pauseReason: reason },
    });
  }

  /**
   * Records the HazelJS run id of the lead's new graph run.
   * @param lead - The claimed lead.
   * @param runId - The `AgentRun` id the run will be stored under.
   * @returns False when the claim was lost (its lease ran out and another pass took the lead).
   * @throws Prisma errors when the database cannot be written.
   */
  async startRun(lead: Pick<ClaimedLead, 'id' | 'claimedAt'>, runId: string): Promise<boolean> {
    const { count } = await this.prisma.lead.updateMany({
      where: { id: lead.id, graphClaimedAt: lead.claimedAt },
      data: { graphRunId: runId },
    });
    return count === 1;
  }

  /**
   * Renews a claim before the next graph node, so a node never starts without holding the lead.
   * @param lead - The claimed lead, with the lease value this pass holds.
   * @param now - The new lease value.
   * @returns False when the claim was lost; the caller must stop before paying for anything.
   * @throws Prisma errors when the database cannot be written.
   */
  async renew(lead: Pick<ClaimedLead, 'id' | 'claimedAt'>, now: Date): Promise<boolean> {
    const { count } = await this.prisma.lead.updateMany({
      where: { id: lead.id, graphClaimedAt: lead.claimedAt },
      data: { graphClaimedAt: now },
    });
    return count === 1;
  }

  /**
   * Marks a lead ENRICHED once its website and web context are in.
   *
   * Does not move a lead that is not DISCOVERED: a repeat leaves ENRICHED as it is.
   * @param leadId - `Lead.id`.
   * @throws Prisma errors when the database cannot be written.
   */
  async markEnriched(leadId: string): Promise<void> {
    await this.prisma.lead.updateMany({
      where: { id: leadId, status: 'DISCOVERED' },
      data: { status: 'ENRICHED' },
    });
  }

  /**
   * Ends the claim after a run finished or stopped between nodes; the lead keeps the status its
   * steps gave it.
   *
   * Does nothing when the claim was lost: the other pass owns the lead now.
   * @param lead - The claimed lead.
   * @throws Prisma errors when the database cannot be written.
   */
  async release(lead: Pick<ClaimedLead, 'id' | 'claimedAt'>): Promise<void> {
    await this.prisma.lead.updateMany({
      where: { id: lead.id, graphClaimedAt: lead.claimedAt },
      data: { graphClaimedAt: null },
    });
  }

  /**
   * Marks a lead FAILED at a step with a stored error sentence, and ends the claim (FR-32).
   *
   * Does not mark a lead the score step already moved past enrichment and labelling: that one only
   * loses the claim. Does nothing when the claim was lost.
   * @param lead - The claimed lead.
   * @param step - The graph node that failed, e.g. "ENRICH_WEBSITE".
   * @param error - The sentence shown on the dashboard; never raw error text from a library.
   * @throws Prisma errors when the database cannot be written.
   */
  async fail(
    lead: Pick<ClaimedLead, 'id' | 'claimedAt'>,
    step: string,
    error: string,
  ): Promise<void> {
    const { count } = await this.prisma.lead.updateMany({
      where: { id: lead.id, graphClaimedAt: lead.claimedAt, status: { in: [...RUNNABLE] } },
      data: { status: 'FAILED', failedStep: step, error, graphClaimedAt: null },
    });
    if (count === 0) await this.release(lead);
  }
}
