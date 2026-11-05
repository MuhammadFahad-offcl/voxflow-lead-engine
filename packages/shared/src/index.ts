/**
 * Zod schemas and inferred types shared by the API and the dashboard.
 *
 * Serves: ADR-0001 (one set of Zod schemas), NFR-8 (issue #3, monorepo scaffold).
 * Used by: apps/web/app/page.tsx, apps/api/test/server.int.spec.ts, apps/api/src/db/seed.ts,
 * apps/api/src/modules/campaigns/.
 */
import { z } from 'zod';

/**
 * Body of HazelJS's built-in liveness probe, `GET /health`.
 *
 * Does not cover `GET /ready`, and does not report database, tunnel or worker status (NFR-10).
 */
export const HealthResponse = z.object({
  status: z.literal('alive'),
  timestamp: z.iso.datetime(),
});
/** Parsed `GET /health` body. Shares the schema's name so one import gives both. */
export type HealthResponse = z.infer<typeof HealthResponse>;

export { Booking, CallingHours, DEFAULT_SETTINGS, LlmModels, SpendCaps } from './settings.js';
export { CatalogFile, IdealClient, NicheFile } from './niche.js';
export { CampaignSummary, CreateCampaignInput } from './campaign.js';
