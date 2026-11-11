/**
 * The spend caps' calendar and rule: which Asia/Karachi day or month a cap counts, and whether
 * the next charge may go ahead.
 *
 * Serves: FR-33, NFR-4, issue #10 (founder decision on Q6: the Asia/Karachi day), issue #13 (the
 * monthly LLM cap).
 * Used by: apps/api/src/pipeline/discover.step.ts, apps/api/src/db/discovery.repository.ts,
 * apps/api/src/db/review.repository.ts, apps/api/src/pipeline/enrich-reviews.step.ts,
 * apps/api/src/pipeline/enrich-context.step.ts, apps/api/src/llm/llm.service.ts,
 * apps/api/src/pipeline/spend-cap.spec.ts.
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
 * Finds when the current Asia/Karachi month began, for the monthly LLM cap (FR-33).
 * @param now - The current time.
 * @returns Midnight on the 1st in Karachi as a UTC instant, comparable with `CostRecord.at`.
 */
export function karachiMonthStart(now: Date): Date {
  // Shifted to Karachi wall time, the UTC fields read as the local year and month.
  const local = new Date(now.getTime() + KARACHI_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - KARACHI_OFFSET_MS);
}

/**
 * Names the advisory lock every Apify reservation of an organization takes, so they run in turns.
 *
 * Shared by pass 1 and pass 2: a reservation of either must see the other's.
 * @param organizationId - Owner of the spend.
 * @returns The lock's name, hashed by Postgres into its key.
 */
export function spendLockName(organizationId: string): string {
  return `apify-spend:${organizationId}`;
}

/**
 * Decides whether the next charge (an Apify run, a search or an LLM call) could take the period's
 * spend past the cap.
 *
 * Does not wait for the cap to be reached: the charge's limit counts as spent, so the last charge
 * of the period cannot overshoot. Landing exactly on the cap is allowed.
 * @param spent - Spent or reserved in the period (a Karachi day or month), in US dollars.
 * @param nextLimit - The most the next charge can cost, in US dollars.
 * @param cap - The cap for the period, in US dollars.
 * @returns True when the charge must not go ahead.
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
