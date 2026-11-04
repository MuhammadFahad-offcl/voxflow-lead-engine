/**
 * Creates a throwaway database, one per integration spec, with every migration applied.
 *
 * Serves: ADR-0002 (issue #5, database setup).
 * Used by: apps/api/test/db.int.spec.ts, apps/api/test/seed.int.spec.ts.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { testEnv } from './test-env.js';

const repoRoot = resolve(import.meta.dirname, '../../..');

/**
 * Builds a fresh test database on the server named by DATABASE_URL and applies every migration.
 *
 * Does not change the database in DATABASE_URL: only `name` is dropped and created, so local
 * development data stays. Give each spec its own name: Jest runs spec files in parallel, and the
 * forced drop would cut another spec's connections to the same database.
 * @param name - Database to (re)create; lowercase letters and underscores, e.g. "voxflow_test".
 * @returns The connection URL of the test database.
 * @throws Error when `name` is not lowercase letters and underscores; InvalidEnvError when DATABASE_URL is missing, or an error from Postgres or `prisma migrate deploy`.
 */
export async function createTestDatabase(name = 'voxflow_test'): Promise<string> {
  // A database name cannot be a query parameter, so it is checked before going into the SQL.
  if (!/^[a-z_]+$/.test(name)) throw new Error(`Invalid test database name: ${name}`);
  const { DATABASE_URL } = testEnv();
  const server = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
  try {
    // Dropped first so every run proves the migrations apply to an empty database.
    await server.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await server.$executeRawUnsafe(`CREATE DATABASE ${name}`);
  } finally {
    await server.$disconnect();
  }

  const testUrl = new URL(DATABASE_URL);
  testUrl.pathname = `/${name}`;
  // The CLI's own entry file: `pnpm` is a .cmd file on Windows, which execFileSync cannot start.
  execFileSync(
    process.execPath,
    [resolve(repoRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { cwd: repoRoot, env: { ...process.env, DATABASE_URL: testUrl.href }, stdio: 'pipe' },
  );
  return testUrl.href;
}
