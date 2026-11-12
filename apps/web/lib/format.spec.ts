/**
 * Unit tests of the dashboard's time and rate formats.
 *
 * Serves: NFR-13 (Asia/Karachi on screen); issue #16.
 * Used by: `pnpm test`, through the `web` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { karachiTime, percent } from './format';

// Proves NFR-13: a UTC time shows in Pakistan time (UTC+5, no daylight saving), whatever the zone.
describe('karachiTime', () => {
  it('shows 08:15 UTC as 13:15 in Karachi', () => {
    expect(karachiTime('2026-11-12T08:15:00.000Z')).toBe('12 Nov 2026, 13:15');
  });

  it('moves to the next day after 19:00 UTC', () => {
    expect(karachiTime('2026-11-12T19:30:00.000Z')).toBe('13 Nov 2026, 00:30');
  });
});

// Proves rates show as whole percents, and "nothing yet" as a dash.
describe('percent', () => {
  it.each([
    [0.25, '25%'],
    [0, '0%'],
    [0.336, '34%'],
    [null, '—'],
  ])('shows %p as %s', (rate, text) => {
    expect(percent(rate)).toBe(text);
  });
});
