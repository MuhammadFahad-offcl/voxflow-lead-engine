/**
 * Integration test of the campaigns API against a migrated database that was never seeded.
 *
 * Serves: FR-1; the founder decision that an unseeded database answers 503 (issue #8).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { HazelApp } from '@hazeljs/core';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let app: HazelApp;
let baseUrl: string;

// `migrate deploy` starts a process and can download the schema engine on a fresh machine.
beforeAll(async () => {
  const url = await createTestDatabase('voxflow_unseeded_test');
  app = await startServer(testEnv({ DATABASE_URL: url }), 0);
  const address = app.getServer()?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('API server is not listening on a TCP port');
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
}, 120_000);

afterAll(async () => {
  await app.close();
  await app.getContainer().resolve(PrismaProvider).$disconnect();
});

// Proves the API tells the operator to seed instead of failing with a 500.
describe('campaigns API without a seeded organization', () => {
  it('answers 503 with "run pnpm db:seed"', async () => {
    const response = await fetch(`${baseUrl}/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nicheSlug: 'dental-clinic', city: 'Lahore', areas: ['DHA'] }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      message: 'No organization found: run pnpm db:seed',
    });
  });
});
