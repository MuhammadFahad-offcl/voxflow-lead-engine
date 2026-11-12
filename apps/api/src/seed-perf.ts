/**
 * Entry point of `pnpm seed:perf`: adds one campaign of 5,000 fictional, already-scored leads to
 * the database in DATABASE_URL, to time the dashboard against NFR-3. Run `pnpm db:seed` first.
 *
 * Serves: NFR-3, FR-30; issue #16.
 * Used by: the `seed:perf` script in package.json.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { loadEnvOrExit } from './bootstrap.js';
import { seedPerfCampaign } from './db/seed-perf.js';
import { PrismaClient } from './generated/prisma/client.js';
import { createLogger } from './logging/logger.js';

// C1-14: "page loads < 2 s with 5,000 seeded leads".
const LEADS = 5000;

const env = loadEnvOrExit(process.env);
const logger = createLogger(env.LOG_LEVEL);
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
try {
  const result = await seedPerfCampaign(prisma, LEADS);
  logger.info(
    result,
    result.added
      ? `seed:perf added ${String(result.leads)} fictional leads; open /campaigns/${result.campaignId}`
      : `seed:perf already done; open /campaigns/${result.campaignId}`,
  );
} finally {
  await prisma.$disconnect();
}
