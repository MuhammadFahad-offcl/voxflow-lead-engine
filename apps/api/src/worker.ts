/**
 * Entry point of the worker process: same env and providers as the API, no HTTP server.
 *
 * Does not run provider lifecycle hooks (`onModuleInit`, `onModuleDestroy`): HazelJS runs those
 * only from `listen()`, which the worker never calls. Start worker work from this file instead.
 *
 * Serves: docs/architecture.md §2 and §9 (second process from one codebase), NFR-10.
 * Used by: the `worker` and `dev:worker` scripts in apps/api/package.json (compiled dist/worker.js).
 */
import { createApp, loadEnvOrExit, registerPrismaShutdown } from './bootstrap.js';
import { DiscoveryRepository } from './db/discovery.repository.js';
import { LOGGER, type Logger } from './logging/logger.js';
import { AREAS_DIR, loadAreaPolygons } from './pipeline/area-polygons.js';
import { LEAD_SOURCE, type LeadSourcePort } from './ports/lead-source.port.js';
import { startCampaignRunner } from './scheduler/campaign-runner.js';

const env = loadEnvOrExit(process.env);
// Before createApp: HazelJS swallows startup errors, and a bad area file must stop the worker here.
const polygons = loadAreaPolygons(AREAS_DIR);
const app = await createApp(env);
const container = app.getContainer();
const logger = container.resolve<Logger>(LOGGER);

registerPrismaShutdown(app);
// The API gets these from listen(); on SIGINT/SIGTERM they run the handlers above, then exit 0.
app.getShutdownManager().setupSignalHandlers();

// Its timer also keeps the process alive; shutdown always ends with process.exit.
startCampaignRunner({
  repository: container.resolve(DiscoveryRepository),
  leadSource: container.resolve<LeadSourcePort>(LEAD_SOURCE),
  polygons,
  logger,
  now: () => new Date(),
});

logger.info('worker started');
