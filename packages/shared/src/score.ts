/**
 * The shape of a lead's score breakdown, as `Lead.scoreBreakdown` stores it.
 *
 * Serves: FR-14 (score 0–100 by dimension), docs/database.md (JSON columns checked on write);
 * issue #14.
 * Used by: apps/api/src/db/score.repository.ts; the lead page and table (#16).
 */
import { z } from 'zod';

const Points = z.number().int().min(0).max(100);

/** Points per PRD dimension: pain (max 40), fit (25), reachability (20), ability to pay (15). */
export const ScoreBreakdown = z.strictObject({
  pain: Points,
  fit: Points,
  reachability: Points,
  abilityToPay: Points,
});
/** Parsed `Lead.scoreBreakdown`. */
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;
