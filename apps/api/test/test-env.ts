/**
 * The fixed environment every test runs with: demo mode, no service keys, error-only logs.
 *
 * Serves: ADR-0007 (tests never call paid services), NFR-5, NFR-9.
 * Used by: apps/api/test/*.int.spec.ts, apps/api/test/test-database.ts, apps/api/test/test-env.spec.ts.
 */
import { loadEnv, type Env } from '../src/config/env.js';

/**
 * Builds a test `Env` from fixed values plus DATABASE_URL.
 *
 * Does not copy anything else from process.env, so a live key that `--env-file-if-exists=.env`
 * (or HazelJS's own dotenv call) put there never reaches the `Env` a test builds.
 * @param overrides - Values to change for one test, as strings like in a real environment.
 * @returns The parsed configuration.
 * @throws InvalidEnvError when DATABASE_URL is not set: start Postgres and set it, as CI does.
 */
export function testEnv(overrides: Readonly<Record<string, string>> = {}): Env {
  return loadEnv({
    DEMO_MODE: 'true',
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    DATABASE_URL: process.env['DATABASE_URL'],
    ...overrides,
  });
}
