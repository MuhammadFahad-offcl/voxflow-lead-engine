/**
 * The charge limit of a Compass run, in pure functions.
 *
 * Serves: FR-5, FR-33, ADR-0010 (cap per search), ADR-0015 (input, minimum limit, measured prices).
 * Used by: apps/api/src/adapters/lead-source/fake.adapter.ts, compass-input.spec.ts.
 */
import { Prisma } from '../../generated/prisma/client.js';

// Free-plan prices checked in the Apify Store on 2026-11-04 (ADR-0015): $0.004 a place plus $0.002
// for the detail page that carries booking links, and one start event.
const PLACE_PRICE_USD = new Prisma.Decimal('0.006');
const START_PRICE_USD = new Prisma.Decimal('0.00005');
// Compass refuses a lower limit (`max-total-charge-usd-below-minimum`).
const MIN_CHARGE_LIMIT_USD = new Prisma.Decimal('0.50');

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
