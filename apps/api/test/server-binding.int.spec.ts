/**
 * Integration test of where the API listens: started with the default configuration, its socket is
 * bound to 127.0.0.1 only, never to every interface.
 *
 * Serves: ADR-0003 (everything but the three Vapi paths binds to 127.0.0.1), NFR-5; T-1 audit.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { HazelApp } from '@hazeljs/core';
import { loadEnv } from '../src/config/env.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';

let app: HazelApp;

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_server_binding_test');
  // No API_HOST given: the default must be loopback.
  const env = loadEnv({
    DATABASE_URL: url,
    DEMO_MODE: 'true',
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
  });
  app = await startServer(env, 0);
}, 120_000);

afterAll(async () => {
  await app.close();
  await app.getContainer().resolve(PrismaProvider).$disconnect();
});

// Proves ADR-0003: the API is reachable from this laptop only.
describe('API socket', () => {
  it('listens on 127.0.0.1, not on every interface', () => {
    const address = app.getServer()?.address();

    expect(typeof address === 'object' && address !== null ? address.address : address).toBe(
      '127.0.0.1',
    );
  });
});
