/**
 * The lead score: the sum of the niche profile's points for every signal with evidence, its
 * breakdown by dimension, and the tier.
 *
 * Plain code adds the points; the LLM only labels reviews (PRD "Lead scoring model": the same
 * signals always give the same score).
 *
 * Serves: FR-14 (score 0–100 with evidence), FR-15 (tiers); issue #14.
 * Used by: apps/api/src/scoring/score-lead.spec.ts; the score step (#14, next PR).
 */
import type { Dimension, LeadFacts, NicheRules } from './lead-facts.js';
import { SIGNAL_RULES } from './signals.js';

/** A tier, as `Lead.tier` stores it. */
export type Tier = 'HOT' | 'WARM' | 'COLD';

/** One signal that earned points, as a `Signal` row stores it. */
interface ScoredSignal {
  key: string;
  dimension: Dimension;
  points: number;
  evidence: string;
  sourceUrl: string | null;
  reviewId: string | null;
}

/** A lead's score. */
export interface ScoreResult {
  /** One per signal with evidence; each key at most once. */
  signals: ScoredSignal[];
  /** 0 to 100. */
  total: number;
  /** Points per dimension, as `Lead.scoreBreakdown` stores them. */
  breakdown: { pain: number; fit: number; reachability: number; abilityToPay: number };
  tier: Tier;
}

const BREAKDOWN_KEY = {
  PAIN: 'pain',
  FIT: 'fit',
  REACHABILITY: 'reachability',
  ABILITY_TO_PAY: 'abilityToPay',
} as const satisfies Record<Dimension, keyof ScoreResult['breakdown']>;

const hasRule = (key: string): key is keyof typeof SIGNAL_RULES => Object.hasOwn(SIGNAL_RULES, key);

/**
 * Puts a score in its tier.
 * @param total - The score, 0 to 100.
 * @param tiers - The niche's thresholds.
 * @returns HOT at or above `hot`, WARM at or above `warm`, COLD below.
 */
export function tierFor(total: number, tiers: NicheRules['tiers']): Tier {
  if (total >= tiers.hot) return 'HOT';
  return total >= tiers.warm ? 'WARM' : 'COLD';
}

/**
 * Scores one lead against its niche version's rules.
 *
 * No evidence, no points: a signal whose rule finds nothing, or only blank evidence, is left out.
 * Each signal counts once. Does not read or write anything.
 * @param facts - What is known about the lead.
 * @param niche - The niche version's weights, thresholds, category keywords and premium areas.
 * @returns The signals with points, the total, the breakdown and the tier.
 * @throws Error when the weights name a signal that has no rule (a niche file and code out of step).
 */
export function scoreLead(facts: LeadFacts, niche: NicheRules): ScoreResult {
  const signals: ScoredSignal[] = [];
  const breakdown = { pain: 0, fit: 0, reachability: 0, abilityToPay: 0 };
  for (const [dimension, group] of Object.entries(niche.signalWeights) as [
    Dimension,
    NicheRules['signalWeights'][Dimension],
  ][]) {
    for (const [key, { points }] of Object.entries(group)) {
      if (!hasRule(key)) throw new Error(`No scoring rule for signal ${key}`);
      const finding = SIGNAL_RULES[key](facts, niche);
      const evidence = finding?.evidence.trim() ?? '';
      if (finding === null || evidence === '') continue;
      signals.push({
        key,
        dimension,
        points,
        evidence,
        sourceUrl: finding.sourceUrl ?? null,
        reviewId: finding.reviewId ?? null,
      });
      breakdown[BREAKDOWN_KEY[dimension]] += points;
    }
  }
  const total = signals.reduce((sum, signal) => sum + signal.points, 0);
  return { signals, total, breakdown, tier: tierFor(total, niche.tiers) };
}
