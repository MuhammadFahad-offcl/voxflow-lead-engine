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
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  logger.info('seed done: organization, settings, dental-clinic niche v1, service catalog');
} finally {
  await prisma.$disconnect();
}
