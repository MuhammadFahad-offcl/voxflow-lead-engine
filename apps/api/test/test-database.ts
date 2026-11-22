/**
 * Creates a throwaway database, one per integration spec, with every migration applied.
 *
 * Serves: ADR-0002 (issue #5, database setup).
 * Used by: the integration specs in apps/api/test/.
 */
import { createScratchDatabase } from '../src/db/scratch-database.js';
import { testEnv } from './test-env.js';

/**
 * Builds a fresh test database on the server named by DATABASE_URL and applies every migration.
 *
 * Does not change the database in DATABASE_URL: only `name` is dropped and created, so local
 * development data stays. Give each spec its own name: Jest runs spec files in parallel, and the
 * forced drop would cut another spec's connections to the same database.
 * @param name - Database to (re)create; lowercase letters and underscores, e.g. "voxflow_test".
 * @returns The connection URL of the test database.
 * @throws InvalidEnvError (synchronously) when DATABASE_URL is missing; a rejection with Error when
 * `name` is not lowercase letters and underscores or is the database DATABASE_URL names, or with
 * an error from Postgres or `prisma migrate deploy`.
 */
export function createTestDatabase(name = 'voxflow_test'): Promise<string> {
  return createScratchDatabase(testEnv().DATABASE_URL, name);
}
