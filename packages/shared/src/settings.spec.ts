/**
 * Unit tests of the Settings JSON schemas and their defaults.
 *
 * Serves: FR-20, FR-26, FR-33, ADR-0006.
 * Used by: `pnpm test`, through the `shared` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { Booking, CallingHours, DEFAULT_SETTINGS, LlmModels, SpendCaps } from './settings.js';

// Proves the defaults match the PRD and that money and times are refused in the wrong shape.
describe('Settings schemas', () => {
  it('accepts every default', () => {
    expect(CallingHours.safeParse(DEFAULT_SETTINGS.callingHours).success).toBe(true);
    expect(Booking.safeParse(DEFAULT_SETTINGS.booking).success).toBe(true);
    expect(SpendCaps.safeParse(DEFAULT_SETTINGS.spendCaps).success).toBe(true);
    expect(LlmModels.safeParse(DEFAULT_SETTINGS.llmModels).success).toBe(true);
  });

  it('holds the FR-20 calling hours: Mon–Sat, 10–13 and 15–18, Friday 12:30–15:00 blocked', () => {
    expect(DEFAULT_SETTINGS.callingHours).toEqual({
      timezone: 'Asia/Karachi',
      days: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
      windows: [
        { start: '10:00', end: '13:00' },
        { start: '15:00', end: '18:00' },
      ],
      blocked: [{ day: 'FRI', start: '12:30', end: '15:00' }],
    });
  });

  it('holds the FR-26 booking defaults', () => {
    expect(DEFAULT_SETTINGS.booking).toMatchObject({
      meetingMinutes: 30,
      bufferMinutes: 15,
      maxPerDay: 4,
      horizonDays: 7,
    });
  });

  it('refuses money as a number, so no float ever stores a cap', () => {
    expect(SpendCaps.safeParse({ ...DEFAULT_SETTINGS.spendCaps, llmMonthlyUsd: 10 }).success).toBe(
      false,
    );
  });

  it('refuses an LLM cap above the 10.00 hard cap', () => {
    expect(
      SpendCaps.safeParse({ ...DEFAULT_SETTINGS.spendCaps, llmMonthlyUsd: '10.01' }).success,
    ).toBe(false);
  });

  it('refuses a calling window that ends before it starts, and a time like 9:00', () => {
    const backwards = {
      ...DEFAULT_SETTINGS.callingHours,
      windows: [{ start: '13:00', end: '10:00' }],
    };
    const shortTime = {
      ...DEFAULT_SETTINGS.callingHours,
      windows: [{ start: '9:00', end: '13:00' }],
    };

    expect(CallingHours.safeParse(backwards).success).toBe(false);
    expect(CallingHours.safeParse(shortTime).success).toBe(false);
  });
});
