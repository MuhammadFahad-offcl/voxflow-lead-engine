/**
 * The solution agent's answer rules (FR-17): the picked service is one searchCatalog returned
 * (so it is active and in the catalog), every cited signal is the lead's own, and at least one
 * is a PAIN signal. Pure: the agent runner supplies what the run retrieved and the lead's signals.
 *
 * Serves: FR-17, US-5; issue #19.
 * Used by: apps/api/src/agents/solution.agent.ts.
 */

/** What a pick is checked against. */
export interface SolutionCheckContext {
  /** The slugs searchCatalog returned in this run, closest first; empty when it was not called. */
  retrievedSlugs: string[];
  /** The lead's evidenced signals (points > 0): key and dimension, e.g. PAIN. */
  leadSignals: { key: string; dimension: string }[];
}

/** A pick to check: the service and the signal keys it cites. */
export interface SolutionPick {
  serviceSlug: string;
  signalIds: string[];
}

/** Valid, or every problem in words for the retry prompt. */
export type SolutionCheck = { ok: true } | { ok: false; problems: string[] };

/**
 * Checks a pick against FR-17's rules.
 *
 * Does not check the reason or the answer's shape: the answer schema did.
 * @param pick - The service slug and the cited signal keys.
 * @param context - What this run retrieved and the lead's signals.
 * @returns `{ ok: true }`, or every broken rule as one sentence each.
 */
export function checkSolutionPick(
  pick: SolutionPick,
  context: SolutionCheckContext,
): SolutionCheck {
  const { retrievedSlugs, leadSignals } = context;
  if (retrievedSlugs.length === 0) {
    return {
      ok: false,
      problems: ['searchCatalog was not called: call it before picking a service.'],
    };
  }
  const problems: string[] = [];
  if (!retrievedSlugs.includes(pick.serviceSlug)) {
    problems.push(
      `serviceSlug "${pick.serviceSlug}" is not one of the services searchCatalog returned: ${retrievedSlugs.join(', ')}.`,
    );
  }
  const keys = leadSignals.map(({ key }) => key);
  for (const id of pick.signalIds.filter((signal) => !keys.includes(signal))) {
    problems.push(`signal "${id}" is not one of this lead’s signals: ${keys.join(', ')}.`);
  }
  const pain = leadSignals.filter(({ dimension }) => dimension === 'PAIN').map(({ key }) => key);
  if (!pick.signalIds.some((id) => pain.includes(id))) {
    problems.push(
      `no PAIN signal is cited; cite at least one of: ${pain.join(', ') || '(none)'}. If none fits, answer noStrongSignal.`,
    );
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
