/**
 * Database access for storing business reviews for a lead.
 *
 * Serves: FR-11 (store up to 30 most recent Google reviews per business), ADR-0015.
 * Used by: apps/api/src/app.module.ts, apps/api/test/review.repository.int.spec.ts.
 */
import { Injectable } from '@hazeljs/core';
import { PrismaProvider } from './prisma.provider.js';
import { mapReviewsToRows, type RawReviewInput } from '../pipeline/review-mapper.js';

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
   */
  constructor(private readonly prisma: PrismaProvider) {}

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
