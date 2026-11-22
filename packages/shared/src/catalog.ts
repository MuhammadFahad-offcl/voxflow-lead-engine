/**
 * The service catalog as the API returns it: every service, without its vector.
 *
 * Serves: FR-16 (catalog of services, searched by similarity); issue #17.
 * Used by: apps/api/src/db/catalog.repository.ts, apps/api/src/modules/catalog/,
 * apps/api/test/catalog.int.spec.ts.
 */
import { z } from 'zod';

/** One catalog service. Does not include the 1024-number embedding, only whether it has one. */
export const ServiceSummary = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  nameUrdu: z.string(),
  problem: z.string(),
  fittingSignals: z.array(z.string()),
  expectedResult: z.string(),
  expectedResultUrdu: z.string(),
  // Retired services stay listed but are never returned by search (FR-16).
  active: z.boolean(),
  // False until `pnpm db:seed` has embedded it; search skips it until then.
  embedded: z.boolean(),
});
/** Parsed catalog service. Shares the schema's name so one import gives both. */
export type ServiceSummary = z.infer<typeof ServiceSummary>;
