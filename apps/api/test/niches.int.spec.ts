/**
 * Integration tests of `GET /niches` over HTTP on a seeded test database: the newest version of
 * each niche, with its search-term count and the area quick picks the seed stored (niche v5).
 *
 * Serves: FR-1, FR-4; issue #16.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { HazelApp } from '@hazeljs/core';
import { NicheSummary } from '@voxflow/shared';
import { resolve } from 'node:path';
import { z } from 'zod';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let app: HazelApp;
let prisma: PrismaProvider;
let baseUrl: string;

const niches = async () => {
  const response = await fetch(`${baseUrl}/niches`);
  return { status: response.status, body: z.array(NicheSummary).parse(await response.json()) };
};

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_niches_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
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

// Proves the new-campaign form gets each niche's newest version, with what the seed stored.
describe('GET /niches', () => {
  it('lists nothing before the seed', async () => {
    expect(await niches()).toEqual({ status: 200, body: [] });
  });

  it('lists dental-clinic v5 with its search-term count and default areas after the seed', async () => {
    await seed(prisma, resolve(import.meta.dirname, '../../../config'));

    expect((await niches()).body).toEqual([
      {
        slug: 'dental-clinic',
        name: 'Dental clinics',
        version: 5,
        searchTermCount: 4,
        defaultAreas: ['DHA', 'Gulberg', 'Model Town', 'Johar Town', 'Bahria Town'],
      },
    ]);
  });

  it('shows only the newest version when older ones are stored', async () => {
    const newest = await prisma.nicheProfile.findFirstOrThrow({ where: { version: 5 } });
    // An older version, stored before defaultAreas existed: it must not appear.
    await prisma.nicheProfile.create({
      data: {
        organizationId: SEED_ORGANIZATION_ID,
        slug: newest.slug,
        version: 1,
        name: 'Fictional old version',
        searchTerms: ['old term'],
        idealClient: {},
        signalWeights: {},
        tiers: { hot: 70, warm: 45 },
        scriptTemplate: 'Fictional template',
      },
    });

    expect((await niches()).body.map((niche) => niche.version)).toEqual([5]);
  });
});
