/**
 * The lead-runner loop: every 10 s, one pass. First the pass-2 reviews step for each ENRICHING
 * campaign (it pays for a campaign's reviews once), then up to LEAD_RUNNER_CONCURRENCY claimed
 * leads through their lead graph, then every campaign with no lead left to run moves from
 * ENRICHING to SCORING.
 *
 * One worker process runs this loop; a pass ends before the next one starts. A lead's failure never
 * stops the pass or its campaign (FR-32).
 *
 * Serves: FR-11 (reviews), FR-32, FR-33, NFR-1, NFR-2, docs/architecture.md §9, ADR-0002,
 * ADR-0015; issue #15.
 * Used by: apps/api/src/worker.ts, apps/api/test/lead-runner.int.spec.ts.
 */
import type { HazelApp } from '@hazeljs/core';
import type { LeadRunRepository } from '../db/lead-run.repository.js';
import { errorFields, type Logger } from '../logging/logger.js';
import {
  enrichReviewsForCampaign,
  type EnrichReviewsDeps,
} from '../pipeline/enrich-reviews.step.js';
import { runLeadGraph, type LeadGraphDeps } from '../pipeline/lead.graph.js';

const RUNNER_INTERVAL_MS = 10_000;
/**
 * How long a claim on a lead lasts. Each graph node renews it, so it must outlast one node: a
 * website read through Lightpanda, one web search or one LLM call, each bounded by its adapter's
 * own timeouts.
 */
export const LEAD_LEASE_MS = 15 * 60 * 1000;

// Shown on the dashboard while the campaign is paused. Resuming without checking pauses it again:
// the reviews step refuses to start a second run while one may exist (#12).
const REVIEWS_CHECK_REASON =
  'A paid Apify reviews run may exist but its id was not saved. Check the Apify console before resuming.';

/** What a pass needs. */
export interface LeadRunnerDeps {
  leads: Pick<
    LeadRunRepository,
    'enrichingCampaigns' | 'claimNext' | 'finishEnrichment' | 'pauseEnrichment'
  >;
  reviews: EnrichReviewsDeps;
  graph: LeadGraphDeps;
  logger: Logger;
  now: () => Date;
  /** The most leads one pass runs at once (`LEAD_RUNNER_CONCURRENCY`). */
  concurrency: number;
}

/** What one pass did, for the log and the tests. */
export interface LeadRunnerPass {
  /** Leads claimed and run this pass. */
  leads: number;
  /** Campaigns moved from ENRICHING to SCORING. */
  finished: string[];
}

/**
 * Runs the pass-2 reviews step for each ENRICHING campaign.
 *
 * The step itself pays once: it acts only for leads with no reviews yet and saves its run before
 * reading it. A failure for one campaign is logged and the others go on.
 * @param deps - What the pass needs.
 */
const collectReviews = async (deps: LeadRunnerDeps): Promise<void> => {
  for (const campaignId of await deps.leads.enrichingCampaigns()) {
    try {
      const result = await enrichReviewsForCampaign(deps.reviews, campaignId);
      if (result.needsCheck) {
        await deps.leads.pauseEnrichment(campaignId, REVIEWS_CHECK_REASON);
        deps.logger.warn({ campaignId }, 'reviews run needs a check: campaign paused');
      }
    } catch (error) {
      // A run that cannot be read yet is read again next pass, for free.
      deps.logger.error({ campaignId, ...errorFields(error) }, 'reviews step failed');
    }
  }
};

/**
 * Runs one pass: reviews, then a batch of lead graphs, then campaign completion.
 *
 * Does not wait for leads it could not claim, and does not run a lead whose reviews are not
 * settled (the claim leaves those out).
 * @param deps - What the pass needs.
 * @returns How many leads ran and which campaigns moved to SCORING.
 * @throws Prisma errors from the claim or the campaign update; {@link startLeadRunner} logs them
 * and the next pass carries on.
 */
export async function runLeadRunnerOnce(deps: LeadRunnerDeps): Promise<LeadRunnerPass> {
  await collectReviews(deps);
  const claimed = await deps.leads.claimNext(deps.now(), LEAD_LEASE_MS, deps.concurrency);
  const outcomes = await Promise.allSettled(claimed.map((lead) => runLeadGraph(deps.graph, lead)));
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') return;
    // The graph records node errors on the lead; this is a write around it. The claim expires and
    // a later pass resumes the lead.
    const leadId = claimed[index]?.id;
    deps.logger.error({ leadId, ...errorFields(outcome.reason) }, 'lead graph run not recorded');
  });
  const finished = await deps.leads.finishEnrichment();
  for (const campaignId of finished) deps.logger.info({ campaignId }, 'campaign moved to SCORING');
  return { leads: claimed.length, finished };
}

/**
 * Starts the loop.
 *
 * Waits for a pass to end before timing the next, so one process never overlaps itself.
 * Does not stop on an error: one bad pass must not end the worker.
 * @param deps - What a pass needs.
 * @param intervalMs - Pause between passes, in milliseconds.
 * @returns A function that stops the loop. A pass in flight is left to finish or to be cut off by
 * the process exit; its leads' claims expire and a later pass resumes them.
 */
export function startLeadRunner(deps: LeadRunnerDeps, intervalMs = RUNNER_INTERVAL_MS): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      await runLeadRunnerOnce(deps);
    } catch (error) {
      deps.logger.error(errorFields(error), 'lead runner pass failed');
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * Adds the shutdown handler that stops the lead runner.
 *
 * Call it before `registerPrismaShutdown`: handlers run in order.
 * @param app - The worker's app.
 * @param stop - From {@link startLeadRunner}.
 */
export function registerLeadRunnerShutdown(
  app: Pick<HazelApp, 'registerShutdownHandler'>,
  stop: () => void,
): void {
  app.registerShutdownHandler({
    name: 'lead-runner',
    handler: () => {
      stop();
      return Promise.resolve();
    },
    timeout: 1000,
  });
}
