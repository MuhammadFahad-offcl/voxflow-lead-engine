/**
 * Entry point of the worker process: same env and DI as the API, no HTTP server.
 *
 * Serves: docs/architecture.md §2 and §9 (second process from one codebase), NFR-10.
 * Used by: the `worker` and `dev:worker` scripts in apps/api/package.json (compiled dist/worker.js).
 */
import { createApp, loadEnvOrExit, registerPrismaShutdown } from './bootstrap.js';
import { LOGGER, type Logger } from './logging/logger.js';

const env = loadEnvOrExit(process.env);
const app = await createApp(env);
const logger = app.getContainer().resolve<Logger>(LOGGER);

// Nothing else keeps the event loop busy until the first worker loop exists (#15), so the process
// would exit at once. Cleared on shutdown.
const keepAlive = setInterval(() => undefined, 2 ** 30);
app.registerShutdownHandler({
  name: 'keep-alive',
  handler: () => {
    clearInterval(keepAlive);
    return Promise.resolve();
  },
});
registerPrismaShutdown(app);
// The API gets these from listen(); on SIGINT/SIGTERM they run the handlers above, then exit 0.
app.getShutdownManager().setupSignalHandlers();

logger.info('worker started');
