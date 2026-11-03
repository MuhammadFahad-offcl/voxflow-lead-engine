import { z } from 'zod';

/** Body of HazelJS's built-in liveness probe, `GET /health`. */
export const HealthResponse = z.object({
  status: z.literal('alive'),
  timestamp: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
