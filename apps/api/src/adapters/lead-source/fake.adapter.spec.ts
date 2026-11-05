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
  it('serves the 12 fixture rows for "dental clinic" in DHA, with a Decimal charge', async () => {
    const { items, costUsd } = await collect();

    expect(items).toHaveLength(12);
    expect(costUsd?.toFixed(3)).toBe('0.072');
  });

  it('matches the area in any case', async () => {
    expect((await collect({ area: 'dha' })).items).toHaveLength(12);
  });

  it('serves nothing for an area the fixtures do not cover', async () => {
    expect((await collect({ area: 'Bahria Town' })).items).toHaveLength(0);
  });

  it('serves nothing for the other search terms, so places are not counted 4 times', async () => {
    const { items, costUsd } = await collect({ term: 'dentist' });

    expect(items).toHaveLength(0);
    expect(costUsd?.isZero()).toBe(true);
  });

  it('honours the cap per search', async () => {
    expect((await collect({ maxResults: 5 })).items).toHaveLength(5);
  });

  it('refuses a charge limit below $0.50, like the real adapter', async () => {
    const tooLow = search({ chargeLimitUsd: new Prisma.Decimal('0.49') });

    await expect(adapter.start(tooLow)).rejects.toThrow('at least $0.50');
  });

  it('gives the same charge limit as the real run would have', () => {
    expect(adapter.chargeLimitUsd(30).toFixed(2)).toBe('0.50');
  });
});
