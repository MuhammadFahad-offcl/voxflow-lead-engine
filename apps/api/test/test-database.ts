/**
 * Creates the "voxflow_test" database that integration tests run against.
 *
 * Serves: ADR-0002 (issue #5, database setup).
 * Used by: apps/api/test/db.int.spec.ts.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { z } from 'zod';
import { PrismaClient } from '../src/generated/prisma/client.js';

const repoRoot = resolve(import.meta.dirname, '../../..');

/**
 * Builds a fresh test database on the server named by DATABASE_URL and applies every migration.
 *
 * Does not change the database in DATABASE_URL: only "voxflow_test" is dropped and created, so local
 * development data stays.
 * @returns The connection URL of the test database.
 * @throws ZodError when DATABASE_URL is missing, or an error from Postgres or `prisma migrate deploy`.
 */
export async function createTestDatabase(): Promise<string> {
  const { DATABASE_URL } = z.object({ DATABASE_URL: z.url() }).parse(process.env);
  const server = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
  try {
    // Dropped first so every run proves the migrations apply to an empty database.
    await server.$executeRaw`DROP DATABASE IF EXISTS voxflow_test WITH (FORCE)`;
    await server.$executeRaw`CREATE DATABASE voxflow_test`;
  } finally {
    await server.$disconnect();
  }

  const testUrl = new URL(DATABASE_URL);
  testUrl.pathname = '/voxflow_test';
  // The CLI's own entry file: `pnpm` is a .cmd file on Windows, which execFileSync cannot start.
  execFileSync(
    process.execPath,
    [resolve(repoRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { cwd: repoRoot, env: { ...process.env, DATABASE_URL: testUrl.href }, stdio: 'pipe' },
  );
  return testUrl.href;
}
