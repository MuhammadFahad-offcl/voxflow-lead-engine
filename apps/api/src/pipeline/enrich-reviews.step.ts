/**
 * The pass-2 reviews enrichment step: fetches Google reviews via Scraperlink for eligible leads.
 *
 * Serves: FR-11 (store up to 30 most recent Google reviews per business), FR-33, NFR-4, ADR-0015.
 * Used by: apps/api/test/enrich-reviews.int.spec.ts. The enrich step calls it in PR 2b of #12.
 */
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaProvider } from '../db/prisma.provider.js';
import { NO_REVIEWS_ERROR, type ReviewRepository } from '../db/review.repository.js';
import { errorFields, type Logger } from '../logging/logger.js';
import type { CollectedReviewsRun, LeadSourcePort } from '../ports/lead-source.port.js';
import { capPauseReason, karachiDayStart } from './spend-cap.js';

/** Dependencies for pass-2 reviews enrichment. */
export interface EnrichReviewsDeps {
  prisma: PrismaProvider;
  reviewRepo: ReviewRepository;
  leadSource: LeadSourcePort;
  logger: Logger;
  /** Clock source, defaults to `new Date()`. */
  now?: () => Date;
}

/** Result of running reviews enrichment for a campaign. */
export interface EnrichReviewsResult {
  placeCount: number;
  storedReviewsCount: number;
  skippedDueToCap: boolean;
  /** True when a paid run may exist that nobody can read: nothing new was started. */
  needsCheck: boolean;
  /** Why the paid run went badly, for the caller to show; null when it did not. */
  problem: string | null;
}

// Fixed texts, because the error behind a failed start may echo values from the request.
const CHECK_ERROR =
  'A paid Apify reviews run may exist but its id was not saved; check the Apify console. Nothing new starts until that record is abandoned.';
// Retryable: the next call tries again once the day's cap has room.
const CAP_ERROR = 'Apify daily spend cap reached; reviews wait until the cap has room';

// Marks the leads so the worker and dashboard know their reviews were deferred, and why.
const deferLeads = async (
  prisma: PrismaProvider,
  leads: readonly { id: string }[],
  error: string,
): Promise<void> => {
  await prisma.lead.updateMany({
    where: { id: { in: leads.map((lead) => lead.id) } },
    data: { failedStep: 'ENRICH_REVIEWS', error },
  });
};

const NOTHING_RUN = { placeCount: 0, storedReviewsCount: 0, needsCheck: false, problem: null };

// Reads a saved run for free; the log line names the campaign, which the adapter's error cannot.
const collectRun = async (
  deps: EnrichReviewsDeps,
  campaignId: string,
  runId: string,
): Promise<CollectedReviewsRun> => {
  try {
    return await deps.leadSource.collectReviews(runId);
  } catch (error) {
    deps.logger.error({ campaignId, runId, ...errorFields(error) }, 'Apify reviews read failed');
    throw error;
  }
};

// Collects an unfinished run once no lead needs reviews: a crash after the saves left it open, and
// a later call with new leads would otherwise read this old run in their place. Free to read.
// Does not throw when the read fails: the leads have nothing to wait for.
const closeOpenRun = async (deps: EnrichReviewsDeps, campaignId: string): Promise<void> => {
  const open = await deps.reviewRepo.openRun(campaignId);
  const runId = open?.runId ?? null;
  if (open === null || runId === null) return;
  let collected: CollectedReviewsRun;
  try {
    collected = await deps.leadSource.collectReviews(runId);
  } catch (error) {
    // Still running or unreadable: the record stays open, and a later call reads it again.
    deps.logger.error({ campaignId, runId, ...errorFields(error) }, 'open reviews run not read');
    return;
  }
  await deps.reviewRepo.finishRun(open.recordId, collected.items.length, collected.costUsd);
};

// Clears the deferral of leads that got reviews, and ends the retries of the ones that did not:
// their paid run is done, so only the founder may pay for it again.
const settleLeads = async (
  prisma: PrismaProvider,
  missed: readonly { id: string }[],
  withReviews: ReadonlySet<string>,
): Promise<void> => {
  const ids = [...withReviews];
  await prisma.lead.updateMany({
    where: { id: { in: ids }, failedStep: 'ENRICH_REVIEWS' },
    data: { failedStep: null, error: null },
  });
  const without = missed.filter((lead) => !withReviews.has(lead.id));
  await deferLeads(prisma, without, NO_REVIEWS_ERROR);
};

// Says what went wrong with a paid run, or null when it brought reviews home.
const reviewsRunProblem = (
  run: Pick<CollectedReviewsRun, 'status'>,
  storedReviewsCount: number,
  placeCount: number,
): string | null => {
  const rule = 'A paid run is not repeated: the leads without reviews wait for the founder.';
  if (run.status !== 'SUCCEEDED') {
    return `The Apify reviews run for ${String(placeCount)} places ended as ${run.status}. ${rule}`;
  }
  return storedReviewsCount > 0 ? null : `The Apify reviews run returned no reviews. ${rule}`;
};

// Returns the saved run id of an unfinished run, or null (leads deferred) when it has none.
const resumeRun = async (
  deps: EnrichReviewsDeps,
  campaignId: string,
  leads: readonly { id: string }[],
  existing: { recordId: string; runId: string | null },
): Promise<string | null> => {
  if (existing.runId !== null) return existing.runId;
  const { recordId } = existing;
  deps.logger.warn({ campaignId, recordId }, 'reviews run may exist with no saved id: not started');
  await deferLeads(deps.prisma, leads, CHECK_ERROR);
  return null;
};

// Starts the paid run and saves its id, or returns null with the leads deferred for the check.
const startRun = async (
  deps: EnrichReviewsDeps,
  campaignId: string,
  inRun: readonly { id: string; placeId: string }[],
  reserved: { recordId: string; amountUsd: Prisma.Decimal },
): Promise<string | null> => {
  const { prisma, reviewRepo, leadSource, logger } = deps;
  const { recordId } = reserved;
  let runId: string;
  try {
    runId = await leadSource.startReviews(
      inRun.map((lead) => lead.placeId),
      reserved.amountUsd,
    );
  } catch (error) {
    logger.error({ campaignId, recordId, ...errorFields(error) }, 'Apify reviews start failed');
    await deferLeads(prisma, inRun, CHECK_ERROR);
    return null;
  }
  try {
    await reviewRepo.saveRunId(recordId, runId);
  } catch (error) {
    logger.error({ campaignId, runId, ...errorFields(error) }, 'reviews run id not saved');
    await deferLeads(prisma, inRun, CHECK_ERROR);
    return null;
  }
  return runId;
};

// Saves each item's reviews on the lead of its place; returns the leads that got any.
const storeItems = async (
  reviewRepo: ReviewRepository,
  inRun: readonly { id: string; placeId: string }[],
  items: CollectedReviewsRun['items'],
): Promise<{ withReviews: Set<string>; storedReviewsCount: number }> => {
  const leadIdByPlace = new Map(inRun.map((lead) => [lead.placeId, lead.id]));
  const withReviews = new Set<string>();
  let storedReviewsCount = 0;
  for (const item of items) {
    const leadId = leadIdByPlace.get(item.placeId);
    const saved = leadId === undefined ? 0 : await reviewRepo.saveReviews(leadId, item.reviews);
    if (leadId !== undefined && saved > 0) withReviews.add(leadId);
    storedReviewsCount += saved;
  }
  return { withReviews, storedReviewsCount };
};

/**
 * Runs pass-2 reviews collection for all eligible leads in a campaign, as one paid Apify run.
 *
 * Eligible leads passed the ideal-client filter and have no reviews stored yet. The money follows
 * #10: the run's charge limit is reserved as the `CostRecord(APIFY)` in one transaction under the
 * organization's advisory lock, which also reads the daily cap (Asia/Karachi day) and any
 * unfinished run of this campaign, before the run starts. The run id is saved on that record after
 * the start, and the true charge replaces the limit after the collect: one record per run.
 * The run covers as many leads as the room under the cap allows; the rest wait for the next call
 * with a retryable marker. One run, one reservation: a reservation per batch is PR 2b of #12.
 * Does not retry a start: a failed request may have created a paid run. A record with no run id is
 * the trace of that; the step starts nothing new over it and defers the leads until the founder has
 * checked the Apify console and abandoned the record (`DiscoveryRepository.abandonSearch`).
 * Does not pay again for a run that ended badly: a run that is not SUCCEEDED, or that left some of
 * its leads without reviews, is not repeated, resumed or not. Those leads are marked
 * `NO_REVIEWS_ERROR`, which `leadsNeedingReviews` skips, and `problem` says why. Cap deferrals and
 * the unchecked-run marker stay retryable. That holds for a run resumed from its saved id too: its
 * note names the places it covers, so only those leads are marked, and a lead added since is left
 * for the next call. The misses are marked before the record is closed, so a failure between the
 * two leaves the run open and the next call finishes it for free, never as a second paid run.
 * Does not give the founder a way out of `needsCheck` yet: abandoning the record is PR 2b of #12
 * (`ReviewRepository.abandonRun` and the route that calls it); until then it is
 * `DiscoveryRepository.abandonSearch` by hand.
 * Does not pause the campaign: this step has no claim, so the caller decides what a deferral means.
 * Does not retry a read that fails: its run id is saved, so the next call collects it for free.
 * Does not lower a reserved amount when the run does not say what it charged.
 * @param deps - Injected dependencies.
 * @param campaignId - `Campaign.id`.
 * @returns Summary of reviews stored, whether the cap or an unchecked run held it back, and why a
 * paid run went badly.
 * @throws Prisma errors; ZodError when the organization's `spendCaps` are invalid; the read's error
 * when the run cannot be collected.
 */
export async function enrichReviewsForCampaign(
  deps: EnrichReviewsDeps,
  campaignId: string,
): Promise<EnrichReviewsResult> {
  const { prisma, reviewRepo, leadSource, logger } = deps;
  const now = deps.now ? deps.now() : new Date();
  const { organizationId } = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { organizationId: true },
  });

  const leads = await reviewRepo.leadsNeedingReviews(campaignId);
  if (leads.length === 0) {
    await closeOpenRun(deps, campaignId);
    logger.info({ campaignId }, 'no leads needing pass-2 reviews');
    return { ...NOTHING_RUN, skippedDueToCap: false };
  }

  const reservation = await reviewRepo.reserveRun({
    organizationId,
    campaignId,
    placeIds: leads.map((lead) => lead.placeId),
    limitFor: (places) => leadSource.chargeLimitReviewsUsd(places),
    dayStart: karachiDayStart(now),
    at: now,
  });
  if (reservation.outcome === 'OVER_CAP') {
    const reason = capPauseReason(
      reservation.spent,
      leadSource.chargeLimitReviewsUsd(1),
      reservation.capUsd,
    );
    logger.warn({ campaignId, reason }, 'Apify daily cap reached: reviews deferred');
    await deferLeads(prisma, leads, CAP_ERROR);
    return { ...NOTHING_RUN, skippedDueToCap: true };
  }

  // A reservation can cover fewer places than asked: the rest wait for room under the cap.
  const resumed = reservation.outcome === 'EXISTING';
  // A resumed run covers the places in its note; leads added since are not part of it.
  const inRun = resumed
    ? leads.filter((lead) => reservation.placeIds.includes(lead.placeId))
    : leads.slice(0, reservation.placeCount);
  const deferred = resumed ? [] : leads.slice(inRun.length);
  if (deferred.length > 0) {
    logger.warn({ campaignId, deferred: deferred.length }, 'Apify daily cap: part deferred');
    await deferLeads(prisma, deferred, CAP_ERROR);
  }
  const held = (needsCheck: boolean): EnrichReviewsResult => ({
    placeCount: inRun.length,
    storedReviewsCount: 0,
    skippedDueToCap: deferred.length > 0,
    needsCheck,
    problem: null,
  });

  const { recordId } = reservation;
  const runId =
    reservation.outcome === 'EXISTING'
      ? await resumeRun(deps, campaignId, inRun, reservation)
      : await startRun(deps, campaignId, inRun, reservation);
  if (runId === null) return held(true);

  const collected = await collectRun(deps, campaignId, runId);
  const { withReviews, storedReviewsCount } = await storeItems(reviewRepo, inRun, collected.items);
  // Before the record closes: a failure in between leaves it open, and the next call settles for
  // free. The other way round, the misses would be bought again.
  await settleLeads(prisma, inRun, withReviews);
  await reviewRepo.finishRun(recordId, collected.items.length, collected.costUsd);

  const runPlaces = resumed ? reservation.placeIds.length : inRun.length;
  // A resumed run with none of its leads left has nothing to judge.
  const problem =
    inRun.length === 0 ? null : reviewsRunProblem(collected, storedReviewsCount, runPlaces);
  logger.info(
    { campaignId, runId, status: collected.status, placeCount: inRun.length, storedReviewsCount },
    'pass-2 reviews stored',
  );
  return {
    placeCount: inRun.length,
    storedReviewsCount,
    skippedDueToCap: deferred.length > 0,
    needsCheck: false,
    problem,
  };
}
