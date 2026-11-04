/**
 * Unit tests of the duplicate-rate rule.
 *
 * Serves: FR-2 (each campaign shows its duplicate rate).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { duplicateRate } from './campaigns.service.js';

// Proves the rate is duplicates ÷ found, rounded to 2 decimals, and null before anything is found.
describe('duplicateRate', () => {
  it('is null when discovery has found nothing yet', () => {
    expect(duplicateRate(0, 0)).toBeNull();
  });

  it('is 0 when nothing was a duplicate', () => {
    expect(duplicateRate(5, 0)).toBe(0);
  });

  it('rounds to 2 decimals', () => {
    // toBeCloseTo with 10 digits: exact to 2 decimals, without a float equality check.
    expect(duplicateRate(3, 1)).toBeCloseTo(0.33, 10);
    expect(duplicateRate(3, 2)).toBeCloseTo(0.67, 10);
  });

  it('is 1 when every result was a duplicate', () => {
    expect(duplicateRate(8, 8)).toBe(1);
  });
});
