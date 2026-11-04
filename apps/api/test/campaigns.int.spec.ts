/**
 * Integration test of the campaigns API on a real server and its own migrated database.
 *
 * Serves: FR-1, FR-2; issue #8 acceptance criteria (create; reads follow in part 2b).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { HazelApp } from '@hazeljs/core';
import { PrismaPg } from '@prisma/adapter-pg';
import { CampaignSummary } from '@voxflow/shared';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let app: HazelApp;
let prisma: PrismaClient;
let baseUrl: string;

const call = async (method: 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const create = (body: unknown) => call('POST', '/campaigns', body);

// `migrate deploy` starts a process and can download the schema engine on a fresh machine.
beforeAll(async () => {
  const url = await createTestDatabase('voxflow_campaigns_test');
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  // Fictional data, shaped like the seed: one organization and a niche with 4 search terms.
  const organization = await prisma.organization.create({ data: { name: 'Fictional Org' } });
  const niche = {
    organizationId: organization.id,
    slug: 'dental-clinic',
    name: 'Fictional dental niche',
    searchTerms: ['dental clinic', 'dentist', 'dental surgeon', 'orthodontist'],
    idealClient: {},
    signalWeights: {},
    scriptTemplate: 'Fictional template',
  };
  await prisma.nicheProfile.create({ data: { ...niche, version: 1, searchTerms: ['old term'] } });
  await prisma.nicheProfile.create({ data: { ...niche, version: 2 } });

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

// Proves FR-1/FR-2: a valid campaign starts DISCOVERING with a grid of terms × areas, bad input is 400.
describe('POST /campaigns', () => {
  it('creates dental-clinic / Lahore / [DHA, Gulberg] with 4 × 2 = 8 searches, capped at 100 each', async () => {
    const { status, body } = await create({
      nicheSlug: 'dental-clinic',
      city: 'Lahore',
      areas: ['DHA', 'Gulberg'],
    });

    expect(status).toBe(201);
    expect(CampaignSummary.parse(body)).toMatchObject({
      status: 'DISCOVERING',
      grid: { terms: 4, areas: 2, searches: 8 },
      maxResultsPerSearch: 100,
      duplicateRate: null,
    });
  });

  it('uses the newest niche version', async () => {
    const { body } = await create({ nicheSlug: 'dental-clinic', city: 'Lahore', areas: ['DHA'] });

    expect(body['grid']).toEqual({ terms: 4, areas: 1, searches: 4 });
  });

  it('trims city and areas before saving', async () => {
    const { body } = await create({
      nicheSlug: 'dental-clinic',
      city: ' Lahore ',
      areas: [' DHA '],
    });

    expect(body).toMatchObject({ city: 'Lahore', areas: ['DHA'] });
  });

  it.each([
    ['an empty niche', { nicheSlug: '', city: 'Lahore', areas: ['DHA'] }, 'nicheSlug'],
    ['an empty city', { nicheSlug: 'dental-clinic', city: '  ', areas: ['DHA'] }, 'city'],
    ['no areas', { nicheSlug: 'dental-clinic', city: 'Lahore', areas: [] }, 'areas'],
    [
      'the same area twice',
      { nicheSlug: 'dental-clinic', city: 'Lahore', areas: ['DHA', 'dha'] },
      'areas',
    ],
  ])('answers 400 naming the field for %s', async (_case, input, field) => {
    const { status, body } = await create(input);

    expect(status).toBe(400);
    expect(body['errors']).toEqual([{ field, messages: [expect.any(String)] }]);
  });

  it('says what is wrong in words, for a missing field as for an empty one', async () => {
    const { body } = await create({ city: 'Lahore', areas: ['DHA'] });

    expect(body['errors']).toEqual([{ field: 'nicheSlug', messages: ['nicheSlug is required'] }]);
  });

  it('accepts 20 areas and refuses 21', async () => {
    const areas = Array.from({ length: 21 }, (_, n) => `Fictional Area ${String(n + 1)}`);

    const twenty = await create({
      nicheSlug: 'dental-clinic',
      city: 'Lahore',
      areas: areas.slice(0, 20),
    });
    const twentyOne = await create({ nicheSlug: 'dental-clinic', city: 'Lahore', areas });

    expect(twenty.status).toBe(201);
    expect(twentyOne).toMatchObject({
      status: 400,
      body: { errors: [{ field: 'areas', messages: ['give at most 20 areas'] }] },
    });
  });

  it('refuses an unknown key with 400 and never echoes its value', async () => {
    const { status, body } = await create({
      nicheSlug: 'dental-clinic',
      city: 'Lahore',
      areas: ['DHA'],
      apiKey: 'fictional-secret-value',
    });

    expect(status).toBe(400);
    expect(body['errors']).toEqual([expect.objectContaining({ field: '(body)' })]);
    expect(JSON.stringify(body)).not.toContain('fictional-secret-value');
  });

  it('answers 404 for an unknown niche', async () => {
    const { status } = await create({ nicheSlug: 'bakery', city: 'Lahore', areas: ['DHA'] });

    expect(status).toBe(404);
  });
});
