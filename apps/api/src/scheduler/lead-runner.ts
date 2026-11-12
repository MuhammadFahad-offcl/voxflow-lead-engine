/**
 * The lead-runner loop: every 10 s, one pass. First the pass-2 reviews step for each ENRICHING
 * campaign (it pays once per lead for its reviews), then up to LEAD_RUNNER_CONCURRENCY claimed
 * leads through their lead graph, then every campaign with no lead left to run moves from
 * ENRICHING to SCORING.
 *
 * One worker process runs this loop; a pass ends before the next one starts. A lead's failure never
 * stops the pass or its campaign (FR-32). After a spend cap pauses a lead, the runner claims no new
 * lead for one lease, so it does not walk every lead into a cap it already knows about (FR-33).
 *
 * Serves: FR-11 (reviews), FR-32, FR-33, NFR-1, NFR-2, docs/architecture.md §9, ADR-0002,
 * ADR-0015; issue #15.
 * Used by: apps/api/src/worker.ts, apps/api/test/lead-runner.int.spec.ts.
 */
import type { HazelApp } from '@hazeljs/core';
import { DiscoveryRepository } from '../db/discovery.repository.js';
import { LeadContextRepository } from '../db/lead-context.repository.js';
import { LeadRunRepository } from '../db/lead-run.repository.js';
import { LeadWebsiteRepository } from '../db/lead-website.repository.js';
import { LlmSpendRepository } from '../db/llm-spend.repository.js';
import type { PrismaProvider } from '../db/prisma.provider.js';
import { ReviewLabelRepository } from '../db/review-label.repository.js';
import { ReviewRepository } from '../db/review.repository.js';
import { ScoreRepository } from '../db/score.repository.js';
import { LlmService } from '../llm/llm.service.js';
import { errorFields, type Logger } from '../logging/logger.js';
import {
  enrichReviewsForCampaign,
  type EnrichReviewsDeps,
} from '../pipeline/enrich-reviews.step.js';
import {
  createLeadGraphRuntime,
  runLeadGraph,
  type LeadGraphDeps,
} from '../pipeline/lead.graph.js';
import type { PaidStartGate } from '../pipeline/paid-start-gate.js';
import type { LeadSourcePort } from '../ports/lead-source.port.js';
import type { LlmPort } from '../ports/llm.port.js';
import type { WebContextPort } from '../ports/web-context.port.js';
import type { WebReaderPort } from '../ports/web-reader.port.js';

const RUNNER_INTERVAL_MS = 10_000;
/**
 * How long a claim on a lead lasts. Each graph node renews it, so it must outlast one node: a
 * website read through Lightpanda, one web search or one LLM call, each bounded by its adapter's
 * own timeouts.
 */
export const LEAD_LEASE_MS = 15 * 60 * 1000;
// Fits HazelJS's 30-second shutdown limit; a reviews start usually saves its run id well inside it.
const START_SAVE_WAIT_MS = 10_000;

// Shown on the dashboard while the campaign is paused. Resuming starts a new reviews run: the old
// reservation is abandoned, and stays on that day's total because a run may exist (as in discover).
const REVIEWS_CHECK_REASON =
  'A paid Apify reviews run may have started, but its id was not saved. Check the Apify console; resuming starts a new reviews run.';

/** What a pass needs. */
export interface LeadRunnerDeps {
  leads: Pick<
    LeadRunRepository,
    'enrichingCampaigns' | 'isEnriching' | 'claimNext' | 'finishEnrichment' | 'pauseEnrichment'
  >;
  reviews: EnrichReviewsDeps & { reviewRepo: Pick<ReviewRepository, 'openRun' | 'abandonRun'> };
  /** Held while a reviews step may start a paid run, so a shutdown waits for its id to be saved. */
  startGate: PaidStartGate;
  graph: LeadGraphDeps;
  logger: Logger;
  now: () => Date;
  /** The most leads one pass runs at once (`LEAD_RUNNER_CONCURRENCY`). */
  concurrency: number;
}

/** What the loop remembers between passes. */
export interface LeadRunnerState {
  /** No new lead is claimed before this time: a spend cap paused a lead (FR-33). */
  claimsHeldUntil: Date | null;
}

/** What one pass did, for the log and the tests. */
export interface LeadRunnerPass {
  /** Leads claimed and run this pass. */
  leads: number;
  /** Leads whose run a spend cap paused. */
  paused: number;
  /** Campaigns moved from ENRICHING to SCORING. */
  finished: string[];
}

/** The outside services and settings a lead runner is built from. */
export interface LeadRunnerParts {
  prisma: PrismaProvider;
  leadSource: LeadSourcePort;
  webReader: WebReaderPort;
  webContext: WebContextPort;
  llm: LlmPort;
  logger: Logger;
  now: () => Date;
  concurrency: number;
  startGate: PaidStartGate;
}

/**
 * Builds a lead runner's dependencies: the repositories, the LLM gate and the lead graph's
 * HazelJS runtime and SQL durable run store. The worker passes the bound adapters; the tests pass
 * fakes, so both run this same wiring.
 * @param parts - The database client, the ports and the settings.
 * @returns The dependencies of {@link runLeadRunnerOnce} and {@link startLeadRunner}.
 */
export function buildLeadRunnerDeps(parts: LeadRunnerParts): LeadRunnerDeps {
  const { prisma, logger, now } = parts;
  const { runtime, store } = createLeadGraphRuntime(prisma);
  const leads = new LeadRunRepository(prisma);
  return {
    leads,
    reviews: {
      prisma,
      reviewRepo: new ReviewRepository(prisma, new DiscoveryRepository(prisma)),
      leadSource: parts.leadSource,
      logger,
      now,
    },
    startGate: parts.startGate,
    graph: {
      runtime,
      store,
      runs: leads,
      website: { leads: new LeadWebsiteRepository(prisma), webReader: parts.webReader, logger },
      context: {
        leads: new LeadContextRepository(prisma),
        webContext: parts.webContext,
        logger,
        now,
      },
      label: {
        reviews: new ReviewLabelRepository(prisma),
        llm: new LlmService(new LlmSpendRepository(prisma), parts.llm, logger),
        logger,
      },
      score: { leads: new ScoreRepository(prisma), logger },
      logger,
      now,
    },
    logger,
    now,
    concurrency: parts.concurrency,
  };
}

/**
 * Pauses a campaign whose reviews run may exist without a saved id, then abandons that run's
 * reservation, so the founder's resume (after checking the Apify console) starts a new run.
 *
 * In this order: a crash in between leaves a paused campaign and an open record, which pauses it
 * again after the resume, never a new paid run without the founder.
 * @param deps - What the pass needs.
 * @param campaignId - `Campaign.id`.
 */
const pauseForCheck = async (deps: LeadRunnerDeps, campaignId: string): Promise<void> => {
  await deps.leads.pauseEnrichment(campaignId, REVIEWS_CHECK_REASON);
  const open = await deps.reviews.reviewRepo.openRun(campaignId);
  if (open !== null && open.runId === null) await deps.reviews.reviewRepo.abandonRun(open.recordId);
  deps.logger.warn({ campaignId }, 'reviews run needs a check: campaign paused');
};

/**
 * Runs the pass-2 reviews step for each ENRICHING campaign, inside the paid-start gate.
 *
 * The step itself pays once per lead: it acts only for leads with no reviews yet and saves its run
 * before reading it. Each campaign's status is read again just before its step, so one the founder
 * paused during a long step for another campaign is not paid for. A failure for one campaign is
 * logged and the others go on.
 * @param deps - What the pass needs.
 * @throws Prisma errors when the list of campaigns cannot be read.
 */
const collectReviews = async (deps: LeadRunnerDeps): Promise<void> => {
  for (const campaignId of await deps.leads.enrichingCampaigns()) {
    try {
      if (!(await deps.leads.isEnriching(campaignId))) continue;
      const result = await deps.startGate.run(() =>
        enrichReviewsForCampaign(deps.reviews, campaignId),
      );
      if (result === 'CLOSED') return;
      // The step hands this sentence to its caller: a run that ended badly or found no reviews.
      if (result.problem !== null) {
        deps.logger.warn({ campaignId, problem: result.problem }, 'reviews run problem');
      }
      if (result.needsCheck) await pauseForCheck(deps, campaignId);
    } catch (error) {
      // A run that cannot be read yet is read again next pass, for free.
      deps.logger.error({ campaignId, ...errorFields(error) }, 'reviews step failed');
    }
  }
};

/**
 * Runs one pass: reviews, then a batch of lead graphs (unless a spend cap holds new claims), then
 * campaign completion.
 *
 * Does not run a lead whose reviews are not settled (the claim leaves those out).
 * @param deps - What the pass needs.
 * @param state - What the loop remembers; this pass may set `claimsHeldUntil`.
 * @returns How many leads ran and paused, and which campaigns moved to SCORING.
 * @throws Prisma errors from reading the campaigns, the claim or the campaign update; Error from
 * the claim for a lead it cannot run (a bug). {@link startLeadRunner} logs them and the next pass
 * carries on.
 */
export async function runLeadRunnerOnce(
  deps: LeadRunnerDeps,
  state: LeadRunnerState = { claimsHeldUntil: null },
): Promise<LeadRunnerPass> {
  await collectReviews(deps);
  const now = deps.now();
  const held = state.claimsHeldUntil !== null && now < state.claimsHeldUntil;
  const claimed = held ? [] : await deps.leads.claimNext(now, LEAD_LEASE_MS, deps.concurrency);
  const outcomes = await Promise.allSettled(claimed.map((lead) => runLeadGraph(deps.graph, lead)));
  let paused = 0;
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      if (outcome.value.status === 'PAUSED') paused += 1;
      return;
    }
    // The graph records node errors on the lead; this is a write around it. The claim expires and
    // a later pass resumes the lead.
    const leadId = claimed[index]?.id;
    deps.logger.error({ leadId, ...errorFields(outcome.reason) }, 'lead graph run not recorded');
  });
  if (paused > 0) {
    state.claimsHeldUntil = new Date(now.getTime() + LEAD_LEASE_MS);
    deps.logger.warn({ paused }, 'spend cap reached: no new leads claimed for one lease');
  }
  const finished = await deps.leads.finishEnrichment();
  for (const campaignId of finished) deps.logger.info({ campaignId }, 'campaign moved to SCORING');
  return { leads: claimed.length, paused, finished };
}

/**
 * Starts the loop.
 *
 * Waits for a pass to end before timing the next, so one process never overlaps itself.
 * Does not stop on an error: one bad pass must not end the worker.
 * @param deps - What a pass needs.
 * @param intervalMs - Pause between passes, in milliseconds.
 * @returns A function that stops the loop and refuses a new reviews step, then waits up to the
 * given milliseconds for one in progress, so its paid start saves its run id; it resolves false
 * when that wait ran out. Lead graphs in flight are not waited for: their claims expire and a
 * later pass resumes them.
 */
export function startLeadRunner(
  deps: LeadRunnerDeps,
  intervalMs = RUNNER_INTERVAL_MS,
): (waitMs: number) => Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const state: LeadRunnerState = { claimsHeldUntil: null };
  const tick = async (): Promise<void> => {
    try {
      await runLeadRunnerOnce(deps, state);
    } catch (error) {
      deps.logger.error(errorFields(error), 'lead runner pass failed');
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), 0);
  return (waitMs) => {
    stopped = true;
    clearTimeout(timer);
    return deps.startGate.close(waitMs);
  };
}

/**
 * Adds the shutdown handler that stops the lead runner.
 *
 * Call it before `registerPrismaShutdown`: handlers run in order, and a reviews start in progress
 * needs the database to save its run id.
 * @param app - The worker's app.
 * @param stop - From {@link startLeadRunner}.
 * @param logger - Told when a reviews start outlasted the wait.
 */
export function registerLeadRunnerShutdown(
  app: Pick<HazelApp, 'registerShutdownHandler'>,
  stop: (waitMs: number) => Promise<boolean>,
  logger: Pick<Logger, 'warn'>,
): void {
  app.registerShutdownHandler({
    name: 'lead-runner',
    handler: async () => {
      if (await stop(START_SAVE_WAIT_MS)) return;
      logger.warn('a reviews step outlasted the shutdown wait; its campaign may pause for a check');
    },
    timeout: START_SAVE_WAIT_MS + 1000,
  });
}
