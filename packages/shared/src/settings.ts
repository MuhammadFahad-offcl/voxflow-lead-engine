/**
 * Zod schemas for the JSON columns of the `Settings` table, and the defaults the seed writes.
 *
 * Serves: FR-20 (calling hours), FR-26 (booking), FR-33 (spend caps), ADR-0006 (model per task).
 * Used by: apps/api/src/db/seed.ts; later the Settings API and page (C3-01).
 */
import { z } from 'zod';

// "HH:MM" on a 24-hour clock, in the timezone of the setting that holds it.
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour');
const Day = z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
// Money is never a float (CLAUDE.md): a decimal string, read with Prisma.Decimal.
const Usd = z
  .string()
  .regex(/^\d+\.\d{2}$/, 'US dollars as a string with 2 decimals, e.g. "10.00"');

const TimeRange = z
  .object({ start: Time, end: Time })
  .refine((range) => range.start < range.end, 'start must be before end');

/** When calls may be placed (FR-20). Times are local to `timezone`. */
export const CallingHours = z.object({
  timezone: z.literal('Asia/Karachi'),
  days: z.array(Day).min(1),
  windows: z.array(TimeRange).min(1),
  blocked: z.array(
    z
      .object({ day: Day, start: Time, end: Time })
      .refine((range) => range.start < range.end, 'start must be before end'),
  ),
});

/** When the AI caller may book a video call with the founder (FR-26). Times are Asia/Karachi. */
export const Booking = z
  .object({
    workingDays: z.array(Day).min(1),
    start: Time,
    end: Time,
    meetingMinutes: z.number().int().positive(),
    bufferMinutes: z.number().int().nonnegative(),
    maxPerDay: z.number().int().positive(),
    horizonDays: z.number().int().positive(),
  })
  .refine((booking) => booking.start < booking.end, 'start must be before end');

/** Spend limits in US dollars (FR-33); reaching one pauses that step. */
export const SpendCaps = z.object({
  // ADR-0006 and FR-33 make $10 a month a hard cap, so Settings can lower it but never raise it.
  llmMonthlyUsd: Usd.refine((usd) => Number(usd) <= 10, 'the LLM cap is at most 10.00 a month'),
  apifyDailyUsd: Usd,
  perplexityDailyUsd: Usd,
  vapiDailyUsd: Usd,
});

/** Model id per LLM task (ADR-0006). */
export const LlmModels = z.object({
  REVIEW_LABELLING: z.string().min(1),
  SOLUTION: z.string().min(1),
  SCRIPT: z.string().min(1),
  OUTCOME: z.string().min(1),
});

const MON_TO_SAT = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

/**
 * The values a new organization starts with.
 *
 * Does not hold `retentionDays`: that column has its own database default (90, NFR-6).
 * The daily caps were set by the founder for #7 (Apify $2, Perplexity $2, Vapi $3 until Vapi is
 * priced, PRD Q2); every value can be changed later in Settings.
 */
export const DEFAULT_SETTINGS: {
  callingHours: z.infer<typeof CallingHours>;
  booking: z.infer<typeof Booking>;
  spendCaps: z.infer<typeof SpendCaps>;
  llmModels: z.infer<typeof LlmModels>;
} = {
  callingHours: {
    timezone: 'Asia/Karachi',
    days: [...MON_TO_SAT],
    windows: [
      { start: '10:00', end: '13:00' },
      { start: '15:00', end: '18:00' },
    ],
    // Friday prayers.
    blocked: [{ day: 'FRI', start: '12:30', end: '15:00' }],
  },
  booking: {
    workingDays: [...MON_TO_SAT],
    start: '11:00',
    end: '19:00',
    meetingMinutes: 30,
    bufferMinutes: 15,
    maxPerDay: 4,
    horizonDays: 7,
  },
  spendCaps: {
    llmMonthlyUsd: '10.00',
    apifyDailyUsd: '2.00',
    perplexityDailyUsd: '2.00',
    vapiDailyUsd: '3.00',
  },
  llmModels: {
    REVIEW_LABELLING: 'claude-haiku-5-5',
    SOLUTION: 'claude-haiku-5-5',
    SCRIPT: 'claude-haiku-5-5',
    OUTCOME: 'claude-haiku-5-5',
  },
};
