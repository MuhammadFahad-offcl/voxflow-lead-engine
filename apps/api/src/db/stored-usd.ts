/**
 * The one rounding rule for amounts written to `CostRecord.amountUsd`, which keeps 5 decimals.
 *
 * Serves: FR-33 (spend caps), ADR-0006 (LLM and embeddings spend); issue #13, issue #17.
 * Used by: apps/api/src/llm/llm.service.ts, apps/api/src/db/seed.ts.
 */
import { Prisma } from '../generated/prisma/client.js';

/**
 * Rounds a cost up to 5 decimal places.
 *
 * Up, never down: an LLM token or an embeddings batch can cost less than $0.00001, so rounding down
 * would store $0 and the stored spend could sit below the real spend under a hard cap.
 * @param usd - The exact cost, in US dollars.
 * @returns The amount to store: at least $0.00001 for any cost above 0.
 */
export const toStoredUsd = (usd: Prisma.Decimal): Prisma.Decimal =>
  usd.toDecimalPlaces(5, Prisma.Decimal.ROUND_UP);
