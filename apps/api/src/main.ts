import { z } from 'zod';
import { startServer } from './server.js';

// Moves into src/config/ with the full env schema in #6.
const ServerEnv = z.object({
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
});

const env = ServerEnv.parse(process.env);
await startServer(env.API_HOST, env.API_PORT);
