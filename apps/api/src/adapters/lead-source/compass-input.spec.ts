/**
 * Unit tests of the Compass charge limit.
 *
 * Serves: FR-33, ADR-0015, issue #10 (the run can never overspend, and the true charge is recorded).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { Prisma } from '../../generated/prisma/client.js';
import { assertChargeLimit, runChargeLimitUsd } from './compass-input.js';

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
