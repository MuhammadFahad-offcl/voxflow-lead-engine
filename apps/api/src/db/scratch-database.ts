/**
 * Creates and drops throwaway databases next to the one in DATABASE_URL: one per integration spec,
 * and the recorder's scratch database. Never touches the database DATABASE_URL names.
 *
 * Serves: ADR-0002 (issue #5, database setup); FR-36 (recording the demo, issue #19).
 * Used by: apps/api/test/test-database.ts, apps/api/src/llm-record-solution.ts.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');

// A database name cannot be a query parameter, so it is checked before going into the SQL.
const checkedName = (name: string): string => {
  if (!/^[a-z_]+$/.test(name)) throw new Error(`Invalid scratch database name: ${name}`);
  return name;
};

// Runs one statement on the server, connected through the URL's own database.
const onServer = async (serverUrl: string, sql: string[]): Promise<void> => {
  const server = new PrismaClient({ adapter: new PrismaPg({ connectionString: serverUrl }) });
  try {
    for (const statement of sql) await server.$executeRawUnsafe(statement);
  } finally {
    await server.$disconnect();
  }
};

/**
 * Builds a fresh database named `name` on the server of `serverUrl` and applies every migration.
 *
 * Does not change the database in `serverUrl`: only `name` is dropped and created. A forced drop
 * cuts other connections to `name`, so give each user its own name.
 * @param serverUrl - Any connection URL on the server, normally DATABASE_URL.
 * @param name - Database to (re)create; lowercase letters and underscores, e.g. "voxflow_test".
 * @returns The connection URL of the new database.
 * @throws Error when `name` is not lowercase letters and underscores; errors from Postgres or
 * `prisma migrate deploy`.
 */
export async function createScratchDatabase(serverUrl: string, name: string): Promise<string> {
  const database = checkedName(name);
  // Dropped first so every run proves the migrations apply to an empty database.
  await onServer(serverUrl, [
    `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
    `CREATE DATABASE ${database}`,
  ]);
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  // The CLI's own entry file: `pnpm` is a .cmd file on Windows, which execFileSync cannot start.
  execFileSync(
    process.execPath,
    [resolve(repoRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { cwd: repoRoot, env: { ...process.env, DATABASE_URL: url.href }, stdio: 'pipe' },
  );
  return url.href;
}

/**
 * Drops the database named `name` on the server of `serverUrl`, cutting its connections.
 * @param serverUrl - Any connection URL on the server, normally DATABASE_URL.
 * @param name - The scratch database; never the one `serverUrl` names.
 * @throws Error when `name` is invalid or is the database `serverUrl` connects to; errors from
 * Postgres.
 */
export async function dropScratchDatabase(serverUrl: string, name: string): Promise<void> {
  const database = checkedName(name);
  if (new URL(serverUrl).pathname === `/${database}`) {
    throw new Error('Refusing to drop the database DATABASE_URL names');
  }
  await onServer(serverUrl, [`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
}
