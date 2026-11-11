/**
 * Unit tests of the spend cap rules: the Apify daily cap, its Asia/Karachi day, and the Karachi
 * month the LLM cap counts.
 *
 * Serves: FR-33, NFR-4, issue #10 (founder decision on Q6: the day is Asia/Karachi, stored in
 * UTC), issue #13 (the $10 monthly LLM cap).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { Prisma } from '../generated/prisma/client.js';
import {
  capPauseReason,
  karachiDayStart,
  karachiMonthStart,
  spendLockName,
  wouldPassCap,
} from './spend-cap.js';

const usd = (amount: string): Prisma.Decimal => new Prisma.Decimal(amount);

// Proves the day turns at midnight in Karachi, which is 19:00 UTC the evening before.
describe('karachiDayStart', () => {
  it.each([
    ['2026-11-05T12:00:00.000Z', '2026-11-04T19:00:00.000Z'],
    ['2026-11-05T18:59:59.999Z', '2026-11-04T19:00:00.000Z'],
    ['2026-11-05T19:00:00.000Z', '2026-11-05T19:00:00.000Z'],
    ['2026-11-04T19:00:00.000Z', '2026-11-04T19:00:00.000Z'],
    ['2027-01-01T02:00:00.000Z', '2026-12-31T19:00:00.000Z'],
  ])('at %s the day began at %s', (now, start) => {
    expect(karachiDayStart(new Date(now)).toISOString()).toBe(start);
  });
});

// Proves the LLM month turns at midnight on the 1st in Karachi, 19:00 UTC on the last day before.
describe('karachiMonthStart', () => {
  it.each([
    ['2026-11-12T10:00:00.000Z', '2026-10-31T19:00:00.000Z'],
    ['2026-11-30T18:59:59.999Z', '2026-10-31T19:00:00.000Z'],
    ['2026-11-30T19:00:00.000Z', '2026-11-30T19:00:00.000Z'],
    ['2026-12-31T19:30:00.000Z', '2026-12-31T19:00:00.000Z'],
    ['2027-03-01T00:00:00.000Z', '2027-02-28T19:00:00.000Z'],
  ])('at %s the month began at %s', (now, start) => {
    expect(karachiMonthStart(new Date(now)).toISOString()).toBe(start);
  });
});

// Proves the check looks ahead: a run is refused if its limit could pass the cap, not after it did.
describe('wouldPassCap', () => {
  it('allows a run that could land exactly on the cap', () => {
    expect(wouldPassCap(usd('1.39'), usd('0.61'), usd('2.00'))).toBe(false);
  });

  it('refuses a run that could pass the cap by one cent', () => {
    expect(wouldPassCap(usd('1.40'), usd('0.61'), usd('2.00'))).toBe(true);
  });

  it('refuses a run before the cap is reached, because the limit counts as spent', () => {
    expect(wouldPassCap(usd('1.83'), usd('0.61'), usd('2.00'))).toBe(true);
  });

  it('compares exactly, with no float error', () => {
    expect(wouldPassCap(usd('0.10'), usd('0.20'), usd('0.30'))).toBe(false);
  });
});

// Proves the founder sees the three numbers behind a pause.
describe('capPauseReason', () => {
  it('says what was spent, what the next run could cost, and the cap', () => {
    expect(capPauseReason(usd('1.83'), usd('0.61'), usd('2.00'))).toBe(
      'Apify daily cap: $1.83 spent today, the next run may charge up to $0.61, the cap is $2.00',
    );
  });
});

// Proves pass 1 and pass 2 of one organization share a lock, and two organizations do not.
describe('spendLockName', () => {
  it('is one name per organization', () => {
    expect(spendLockName('org-1')).toBe(spendLockName('org-1'));
    expect(spendLockName('org-1')).not.toBe(spendLockName('org-2'));
  });
});
