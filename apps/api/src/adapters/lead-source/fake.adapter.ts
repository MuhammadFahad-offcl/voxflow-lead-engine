/**
 * The fake lead source: fictional fixtures instead of Apify, with the same start and collect steps.
 *
 * Serves: ADR-0007 (DEMO_MODE binds every fake), FR-36, NFR-9; issue #10, issue #12.
 * Used by: apps/api/src/bootstrap.ts, through `bindAdapter`, when DEMO_MODE=true; integration tests.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Inject, Injectable } from '@hazeljs/core';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { LOGGER, type Logger } from '../../logging/logger.js';
import type {
  CollectedReviewsRun,
  CollectedRun,
  LeadSourcePort,
  PlaceSearch,
} from '../../ports/lead-source.port.js';
import { parsePlaceItems, parseReviewsItems, ScraperlinkReviewsItem } from './apify-items.js';
import { assertChargeLimit, runChargeLimitUsd } from './compass-input.js';

const FIXTURES_DIR = resolve(import.meta.dirname, '../../../../../fixtures/places');
const REVIEWS_FIXTURES_DIR = resolve(import.meta.dirname, '../../../../../fixtures/reviews');
// The niche's terms share the fixtures, each row going to one term. Serving all of them to every
// term would count each place 4 times, and the DHA campaign must end with 12 found, 1 duplicate;
// serving them to one term would leave 3 searches empty, and an empty search pauses a campaign.
// So an area needs at least 4 rows: only DHA and Gulberg have them, and other areas pause in demo.
const FIXTURE_TERMS = ['dental clinic', 'dentist', 'dental surgeon', 'orthodontist'];
// Fictional, so demo campaigns show cost figures of the right size.
const PLACE_CHARGE_USD = new Prisma.Decimal('0.006');
const REVIEW_CHARGE_USD = new Prisma.Decimal('0.00026');
const REVIEW_LIMIT_PER_PLACE_USD = new Prisma.Decimal('0.008');

// The run id holds the whole search, so a restart can collect it like a real run.
const FakeRun = z.object({ term: z.string(), area: z.string(), maxResults: z.number() });
const FakeReviewsRun = z.object({ kind: z.literal('reviews'), placeIds: z.array(z.string()) });

/** Serves fixtures/places/*.json and fixtures/reviews/*.json. */
@Injectable()
export class FakeLeadSourceAdapter implements LeadSourcePort {
  /**
   * Wires the adapter to its logger.
   * @param logger - Root logger, for invalid fixture items.
   */
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  /** @inheritDoc */
  chargeLimitUsd(maxResults: number): Prisma.Decimal {
    return runChargeLimitUsd(maxResults);
  }

  /** @inheritDoc */
  async start(search: PlaceSearch): Promise<string> {
    // Awaited so a refusal rejects the promise, as the real adapter's does.
    await Promise.resolve();
    assertChargeLimit(search.chargeLimitUsd);
    const { term, area, maxResults } = search;
    return JSON.stringify({ term, area, maxResults });
  }

  /** @inheritDoc */
  collect(runId: string): Promise<CollectedRun> {
    const { term, area, maxResults } = FakeRun.parse(JSON.parse(runId));
    const wanted = area.toLowerCase();
    const share = FIXTURE_TERMS.indexOf(term);
    const items = this.fixtures()
      .filter((item) => item.neighborhood?.toLowerCase().includes(wanted))
      .filter((_item, index) => index % FIXTURE_TERMS.length === share)
      .slice(0, maxResults);
    return Promise.resolve({
      items,
      costUsd: PLACE_CHARGE_USD.times(items.length),
      status: 'SUCCEEDED',
      skippedCount: 0,
    });
  }

  /** @inheritDoc */
  chargeLimitReviewsUsd(placeCount: number): Prisma.Decimal {
    return REVIEW_LIMIT_PER_PLACE_USD.times(placeCount);
  }

  /** @inheritDoc */
  async startReviews(placeIds: readonly string[], chargeLimitUsd: Prisma.Decimal): Promise<string> {
    await Promise.resolve();
    if (chargeLimitUsd.isNegative()) throw new Error('Negative charge limit');
    return JSON.stringify({ kind: 'reviews', placeIds: [...placeIds] });
  }

  /** @inheritDoc */
  async collectReviews(runId: string): Promise<CollectedReviewsRun> {
    await Promise.resolve();
    const { placeIds } = FakeReviewsRun.parse(JSON.parse(runId));
    const wanted = new Set(placeIds);
    const items = this.reviewFixtures().filter((item) => wanted.has(item.placeId));
    const totalReviews = items.reduce((sum, item) => sum + item.reviews.length, 0);

    return {
      items,
      costUsd: REVIEW_CHARGE_USD.times(totalReviews),
      status: 'SUCCEEDED',
      skippedCount: 0,
    };
  }

  private reviewFixtures(): ScraperlinkReviewsItem[] {
    const raw = readdirSync(REVIEWS_FIXTURES_DIR)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) =>
        z
          .array(z.unknown())
          .parse(JSON.parse(readFileSync(join(REVIEWS_FIXTURES_DIR, file), 'utf8'))),
      );
    return parseReviewsItems(raw, this.logger);
  }

  private fixtures(): ReturnType<typeof parsePlaceItems> {
    const raw = readdirSync(FIXTURES_DIR)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) =>
        z.array(z.unknown()).parse(JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8'))),
      );
    return parsePlaceItems(raw, this.logger);
  }
}
