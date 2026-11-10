/**
 * The port discovery and enrichment use to get Google Maps places and reviews.
 *
 * Serves: FR-5, FR-11, FR-33, ADR-0007 (ports and adapters), ADR-0015 (hybrid two-pass design).
 * Used by: apps/api/src/adapters/lead-source/, apps/api/src/bootstrap.ts,
 * apps/api/src/pipeline/discover.step.ts, apps/api/src/pipeline/enrich.step.ts.
 */
import type { AreaPolygon } from '@voxflow/shared';
import type {
  CompassPlaceItem,
  ScraperlinkReviewsItem,
} from '../adapters/lead-source/apify-items.js';
import type { Prisma } from '../generated/prisma/client.js';

/** DI token of {@link LeadSourcePort}. */
export const LEAD_SOURCE = 'LeadSourcePort';

/** One cell of the search grid (FR-2). */
export interface PlaceSearch {
  term: string;
  area: string;
  city: string;
  polygon: AreaPolygon;
  /** At most this many places; the cap of ADR-0010. */
  maxResults: number;
  /** The most this run may charge, in US dollars, from {@link LeadSourcePort.chargeLimitUsd}. */
  chargeLimitUsd: Prisma.Decimal;
}

/** What a finished places run returned. */
export interface CollectedRun {
  /** Every item that passed validation; invalid items are logged and left out. */
  items: CompassPlaceItem[];
  /** True charge in US dollars, or null when the run did not say: keep the amount reserved. */
  costUsd: Prisma.Decimal | null;
  /** How the run ended; anything but SUCCEEDED means `items` may be only part of the results. */
  status: 'SUCCEEDED' | 'FAILED' | 'TIMED-OUT' | 'ABORTED';
  /** How many items failed validation and were left out. */
  skippedCount: number;
}

/** What a finished reviews run returned (pass 2). */
export interface CollectedReviewsRun {
  /** Every review item that passed validation; invalid items are logged and left out. */
  items: ScraperlinkReviewsItem[];
  /** True charge in US dollars, or null when the run did not say. */
  costUsd: Prisma.Decimal | null;
  /** How the run ended. */
  status: 'SUCCEEDED' | 'FAILED' | 'TIMED-OUT' | 'ABORTED';
  /** How many items failed validation and were left out. */
  skippedCount: number;
}

/** Finds places and reviews. Implemented by the Apify adapter and by a fixture-backed fake. */
export interface LeadSourcePort {
  /**
   * Gives the charge limit for a pass-1 places run, so the spend cap can be checked before paying.
   * @param maxResults - The run's cap on places.
   * @returns The limit in US dollars.
   */
  chargeLimitUsd(maxResults: number): Prisma.Decimal;

  /**
   * Starts one paid places run and returns at once.
   *
   * Does not retry, in the adapter or its client: a failed request may still have started a run,
   * and a second attempt would pay twice. Save the id before doing anything else.
   * @param search - The search to run.
   * @returns The run id, which is all {@link LeadSourcePort.collect} needs, even after a restart.
   * @throws When the limit is below the actor's minimum, or the request fails; in the second case
   * a run may exist, so the caller must not simply start again.
   */
  start(search: PlaceSearch): Promise<string>;

  /**
   * Waits for a places run, then reads its results and charge. Free, so it is safe to repeat.
   *
   * Does not start anything. Returns what a failed or timed-out run did produce, because that run
   * was paid for.
   * @param runId - Id from {@link LeadSourcePort.start}.
   * @returns The valid items, the charge, how the run ended and how many items were invalid.
   * @throws When the run cannot be read, or is still running after the wait.
   */
  collect(runId: string): Promise<CollectedRun>;

  /**
   * Gives the charge limit for a pass-2 reviews run, so the spend cap can be checked before paying.
   *
   * Grows by one cent per place and has no minimum, so a caller may fit a run to the room left
   * under the cap: the limit of n places is never above that of n + 1.
   * @param placeCount - How many places the run covers; 0 gives $0.
   * @returns The limit in US dollars: $0.01 per place, rounded up to the cent.
   */
  chargeLimitReviewsUsd(placeCount: number): Prisma.Decimal;

  /**
   * Starts one paid pass-2 reviews run for a batch of place ids and returns at once.
   *
   * Does not retry, in the adapter or its client: a failed request may still have started a run,
   * and a second attempt would pay twice. Save the id before doing anything else.
   * @param placeIds - Place ids to fetch reviews for.
   * @param chargeLimitUsd - The most the run may charge, in US dollars, from
   * {@link LeadSourcePort.chargeLimitReviewsUsd}.
   * @returns The run id, which is all {@link LeadSourcePort.collectReviews} needs.
   * @throws When the request fails; a run may exist then, so the caller must not simply start again.
   */
  startReviews(placeIds: readonly string[], chargeLimitUsd: Prisma.Decimal): Promise<string>;

  /**
   * Waits for a pass-2 reviews run, then reads and validates its review items. Free, so it is safe
   * to repeat.
   *
   * Does not start anything. Returns what a failed or timed-out run did produce, because that run
   * was paid for.
   * @param runId - Id from {@link LeadSourcePort.startReviews}.
   * @returns The valid items, the charge, how the run ended and how many items were invalid.
   * @throws When the run cannot be read, or is still running after the wait.
   */
  collectReviews(runId: string): Promise<CollectedReviewsRun>;
}
