/**
 * The Apify daily spend cap: which day it counts, and whether the next run may start.
 *
 * Serves: FR-33, NFR-4, issue #10 (founder decision on Q6: the Asia/Karachi day).
 * Used by: apps/api/src/pipeline/spend-cap.spec.ts; the discover step in #10.
 */
import type { Prisma } from '../generated/prisma/client.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// A fixed offset, because Pakistan keeps UTC+5 all year.
const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

/**
 * Finds when the current Asia/Karachi day began.
 * @param now - The current time.
 * @returns That midnight as a UTC instant, comparable with `CostRecord.at`.
 */
export function karachiDayStart(now: Date): Date {
  const localDays = Math.floor((now.getTime() + KARACHI_OFFSET_MS) / DAY_MS);
  return new Date(localDays * DAY_MS - KARACHI_OFFSET_MS);
}

/**
 * Decides whether a run could take the day's spend past the cap.
 *
 * Does not wait for the cap to be reached: a run's limit counts as spent, so the last run of the
 * day cannot overshoot. Landing exactly on the cap is allowed.
 * @param spent - Spent or reserved today, in US dollars.
 * @param nextLimit - The next run's charge limit, in US dollars.
 * @param cap - The daily cap, in US dollars.
 * @returns True when the run must not start.
 */
export function wouldPassCap(
  spent: Prisma.Decimal,
  nextLimit: Prisma.Decimal,
  cap: Prisma.Decimal,
): boolean {
  return spent.plus(nextLimit).greaterThan(cap);
}

/**
 * Words the pause for the dashboard.
 * @param spent - Spent or reserved today, in US dollars.
 * @param nextLimit - The next run's charge limit, in US dollars.
 * @param cap - The daily cap, in US dollars.
 * @returns The text for `Campaign.pauseReason`.
 */
export function capPauseReason(
  spent: Prisma.Decimal,
  nextLimit: Prisma.Decimal,
  cap: Prisma.Decimal,
): string {
  const [today, next, limit] = [spent, nextLimit, cap].map((amount) => amount.toFixed(2));
  return `Apify daily cap: $${String(today)} spent today, the next run may charge up to $${String(next)}, the cap is $${String(limit)}`;
}
