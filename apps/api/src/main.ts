/**
 * Entry point of the API process: validates the environment, then starts the server.
 *
 * Serves: ADR-0003, ADR-0013 (127.0.0.1 by default), docs/architecture.md §12, NFR-8.
 * Used by: the `dev:start` script in apps/api/package.json, which runs the compiled dist/main.js.
 */
import { loadEnvOrExit } from './bootstrap.js';
import { exitIfPortTaken } from './port-check.js';
import { startServer } from './server.js';

// Before anything HazelJS builds: it would swallow a validation error (see startServer).
const env = loadEnvOrExit(process.env);
// Also before HazelJS: its listen() turns a taken port into an uncaught exception.
await exitIfPortTaken(env);
await startServer(env, env.API_PORT);
