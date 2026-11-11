/**
 * The score step: reads a lead's facts and its niche version's rules, scores it with the pure
 * rules in `scoring/`, and stores the score, breakdown, tier and signals. Not wired into a runner or
 * graph yet: #15 runs it after review labelling.
 *
 * Serves: FR-14, FR-15; issue #14.
 * Used by: the score integration tests, until #15 calls it from the lead graph.
 */
import type { ScoreRepository } from '../db/score.repository.js';
import type { Logger } from '../logging/logger.js';
import { scoreLead, type Tier } from '../scoring/score-lead.js';

/** What the step needs from outside. */
export interface ScoreDeps {
  leads: ScoreRepository;
  logger: Logger;
}

/** How one run ended. */
export type ScoreOutcome =
  | { status: 'SCORED'; score: number; tier: Tier }
  | { status: 'SKIPPED'; reason: 'FILTERED_OUT' | 'PAST_SCORING' };

/**
 * Scores one lead and stores the result.
 *
 * Safe to repeat: a second run replaces the signals and score with the same ones, or with new ones
 * when the facts changed. A lead past scoring (solution, script or calls) is left alone, so a
 * retried graph never sends it back to SCORED. Reviews not labelled yet earn no review points, so #15 must run review
 * labelling first. A COLD lead stops at SCORED: no solution, script or call (FR-15).
 * Logs the lead id, score and tier only.
 * @param deps - Its dependencies.
 * @param leadId - `Lead.id` of the lead to score.
 * @returns SCORED with the score and tier; SKIPPED for a filtered-out lead or one past scoring.
 * @throws Prisma errors, e.g. when there is no such lead; ZodError for a stored JSON column that
 * does not match its schema; Error when the niche weights name a signal with no rule.
 */
export async function scoreStoredLead(deps: ScoreDeps, leadId: string): Promise<ScoreOutcome> {
  const { leads, logger } = deps;
  const { status, facts, niche } = await leads.forScoring(leadId);
  if (status === 'FILTERED_OUT') return { status: 'SKIPPED', reason: 'FILTERED_OUT' };

  const result = scoreLead(facts, niche);
  if (!(await leads.saveScore(leadId, result)))
    return { status: 'SKIPPED', reason: 'PAST_SCORING' };
  logger.info({ leadId, score: result.total, tier: result.tier }, 'lead scored');
  return { status: 'SCORED', score: result.total, tier: result.tier };
}
