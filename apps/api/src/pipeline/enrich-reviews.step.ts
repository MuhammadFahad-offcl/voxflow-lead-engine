/**
 * The pass-2 reviews enrichment step: fetches Google reviews via Scraperlink for eligible leads.
 *
 * Serves: FR-11 (store up to 30 most recent Google reviews per business), FR-33, NFR-4, ADR-0015.
 * Used by: apps/api/test/enrich-reviews.int.spec.ts. The enrich step calls it in PR 2b of #12.
 */
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaProvider } from '../db/prisma.provider.js';
import type { ReviewRepository } from '../db/review.repository.js';
import { errorFields, type Logger } from '../logging/logger.js';
import type { LeadSourcePort } from '../ports/lead-source.port.js';
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
 * Does not pause the campaign: this step has no claim, so the caller decides what a deferral means.
 * Does not retry a read that fails: its run id is saved, so the next call collects it for free.
 * Does not lower a reserved amount when the run does not say what it charged.
 * @param deps - Injected dependencies.
 * @param campaignId - `Campaign.id`.
 * @returns Summary of reviews stored, and whether the cap or an unchecked run held it back.
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
    logger.info({ campaignId }, 'no leads needing pass-2 reviews');
    return { placeCount: 0, storedReviewsCount: 0, skippedDueToCap: false, needsCheck: false };
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
    return { placeCount: 0, storedReviewsCount: 0, skippedDueToCap: true, needsCheck: false };
  }

  // A reservation can cover fewer places than asked: the rest wait for room under the cap.
  const inRun = reservation.outcome === 'RESERVED' ? leads.slice(0, reservation.placeCount) : leads;
  const deferred = leads.slice(inRun.length);
  if (deferred.length > 0) {
    logger.warn({ campaignId, deferred: deferred.length }, 'Apify daily cap: part deferred');
    await deferLeads(prisma, deferred, CAP_ERROR);
  }
  const held = (needsCheck: boolean): EnrichReviewsResult => ({
    placeCount: inRun.length,
    storedReviewsCount: 0,
    skippedDueToCap: deferred.length > 0,
    needsCheck,
  });

  const { recordId } = reservation;
  const runId =
    reservation.outcome === 'EXISTING'
      ? await resumeRun(deps, campaignId, leads, reservation)
      : await startRun(deps, campaignId, inRun, reservation);
  if (runId === null) return held(true);

  const collected = await leadSource.collectReviews(runId);
  const leadIdByPlace = new Map(inRun.map((lead) => [lead.placeId, lead.id]));
  let storedReviewsCount = 0;
  for (const item of collected.items) {
    const leadId = leadIdByPlace.get(item.placeId);
    if (leadId !== undefined) {
      storedReviewsCount += await reviewRepo.saveReviews(leadId, item.reviews);
    }
  }
  await reviewRepo.finishRun(recordId, collected.items.length, collected.costUsd);

  logger.info(
    { campaignId, runId, status: collected.status, placeCount: inRun.length, storedReviewsCount },
    'pass-2 reviews stored',
  );
  return {
    placeCount: inRun.length,
    storedReviewsCount,
    skippedDueToCap: deferred.length > 0,
    needsCheck: false,
  };
}
