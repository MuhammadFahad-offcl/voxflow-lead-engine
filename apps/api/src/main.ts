/**
 * Entry point of the API process: reads the bind address from the environment, starts the server.
 *
 * Serves: ADR-0003 (127.0.0.1 by default), NFR-8 (issue #3, monorepo scaffold).
 * Used by: the `dev:start` script in apps/api/package.json, which runs the compiled dist/main.js.
 */
import { z } from 'zod';
import { startServer } from './server.js';

// Moves into src/config/ with the full env schema in #6.
const ServerEnv = z.object({
  API_HOST: z.string().min(1).default('127.0.0.1'),
  // Environment values are always strings, so the port has to be coerced.
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
});

const env = ServerEnv.parse(process.env);
await startServer(env.API_HOST, env.API_PORT);
