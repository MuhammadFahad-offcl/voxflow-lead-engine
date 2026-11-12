/**
 * The API's 400 answer, as a schema with no other import: safe for client components, which must
 * never pull in the server-side API client (lib/api.ts).
 *
 * Serves: FR-1 (form messages per field), FR-30 (refused filters), ADR-0003 (the browser never
 * calls the API); T-1 audit.
 * Used by: apps/web/lib/campaign-form.ts, apps/web/lib/lead-table.ts.
 */
import { z } from 'zod';

/** The API's 400 body: one entry per refused field, with its messages. */
export const ApiRefusal = z.object({
  errors: z.array(z.object({ field: z.string(), messages: z.array(z.string()) })),
});
