/**
 * Pure rules of a Compass run: the charge limit, the actor input and the charge of a finished run.
 *
 * Serves: FR-5, FR-33, ADR-0010 (cap per search), ADR-0015 (input, minimum limit, measured prices).
 * Used by: apps/api/src/adapters/lead-source/fake.adapter.ts, compass-input.spec.ts.
 */
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import type { PlaceSearch } from '../../ports/lead-source.port.js';

// Free-plan prices checked in the Apify Store on 2026-11-04 (ADR-0015): $0.004 a place plus $0.002
// for the detail page that carries booking links, and one start event.
const PLACE_PRICE_USD = new Prisma.Decimal('0.006');
const START_PRICE_USD = new Prisma.Decimal('0.00005');
// Compass refuses a lower limit (`max-total-charge-usd-below-minimum`).
const MIN_CHARGE_LIMIT_USD = new Prisma.Decimal('0.50');
// A paid plan's prices are lower, so reading the free tier can over-record but never under-record.
const PLAN_TIER = 'FREE';

/**
 * The charge limit of one run: enough for every place asked for, never below Compass's minimum.
 *
 * Does not say what a run will cost: this is Apify's ceiling. What a run costs follows from the
 * places it returns, so at 30 results the ceiling is $0.50 and the most it should charge is $0.18.
 * @param maxResults - The run's cap on places.
 * @returns max($0.50, places × $0.006 + start), rounded up to the cent, in US dollars.
 */
export function runChargeLimitUsd(maxResults: number): Prisma.Decimal {
  const worstCharge = PLACE_PRICE_USD.times(maxResults).plus(START_PRICE_USD);
  return Prisma.Decimal.max(MIN_CHARGE_LIMIT_USD, worstCharge).toDecimalPlaces(
    2,
    Prisma.Decimal.ROUND_UP,
  );
}

/**
 * Refuses a charge limit Compass would refuse, before any request goes out.
 * @param limit - The limit in US dollars.
 * @throws Error when it is below $0.50.
 */
export function assertChargeLimit(limit: Prisma.Decimal): void {
  if (limit.lessThan(MIN_CHARGE_LIMIT_USD)) {
    throw new Error(`Compass needs a charge limit of at least $0.50, got $${limit.toFixed(2)}`);
  }
}

/**
 * Builds the Compass input for one search.
 *
 * Does not ask for reviews, images or contact add-ons: each is charged per item (ADR-0015).
 * @param search - The search.
 * @returns The actor input.
 */
export function buildCompassInput(search: PlaceSearch): Record<string, unknown> {
  return {
    searchStringsArray: [search.term],
    customGeolocation: search.polygon,
    maxCrawledPlacesPerSearch: search.maxResults,
    language: 'en',
    // Needed for booking links (ADR-0015): the listing side of no_online_booking in #14.
    scrapePlaceDetailPage: true,
    maxReviews: 0,
    maxImages: 0,
    scrapeContacts: false,
  };
}

const EventPrice = z.object({
  eventPriceUsd: z.number().optional(),
  eventTieredPricingUsd: z
    .record(z.string(), z.object({ tieredEventPriceUsd: z.number() }))
    .optional(),
});

const ChargedRun = z.object({
  chargedEventCounts: z.record(z.string(), z.number()),
  pricingInfo: z.object({
    pricingPerEvent: z.object({ actorChargeEvents: z.record(z.string(), EventPrice) }),
  }),
});

/**
 * Works out what a pay-per-event run charged, from its event counts and price list.
 *
 * Does not guess: one missing price makes the whole answer null, so the caller keeps its reserved
 * amount instead of recording too little.
 * @param run - The finished run, as Apify returned it.
 * @returns The charge in US dollars, rounded up to the 5 decimals `CostRecord` stores, or null.
 */
export function chargeOfRun(run: unknown): Prisma.Decimal | null {
  const parsed = ChargedRun.safeParse(run);
  if (!parsed.success) return null;
  const prices = parsed.data.pricingInfo.pricingPerEvent.actorChargeEvents;
  let total = new Prisma.Decimal(0);
  for (const [event, count] of Object.entries(parsed.data.chargedEventCounts)) {
    const price = prices[event];
    const unit =
      price?.eventTieredPricingUsd?.[PLAN_TIER]?.tieredEventPriceUsd ?? price?.eventPriceUsd;
    if (unit === undefined) return null;
    total = total.plus(new Prisma.Decimal(unit).times(count));
  }
  return total.toDecimalPlaces(5, Prisma.Decimal.ROUND_UP);
}
