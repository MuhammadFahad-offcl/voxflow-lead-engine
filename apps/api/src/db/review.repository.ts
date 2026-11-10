/**
 * Database access for pass-2 reviews: the leads that need them, their storage, and the run's money.
 *
 * Serves: FR-11 (store up to 30 most recent Google reviews per business), FR-33, ADR-0015.
 * Used by: apps/api/src/app.module.ts, apps/api/src/pipeline/enrich-reviews.step.ts,
 * apps/api/test/enrich-reviews.int.spec.ts.
 */
import { Injectable } from '@hazeljs/core';
import { SpendCaps } from '@voxflow/shared';
import { Prisma } from '../generated/prisma/client.js';
import { mapReviewsToRows, type RawReviewInput } from '../pipeline/review-mapper.js';
import { readReviewsRunNote, reviewsRunNote } from '../pipeline/reviews-run-note.js';
import { spendLockName, wouldPassCap } from '../pipeline/spend-cap.js';
import { DiscoveryRepository, type Reservation } from './discovery.repository.js';
import { PrismaProvider } from './prisma.provider.js';

// An unfinished run is one whose record has no `units` and was not abandoned.
/** An unfinished reviews run: its record, its run id (null when unknown) and the places it covers. */
interface OpenRun {
  recordId: string;
  runId: string | null;
  placeIds: string[];
}

const findOpenRun = async (
  client: Pick<Prisma.TransactionClient, 'costRecord'>,
  campaignId: string,
): Promise<OpenRun | null> => {
  const unfinished = await client.costRecord.findMany({
    where: { campaignId, service: 'APIFY', units: null, note: { contains: 'pass2-reviews' } },
    select: { id: true, note: true },
  });
  for (const { id, note } of unfinished) {
    const run = readReviewsRunNote(note);
    if (run?.state === 'OPEN') return { recordId: id, runId: run.runId, placeIds: run.placeIds };
  }
  return null;
};

/** What {@link ReviewRepository.reserveRun} decided. */
export type ReviewsReservation =
  | Exclude<Reservation, { outcome: 'CLAIM_LOST' | 'RESERVED' }>
  | { outcome: 'RESERVED'; recordId: string; placeCount: number; amountUsd: Prisma.Decimal }
  // A run of this campaign that is not finished: `runId` is null when it may or may not exist.
  | ({ outcome: 'EXISTING' } & OpenRun);

/**
 * The `Lead.error` of a lead whose paid reviews run came back without its reviews. A terminal
 * marker: {@link ReviewRepository.leadsNeedingReviews} skips it, so the run is not paid for again
 * until the founder clears it. Cap deferrals use other texts and stay retryable.
 */
export const NO_REVIEWS_ERROR = 'Paid Apify reviews run returned no reviews for this business';

/** Repository handling Review records for leads. */
@Injectable()
export class ReviewRepository {
  /**
   * Wires the repository to the process's database client.
   * @param prisma - The process's Prisma client.
   * @param discovery - Pass 1's repository, for the day's Apify spend and the run id write.
   */
  constructor(
    private readonly prisma: PrismaProvider,
    private readonly discovery: DiscoveryRepository,
  ) {}

  /**
   * Finds this campaign's unfinished reviews run, or reserves the charge limit of a new one.
   *
   * One transaction under the same advisory lock as a pass-1 reservation, so runners of one
   * organization take turns and each sees the others' reservations. The unfinished run is looked up
   * under it too, so two passes over one campaign cannot both pay. The cap is read under it, so a
   * lowered cap holds from the next reservation. The amount is the limit until the true charge is
   * known, so a crashed run still counts.
   * Reserves for as many places as fit the room left under the cap, which can be fewer than asked.
   * Does not start the run, and the lock ends with this call: the caller makes its Apify request
   * after this returns, never inside the transaction.
   * @param reservation - What to reserve and the limits to reserve it under.
   * @param reservation.organizationId - Owner of the spend.
   * @param reservation.campaignId - `Campaign.id`.
   * @param reservation.placeIds - The places the caller would like to cover, in order; the run
   * covers the first ones that fit, and its note keeps exactly those.
   * @param reservation.limitFor - The charge limit of a run over n places, in US dollars.
   * @param reservation.dayStart - When the capped day began.
   * @param reservation.at - The record's time, on the caller's clock.
   * @returns The unfinished run; a new record's id with how many places it covers and its limit; or
   * the day's spend and cap when not even one place fits.
   * @throws Prisma's not-found error when the organization has no settings; ZodError when its
   * `spendCaps` are invalid. Nothing is reserved then.
   */
  reserveRun(reservation: {
    organizationId: string;
    campaignId: string;
    placeIds: readonly string[];
    limitFor: (placeCount: number) => Prisma.Decimal;
    dayStart: Date;
    at: Date;
  }): Promise<ReviewsReservation> {
    const { organizationId, campaignId, placeIds, limitFor, dayStart, at } = reservation;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${spendLockName(organizationId)}, 0))`;
      const open = await findOpenRun(tx, campaignId);
      if (open !== null) return { outcome: 'EXISTING', ...open };
      const { spendCaps } = await tx.settings.findUniqueOrThrow({
        where: { organizationId },
        select: { spendCaps: true },
      });
      const capUsd = new Prisma.Decimal(SpendCaps.parse(spendCaps).apifyDailyUsd);
      const spent = await this.discovery.apifySpentSince(organizationId, dayStart, tx);
      let fit = placeIds.length;
      while (fit > 0 && wouldPassCap(spent, limitFor(fit), capUsd)) fit -= 1;
      if (fit === 0) return { outcome: 'OVER_CAP', spent, capUsd };
      const amountUsd = limitFor(fit);
      const { id } = await tx.costRecord.create({
        data: {
          organizationId,
          campaignId,
          service: 'APIFY',
          amountUsd,
          at,
          note: reviewsRunNote({ runId: null, placeIds: placeIds.slice(0, fit) }),
        },
        select: { id: true },
      });
      return { outcome: 'RESERVED', recordId: id, placeCount: fit, amountUsd };
    });
  }

  /**
   * Finds this campaign's unfinished reviews run without reserving anything.
   * @param campaignId - `Campaign.id`.
   * @returns Its record id, run id (null when it may or may not exist) and places, or null.
   */
  openRun(campaignId: string): Promise<OpenRun | null> {
    return findOpenRun(this.prisma, campaignId);
  }

  /**
   * Marks a reviews run done and sets its true charge on its reservation.
   *
   * Does not lower the reserved amount when the run did not say what it charged.
   * @param recordId - The reservation's `CostRecord.id`.
   * @param reviewItemCount - How many places' reviews the run returned.
   * @param costUsd - True charge in US dollars; null keeps the reserved amount.
   */
  async finishRun(
    recordId: string,
    reviewItemCount: number,
    costUsd: Prisma.Decimal | null,
  ): Promise<void> {
    await this.prisma.costRecord.updateMany({
      where: { id: recordId, units: null },
      data: { units: reviewItemCount, ...(costUsd === null ? {} : { amountUsd: costUsd }) },
    });
  }

  /**
   * Writes a started run's id into its reservation, so a restart collects instead of paying again.
   * @param recordId - The reservation's `CostRecord.id`.
   * @param runId - The id Apify gave the run.
   */
  async saveRunId(recordId: string, runId: string): Promise<void> {
    await this.discovery.saveRunId(recordId, runId);
  }

  /**
   * Finds leads in a campaign that passed the ideal-client filter and have no reviews yet.
   *
   * Does not return a lead marked with {@link NO_REVIEWS_ERROR}: its paid run already happened.
   * @param campaignId - `Campaign.id`.
   * @returns Leads eligible for pass-2 reviews scraping.
   */
  async leadsNeedingReviews(campaignId: string): Promise<{ id: string; placeId: string }[]> {
    return this.prisma.lead.findMany({
      where: {
        campaignId,
        status: { not: 'FILTERED_OUT' },
        reviews: { none: {} },
        // A NOT on a nullable column drops its nulls in SQL, so the null case is spelled out.
        OR: [{ error: null }, { error: { not: NO_REVIEWS_ERROR } }],
      },
      select: { id: true, placeId: true },
    });
  }

  /**
   * Stores up to 30 most recent reviews for a lead, idempotently.
   *
   * Upserts on `(leadId, externalId)`: re-running does not duplicate reviews.
   * Author names are never stored (CLAUDE.md).
   * @param leadId - `Lead.id`.
   * @param rawReviews - Array of raw reviews from Scraperlink or fixture.
   * @returns The number of reviews stored.
   * @throws When the lead does not exist.
   */
  async saveReviews(leadId: string, rawReviews: readonly RawReviewInput[]): Promise<number> {
    const rows = mapReviewsToRows(leadId, rawReviews);
    if (rows.length === 0) return 0;

    await this.prisma.$transaction(
      rows.map((row) =>
        this.prisma.review.upsert({
          where: { leadId_externalId: { leadId, externalId: row.externalId } },
          create: row,
          update: row,
        }),
      ),
    );

    return rows.length;
  }
}
