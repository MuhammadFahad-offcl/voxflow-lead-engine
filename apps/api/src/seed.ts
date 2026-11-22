/**
 * Entry point of `pnpm db:seed`: validates the environment, seeds, embeds missing services,
 * disconnects.
 *
 * Serves: FR-4, FR-16; issue #7, issue #17.
 * Used by: `migrations.seed` in prisma.config.ts, which `prisma db seed` runs through tsx.
 */
import { resolve } from 'node:path';
import { createApp, loadEnvOrExit } from './bootstrap.js';
import { PrismaProvider } from './db/prisma.provider.js';
import { embedMissingServices, seed } from './db/seed.js';
import { LOGGER, type Logger } from './logging/logger.js';
import { EMBEDDING, type EmbeddingPort } from './ports/embedding.port.js';

const env = loadEnvOrExit(process.env);
// The app's container, so DEMO_MODE binds the embedder here exactly as in the API and worker.
const container = (await createApp(env)).getContainer();
const logger = container.resolve<Logger>(LOGGER);
const prisma = container.resolve(PrismaProvider);
try {
  const niche = await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  await embedMissingServices(prisma, {
    embedder: container.resolve<EmbeddingPort>(EMBEDDING),
    logger,
  });
  // The version comes from the niche file, so the line says which rules new campaigns get.
  const state = niche.added ? 'added' : 'already stored';
  logger.info(
    { niche: niche.slug, version: niche.version, state },
    `seed done: organization, settings, ${niche.slug} niche v${String(niche.version)} (${state}), service catalog`,
  );
} finally {
  await prisma.$disconnect();
}
