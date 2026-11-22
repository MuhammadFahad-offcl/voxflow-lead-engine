/**
 * What the solution agent answers: one catalog service for the lead's biggest evidenced pain, or
 * that the lead has no strong signal.
 *
 * Serves: FR-17, US-5; issue #19.
 * Used by: apps/api/src/agents/solution.agent.ts, apps/api/src/agents/solution-validation.ts.
 */
import { z } from 'zod';

// One sentence for the founder's dashboard; English, so the length is in characters.
const Reason = z.string().min(1).max(200);

/** The agent's answer: a pick that cites the lead's signals, or no strong signal. */
export const SolutionAnswer = z.union([
  z.strictObject({
    serviceSlug: z.string().regex(/^[a-z0-9-]+$/),
    reason: Reason,
    // Signal keys from the lead's own signals, e.g. "phone_unanswered_reviews" (FR-17).
    signalIds: z.array(z.string().min(1)).min(1).max(4),
  }),
  z.strictObject({ noStrongSignal: z.literal(true), reason: Reason }),
]);
/** Parsed answer. Shares the schema's name so one import gives both. */
export type SolutionAnswer = z.infer<typeof SolutionAnswer>;
