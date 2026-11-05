/**
 * Unit tests of the Compass charge limit, input and charge reading.
 *
 * Serves: FR-33, ADR-0015, issue #10 (the run can never overspend, and the true charge is recorded).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { Prisma } from '../../generated/prisma/client.js';
import type { PlaceSearch } from '../../ports/lead-source.port.js';
import {
  assertChargeLimit,
  buildCompassInput,
  chargeOfRun,
  runChargeLimitUsd,
} from './compass-input.js';

const search: PlaceSearch = {
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
  maxResults: 30,
  chargeLimitUsd: new Prisma.Decimal('0.50'),
};

// Proves the limit formula, including the 30-result test run and the 100-result full search.
describe('runChargeLimitUsd', () => {
  it.each([
    [1, '0.50'],
    [30, '0.50'],
    [83, '0.50'],
    [84, '0.51'],
    [100, '0.61'],
  ])('gives %d results a limit of $%s', (maxResults, limit) => {
    expect(runChargeLimitUsd(maxResults).toFixed(2)).toBe(limit);
  });
});

// Proves a limit Compass would refuse never leaves the process.
describe('assertChargeLimit', () => {
  it('accepts exactly $0.50', () => {
    expect(() => {
      assertChargeLimit(new Prisma.Decimal('0.50'));
    }).not.toThrow();
  });

  it('refuses $0.49', () => {
    expect(() => {
      assertChargeLimit(new Prisma.Decimal('0.49'));
    }).toThrow('at least $0.50');
  });
});

// Proves the input matches ADR-0015: a polygon, details on, and no paid add-ons.
describe('buildCompassInput', () => {
  it('searches inside the polygon for at most the capped number of places', () => {
    expect(buildCompassInput(search)).toMatchObject({
      searchStringsArray: ['dental clinic'],
      customGeolocation: search.polygon,
      maxCrawledPlacesPerSearch: 30,
      scrapePlaceDetailPage: true,
    });
  });

  it('asks for no reviews, images or contacts, and sends no text location', () => {
    const input = buildCompassInput(search);

    expect(input).toMatchObject({ maxReviews: 0, maxImages: 0, scrapeContacts: false });
    expect(input).not.toHaveProperty('locationQuery');
  });
});

// Proves the recorded charge comes from what Apify counted, in Decimal, and is never guessed low.
describe('chargeOfRun', () => {
  const pricingInfo = {
    pricingPerEvent: {
      actorChargeEvents: {
        'actor-start': { eventPriceUsd: 0.00005 },
        'place-scraped': {
          eventPriceUsd: 0.009,
          eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.004 } },
        },
        'place-details': { eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.002 } } },
      },
    },
  };

  it('adds each event at its free-tier price, with no float error', () => {
    const run = {
      chargedEventCounts: { 'actor-start': 1, 'place-scraped': 12, 'place-details': 12 },
      pricingInfo,
    };

    expect(chargeOfRun(run)?.toFixed(5)).toBe('0.07205');
  });

  it('is 0 for a run with no charged events', () => {
    expect(chargeOfRun({ chargedEventCounts: {}, pricingInfo })?.toFixed(5)).toBe('0.00000');
  });

  it('rounds a fraction past 5 decimals up', () => {
    const run = {
      chargedEventCounts: { tiny: 1 },
      pricingInfo: {
        pricingPerEvent: { actorChargeEvents: { tiny: { eventPriceUsd: 0.000001 } } },
      },
    };

    expect(chargeOfRun(run)?.toFixed(5)).toBe('0.00001');
  });

  it('is null when an event has no known price', () => {
    expect(chargeOfRun({ chargedEventCounts: { other: 1 }, pricingInfo })).toBeNull();
  });

  it('is null when the run has no price list', () => {
    expect(chargeOfRun({ chargedEventCounts: { 'place-scraped': 1 } })).toBeNull();
  });
});
