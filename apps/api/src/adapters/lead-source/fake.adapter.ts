/**
 * The fake lead source: fictional fixtures instead of Apify, with the same start and collect steps.
 *
 * Serves: ADR-0007 (DEMO_MODE binds every fake), FR-36, NFR-9; issue #10.
 * Used by: apps/api/src/bootstrap.ts, through `bindAdapter`, when DEMO_MODE=true; integration tests.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Inject, Injectable } from '@hazeljs/core';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { LOGGER, type Logger } from '../../logging/logger.js';
import type { CollectedRun, LeadSourcePort, PlaceSearch } from '../../ports/lead-source.port.js';
import { parsePlaceItems } from './apify-items.js';
import { assertChargeLimit, runChargeLimitUsd } from './compass-input.js';

const FIXTURES_DIR = resolve(import.meta.dirname, '../../../../../fixtures/places');
// The niche's terms share the fixtures, each row going to one term. Serving all of them to every
// term would count each place 4 times, and the fixture campaign must end with 12 found, 1 duplicate;
// serving them to one term would leave 3 searches empty, and an empty search pauses a campaign.
const FIXTURE_TERMS = ['dental clinic', 'dentist', 'dental surgeon', 'orthodontist'];
// Fictional, so demo campaigns show cost figures of the right size.
const PLACE_CHARGE_USD = new Prisma.Decimal('0.006');

// The run id holds the whole search, so a restart can collect it like a real run.
const FakeRun = z.object({ term: z.string(), area: z.string(), maxResults: z.number() });

/** Serves fixtures/places/*.json. */
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

  private fixtures(): ReturnType<typeof parsePlaceItems> {
    const raw = readdirSync(FIXTURES_DIR)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) =>
        z.array(z.unknown()).parse(JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8'))),
      );
    return parsePlaceItems(raw, this.logger);
  }
}
