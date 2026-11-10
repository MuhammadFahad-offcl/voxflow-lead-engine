/**
 * Pure mapping from Scraperlink review items to Review database rows.
 *
 * Serves: FR-11 (store up to 30 most recent Google reviews per business), ADR-0015.
 * Used by: apps/api/src/db/review.repository.ts, apps/api/src/pipeline/review-mapper.spec.ts.
 */
import type { ScraperlinkReviewsItem } from '../adapters/lead-source/apify-items.js';

/** One review as the validated Scraperlink item holds it. */
export type RawReviewInput = ScraperlinkReviewsItem['reviews'][number];

/** A `Review` row ready to store; `author` is null by design. */
export interface ReviewRow {
  leadId: string;
  externalId: string;
  text: string;
  rating: number;
  publishedAt: Date;
  ownerReplied: boolean;
  author: null;
}

/** Maximum reviews kept per lead (FR-11). */
export const MAX_REVIEWS_PER_LEAD = 30;

/**
 * Maps raw reviews into up to 30 newest `Review` rows for a given lead.
 *
 * Sets `ownerReplied` to true when `responseFromOwnerText` is non-empty.
 * Does not store or accept author names or reviewer profiles (CLAUDE.md security & privacy).
 * @param leadId - `Lead.id`.
 * @param rawReviews - Reviews from Scraperlink or a fixture.
 * @returns At most 30 rows, newest first.
 */
export function mapReviewsToRows(
  leadId: string,
  rawReviews: readonly RawReviewInput[],
): ReviewRow[] {
  const newest = [...rawReviews]
    .sort((a, b) => Date.parse(b.publishedAtDate) - Date.parse(a.publishedAtDate))
    .slice(0, MAX_REVIEWS_PER_LEAD);

  return newest.map((review) => ({
    leadId,
    externalId: review.reviewId,
    // A star-only review has no text, but it still counts as one of the 30.
    text: review.text ?? '',
    rating: review.stars,
    publishedAt: new Date(review.publishedAtDate),
    ownerReplied: (review.responseFromOwnerText ?? '').trim().length > 0,
    author: null,
  }));
}
