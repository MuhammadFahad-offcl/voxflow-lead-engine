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
import { PrismaProvider } from './db/prisma.provider.js';
import { LOGGER, type Logger } from './logging/logger.js';
import { AREAS_DIR, loadAreaPolygons } from './pipeline/area-polygons.js';
import { PaidStartGate } from './pipeline/paid-start-gate.js';
import { LEAD_SOURCE, type LeadSourcePort } from './ports/lead-source.port.js';
import { LLM, type LlmPort } from './ports/llm.port.js';
import { WEB_CONTEXT, type WebContextPort } from './ports/web-context.port.js';
import { WEB_READER, type WebReaderPort } from './ports/web-reader.port.js';
import { registerRunnerShutdown, startCampaignRunner } from './scheduler/campaign-runner.js';
import {
  buildLeadRunnerDeps,
  registerLeadRunnerShutdown,
  startLeadRunner,
} from './scheduler/lead-runner.js';

const env = loadEnvOrExit(process.env);
// Before createApp: HazelJS swallows startup errors, and a bad area file must stop the worker here.
const polygons = loadAreaPolygons(AREAS_DIR);
const app = await createApp(env);
const container = app.getContainer();
const logger = container.resolve<Logger>(LOGGER);
const prisma = container.resolve(PrismaProvider);
const discovery = container.resolve(DiscoveryRepository);
const leadSource = container.resolve<LeadSourcePort>(LEAD_SOURCE);
const now = () => new Date();

// Its timer also keeps the process alive; shutdown always ends with process.exit.
const stopRunner = startCampaignRunner({
  repository: discovery,
  leadSource,
  polygons,
  logger,
  now,
  startGate: new PaidStartGate(),
});

// One AgentGraph run per lead (#15), on HazelJS's SQL durable run store.
const stopLeadRunner = startLeadRunner(
  buildLeadRunnerDeps({
    prisma,
    leadSource,
    webReader: container.resolve<WebReaderPort>(WEB_READER),
    webContext: container.resolve<WebContextPort>(WEB_CONTEXT),
    llm: container.resolve<LlmPort>(LLM),
    logger,
    now,
    concurrency: env.LEAD_RUNNER_CONCURRENCY,
    startGate: new PaidStartGate(),
  }),
);

// In this order: both runners may still need the database to save a paid run's id.
registerRunnerShutdown(app, stopRunner, logger);
registerLeadRunnerShutdown(app, stopLeadRunner, logger);
registerPrismaShutdown(app);
// The API gets these from listen(); on SIGINT/SIGTERM they run the handlers above, then exit 0.
app.getShutdownManager().setupSignalHandlers();

logger.info('worker started');
