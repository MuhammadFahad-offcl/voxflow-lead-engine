/**
 * Prisma 7 CLI config: schema path, migrations path, seed command and the database connection URL.
 *
 * Serves: ADR-0002 (issue #5, Prisma 7 config), FR-4 (seed, issue #7).
 * Used by: the Prisma CLI, for example `pnpm prisma migrate dev` (docs/database.md).
 */
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma's env() throws when the variable is unset, which would stop every command, generate
// included. Undefined lets the config load; commands that connect then report the missing URL.
const databaseUrl = (): string | undefined => {
  try {
    return env('DATABASE_URL');
  } catch {
    return undefined;
  }
};

/**
 * Tells the Prisma CLI where the schema and migrations live and which database to use.
 *
 * Does not open a connection or run migrations: only Prisma CLI commands do that.
 * Does not require DATABASE_URL to load: `prisma generate` (run on every `pnpm install`) needs no
 * database, so a fresh clone installs before `.env` exists. Commands that connect still fail
 * without it, and the seed names the missing variable.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // tsx, because the generated client's imports end in .js and point at .ts files; the api
    // tsconfig, because the startup code it shares with the API uses decorators.
    seed: 'tsx --tsconfig apps/api/tsconfig.json apps/api/src/seed.ts',
  },
  datasource: {
    url: databaseUrl(),
  },
});
