/**
 * Adapter tests of the fake lead source that demo mode and integration tests run on.
 *
 * Serves: ADR-0007, FR-36, issue #10 (the fixture campaign ends with 12 found).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '../../generated/prisma/client.js';
import type { Logger } from '../../logging/logger.js';
import type { PlaceSearch } from '../../ports/lead-source.port.js';
import { FakeLeadSourceAdapter } from './fake.adapter.js';

const adapter = new FakeLeadSourceAdapter({ warn: jest.fn() } as unknown as Logger);

const search = (overrides: Partial<PlaceSearch> = {}): PlaceSearch => ({
  term: 'dental clinic',
  area: 'DHA',
  city: 'Lahore',
  polygon: {
    type: 'Polygon',
    coordinates: [
      [
        [74, 31],
        [75, 31],
        [75, 32],
        [74, 31],
      ],
    ],
  },
  maxResults: 100,
  chargeLimitUsd: new Prisma.Decimal('0.61'),
  ...overrides,
});

const collect = async (overrides: Partial<PlaceSearch> = {}) =>
  adapter.collect(await adapter.start(search(overrides)));

// Proves the fake behaves like the port promises, so demo mode exercises the real flow.
describe('FakeLeadSourceAdapter', () => {
  it('serves a share of the fixture rows in DHA, as a successful run with a Decimal charge', async () => {
    const { items, costUsd, status, skippedCount } = await collect();

    expect(items).toHaveLength(3);
    expect(costUsd?.toFixed(3)).toBe('0.018');
    expect({ status, skippedCount }).toEqual({ status: 'SUCCEEDED', skippedCount: 0 });
  });

  it('matches the area in any case', async () => {
    expect((await collect({ area: 'dha' })).items).toHaveLength(3);
  });

  it('serves nothing for an area the fixtures do not cover', async () => {
    expect((await collect({ area: 'Bahria Town' })).items).toHaveLength(0);
  });

  it('splits the 12 rows across the 4 terms, so no place is served twice by the split', async () => {
    const terms = ['dental clinic', 'dentist', 'dental surgeon', 'orthodontist'];

    const runs = await Promise.all(terms.map((term) => collect({ term })));

    expect(runs.map(({ items }) => items.length)).toEqual([3, 3, 3, 3]);
  });

  it('gives each term one of the 4 Gulberg rows, so no Gulberg search comes back empty', async () => {
    const terms = ['dental clinic', 'dentist', 'dental surgeon', 'orthodontist'];

    const runs = await Promise.all(terms.map((term) => collect({ term, area: 'Gulberg' })));

    expect(runs.map(({ items }) => items.length)).toEqual([1, 1, 1, 1]);
  });

  it('serves nothing for a term the fixtures do not cover', async () => {
    const { items, costUsd } = await collect({ term: 'fictional term' });

    expect(items).toHaveLength(0);
    expect(costUsd?.isZero()).toBe(true);
  });

  it('honours the cap per search', async () => {
    expect((await collect({ maxResults: 2 })).items).toHaveLength(2);
  });

  it('refuses a charge limit below $0.50, like the real adapter', async () => {
    const tooLow = search({ chargeLimitUsd: new Prisma.Decimal('0.49') });

    await expect(adapter.start(tooLow)).rejects.toThrow('at least $0.50');
  });

  it('gives the same charge limit as the real run would have', () => {
    expect(adapter.chargeLimitUsd(30).toFixed(2)).toBe('0.50');
  });

  it('serves reviews for requested placeIds with calculated cost', async () => {
    const runId = await adapter.startReviews(
      ['fictional-place-p01', 'fictional-place-p02'],
      new Prisma.Decimal('0.02'),
    );
    const collected = await adapter.collectReviews(runId);

    expect(collected.status).toBe('SUCCEEDED');
    expect(collected.items).toHaveLength(2);
    expect(collected.items[0]?.placeId).toBe('fictional-place-p01');
    expect(collected.costUsd?.isPositive()).toBe(true);
  });

  it('calculates reviews charge limit based on place count', () => {
    expect(adapter.chargeLimitReviewsUsd(3).toFixed(3)).toBe('0.024');
  });
});
