/**
 * The port discovery uses to get Google Maps places, split so a paid run survives a restart.
 *
 * Serves: FR-5, FR-33, ADR-0007 (ports and adapters), ADR-0015 (pass 1 only; pass 2 comes in #12).
 * Used by: apps/api/src/adapters/lead-source/, apps/api/src/bootstrap.ts; the discover step in #10.
 */
import type { AreaPolygon } from '@voxflow/shared';
import type { CompassPlaceItem } from '../adapters/lead-source/apify-items.js';
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

/** What a finished run returned. */
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

/** Finds places. Implemented by the Apify adapter and by a fixture-backed fake. */
export interface LeadSourcePort {
  /**
   * Gives the charge limit for a run, so the spend cap can be checked before paying.
   * @param maxResults - The run's cap on places.
   * @returns The limit in US dollars.
   */
  chargeLimitUsd(maxResults: number): Prisma.Decimal;

  /**
   * Starts one paid run and returns at once.
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
   * Waits for a run, then reads its results and charge. Free, so it is safe to repeat.
   *
   * Does not start anything. Returns what a failed or timed-out run did produce, because that run
   * was paid for.
   * @param runId - Id from {@link LeadSourcePort.start}.
   * @returns The valid items, the charge, how the run ended and how many items were invalid.
   * @throws When the run cannot be read, or is still running after the wait.
   */
  collect(runId: string): Promise<CollectedRun>;
}
