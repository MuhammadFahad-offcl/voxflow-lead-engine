/**
 * Integration test of `GET /costs/status` on a real server and its own seeded database: the month's
 * LLM spend, the cap, and when calls are blocked.
 *
 * Serves: FR-33 (the cap banner), NFR-4; issue #13.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import type { HazelApp } from '@hazeljs/core';
import { CostsStatus } from '@voxflow/shared';
import { resolve } from 'node:path';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { karachiMonthStart } from '../src/pipeline/spend-cap.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let app: HazelApp;
let prisma: PrismaProvider;
let baseUrl = '';

const status = async () => {
  const response = await fetch(`${baseUrl}/costs/status`);
  return { code: response.status, body: await response.json() };
};
const spend = (amountUsd: string, at: Date, service: 'LLM' | 'APIFY' = 'LLM') =>
  prisma.costRecord.create({
    data: { organizationId: SEED_ORGANIZATION_ID, service, amountUsd, at },
  });

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_costs_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
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
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.costRecord.deleteMany();
});

// Proves the banner data: only this Karachi month's LLM spend counts, and blocked means cap reached.
describe('GET /costs/status', () => {
  it('sums only this month LLM spend against the $10.00 cap', async () => {
    const monthStart = karachiMonthStart(new Date());
    await spend('0.00062', new Date());
    await spend('0.00113', monthStart);
    await spend('9.99000', new Date(monthStart.getTime() - 1_000));
    await spend('1.50000', new Date(), 'APIFY');

    const { code, body } = await status();

    expect(code).toBe(200);
    expect(CostsStatus.parse(body)).toEqual({
      llm: {
        spentUsd: '0.00175',
        capUsd: '10.00',
        blocked: false,
        monthStart: monthStart.toISOString(),
      },
    });
  });

  // The gate refuses a call whose worst case (under a cent for every v1 call) does not fit, so
  // the banner turns on once less than a cent is left, before the spend reaches the cap exactly.
  it('reports blocked once less than a cent of the cap is left', async () => {
    await spend('9.99000', new Date());
    expect(CostsStatus.parse((await status()).body).llm.blocked).toBe(false);

    await spend('0.00001', new Date());

    expect(CostsStatus.parse((await status()).body).llm).toMatchObject({
      spentUsd: '9.99001',
      blocked: true,
    });
  });
});
