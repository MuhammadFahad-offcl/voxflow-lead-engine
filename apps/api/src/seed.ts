/**
 * Entry point of `pnpm db:seed`: validates the environment, seeds, disconnects.
 *
 * Serves: FR-4, issue #7.
 * Used by: `migrations.seed` in prisma.config.ts, which `prisma db seed` runs through tsx.
 */
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnvOrExit } from './bootstrap.js';
import { seed } from './db/seed.js';
import { PrismaClient } from './generated/prisma/client.js';
import { createLogger } from './logging/logger.js';

const env = loadEnvOrExit(process.env);
const logger = createLogger(env.LOG_LEVEL);

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
try {
  const niche = await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  // The version comes from the niche file, so the line says which rules new campaigns get.
  const state = niche.added ? 'added' : 'already stored';
  logger.info(
    { niche: niche.slug, version: niche.version, state },
    `seed done: organization, settings, ${niche.slug} niche v${String(niche.version)} (${state}), service catalog`,
  );
} finally {
  await prisma.$disconnect();
}
