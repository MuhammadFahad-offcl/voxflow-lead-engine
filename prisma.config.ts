/**
 * Prisma 7 CLI config: schema path, migrations path and the database connection URL.
 *
 * Serves: ADR-0002 (issue #5, Prisma 7 config).
 * Used by: the Prisma CLI, for example `pnpm prisma migrate dev` (docs/database.md).
 */
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Tells the Prisma CLI where the schema and migrations live and which database to use.
 *
 * Does not open a connection or run migrations: only Prisma CLI commands do that.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
