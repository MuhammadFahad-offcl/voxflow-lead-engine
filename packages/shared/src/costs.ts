/**
 * The spend status the dashboard reads for its cap banner.
 *
 * Serves: FR-33 (reaching a cap pauses that step and shows a banner), NFR-4; issue #13.
 * Used by: apps/api/src/modules/costs/, apps/api/test/costs.int.spec.ts; will be used by the
 * dashboard banner (#16).
 */
import { z } from 'zod';

// Money is never a float (CLAUDE.md). Spend has 5 decimals, so this is looser than the 2-decimal
// setting amounts in settings.ts.
const DecimalUsd = z.string().regex(/^\d+\.\d+$/, 'US dollars as a decimal string');

/** `GET /costs/status`: this Asia/Karachi month's LLM spend against the monthly cap. */
export const CostsStatus = z.object({
  llm: z.object({
    /** LLM spend recorded this month, e.g. "0.01234". */
    spentUsd: DecimalUsd,
    /** `Settings.spendCaps.llmMonthlyUsd`, e.g. "10.00". */
    capUsd: DecimalUsd,
    /**
     * True once less than one cent of the cap is left: LLM calls are refused (or about to be) until
     * the month turns or the cap is raised.
     */
    blocked: z.boolean(),
    /** When the counted month began: midnight on the 1st in Karachi, as UTC. */
    monthStart: z.iso.datetime(),
  }),
});
/** Parsed `GET /costs/status` body. */
export type CostsStatus = z.infer<typeof CostsStatus>;
