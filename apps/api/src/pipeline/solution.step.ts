/**
 * The lead graph's SOLUTION step: runs the solution agent for a WARM or HOT lead and stores its
 * pick as a Solution, or its exit status (NO_STRONG_SIGNAL, NEEDS_REVIEW).
 *
 * Serves: FR-17, US-5, FR-33 (a spend cap pauses the step, the lead waits); issue #19.
 * Used by: solution.step.spec.ts; the lead graph's SOLUTION node (#19, the PR after this one).
 */
import type { SolutionOutcome } from '../agents/solution.agent.js';
import type { SolutionRepository, StoredSolutionLead } from '../db/solution.repository.js';
import { SpendCapReachedError } from '../llm/llm.service.js';
import type { Logger } from '../logging/logger.js';

/** What the step needs. */
export interface SolutionStepDeps {
  solutions: Pick<SolutionRepository, 'forSolution' | 'saveOutcome'>;
  /** Runs the solution agent: `runSolutionAgent` on the lead graph's runtime. */
  solve: (lead: StoredSolutionLead) => Promise<SolutionOutcome>;
  logger: Logger;
}

/** What the step did; it goes in the graph's checkpoint. */
export type SolutionStepOutcome =
  | { status: 'SOLVED'; serviceSlug: string }
  | { status: 'NO_STRONG_SIGNAL' | 'NEEDS_REVIEW' }
  | { status: 'SKIPPED'; reason: 'NOT_ELIGIBLE' | 'ALREADY_SOLVED' }
  | { status: 'CAP_REACHED'; reason: string };

/**
 * Picks the one catalog service for a scored WARM or HOT lead and stores the result.
 *
 * Safe to repeat: a lead that already has a Solution, or has left SCORED, is skipped, so a resumed
 * or retried run never pays twice for a stored answer. The agent gets the lead's own ids, so every
 * model call's cost record names the lead and its campaign (FR-33, NFR-4).
 * Does not change a picked lead's status: it stays SCORED until its script (#20).
 * @param deps - What the step needs.
 * @param leadId - `Lead.id`.
 * @returns What was stored; CAP_REACHED when a spend cap stopped the agent, with nothing stored.
 * @throws Prisma errors; the agent's errors other than a reached cap (an LLM or embedder outage),
 * which fail the lead (FR-32).
 */
export async function solveLead(
  deps: SolutionStepDeps,
  leadId: string,
): Promise<SolutionStepOutcome> {
  const { solutions, solve, logger } = deps;
  const { status, solved, ...lead } = await solutions.forSolution(leadId);
  if (status !== 'SCORED' || lead.tier === 'COLD') {
    return { status: 'SKIPPED', reason: 'NOT_ELIGIBLE' };
  }
  if (solved) return { status: 'SKIPPED', reason: 'ALREADY_SOLVED' };

  let outcome: SolutionOutcome;
  try {
    outcome = await solve(lead);
  } catch (error) {
    if (!(error instanceof SpendCapReachedError)) throw error;
    logger.warn({ leadId }, 'spend cap reached; solution not picked');
    return { status: 'CAP_REACHED', reason: error.reason };
  }
  const costUsd = outcome.costUsd.toFixed(5);
  if (outcome.kind === 'pick') {
    const { serviceSlug, reason, signalKeys, model } = outcome;
    await solutions.saveOutcome(lead, { kind: 'pick', serviceSlug, reason, signalKeys, model });
    logger.info({ leadId, serviceSlug, costUsd }, 'solution stored');
    return { status: 'SOLVED', serviceSlug };
  }
  const exit = outcome.kind === 'noStrongSignal' ? 'NO_STRONG_SIGNAL' : 'NEEDS_REVIEW';
  await solutions.saveOutcome(lead, { kind: 'exit', status: exit });
  logger.info({ leadId, status: exit, costUsd }, 'solution step ended without a pick');
  return { status: exit };
}
