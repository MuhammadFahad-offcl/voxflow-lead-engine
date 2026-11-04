/**
 * Integration test of the campaigns API on a real server and its own migrated database.
 *
 * Serves: FR-1, FR-2, FR-3; issue #8 acceptance criteria.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { HazelApp } from '@hazeljs/core';
import { PrismaPg } from '@prisma/adapter-pg';
import { CampaignSummary } from '@voxflow/shared';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { CampaignsRepository } from '../src/modules/campaigns/campaigns.repository.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let app: HazelApp;
let prisma: PrismaClient;
let baseUrl: string;

const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
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

// Proves the read routes return the same summary the create returned, newest first.
describe('GET /campaigns and /campaigns/:id', () => {
  it('lists campaigns newest first', async () => {
    const { body: newest } = await create({
      nicheSlug: 'dental-clinic',
      city: 'Karachi',
      areas: ['Clifton'],
    });

    const { status, body } = await call('GET', '/campaigns');

    expect(status).toBe(200);
    expect((body as unknown as { id: string }[])[0]?.id).toBe(newest['id']);
  });

  it('gets one campaign with its grid and cap', async () => {
    const { body: created } = await create({
      nicheSlug: 'dental-clinic',
      city: 'Lahore',
      areas: ['DHA', 'Gulberg'],
    });

    const { status, body } = await call('GET', `/campaigns/${String(created['id'])}`);

    expect(status).toBe(200);
    expect(body).toEqual(created);
  });

  it('answers 404 for an unknown campaign', async () => {
    expect((await call('GET', '/campaigns/no-such-campaign')).status).toBe(404);
  });
});

// Proves pause remembers the status, resume returns to it, and illegal moves are 409 (FR-3).
describe('POST /campaigns/:id/pause and /resume', () => {
  it('pauses a SCORING campaign and resumes it in SCORING', async () => {
    const { body: created } = await create({
      nicheSlug: 'dental-clinic',
      city: 'Lahore',
      areas: ['DHA'],
    });
    const id = String(created['id']);
    await prisma.campaign.update({ where: { id }, data: { status: 'SCORING' } });

    const paused = await call('POST', `/campaigns/${id}/pause`);
    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id } });
    const resumed = await call('POST', `/campaigns/${id}/resume`);

    expect(paused).toMatchObject({ status: 200, body: { status: 'PAUSED' } });
    expect(stored.pausedFrom).toBe('SCORING');
    expect(resumed).toMatchObject({ status: 200, body: { status: 'SCORING' } });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id } })).pausedFrom).toBeNull();
  });

  it('answers 409 when pausing a campaign that is already paused', async () => {
    const { body: created } = await create({
      nicheSlug: 'dental-clinic',
      city: 'Lahore',
      areas: ['DHA'],
    });
    const id = String(created['id']);
    await call('POST', `/campaigns/${id}/pause`);

    expect((await call('POST', `/campaigns/${id}/pause`)).status).toBe(409);
  });

  it('answers 409 when resuming a campaign that is not paused', async () => {
    const { body: created } = await create({
      nicheSlug: 'dental-clinic',
      city: 'Lahore',
      areas: ['DHA'],
    });

    expect((await call('POST', `/campaigns/${String(created['id'])}/resume`)).status).toBe(409);
  });

  it('answers 409 when pausing a completed campaign', async () => {
    const { body: created } = await create({
      nicheSlug: 'dental-clinic',
      city: 'Lahore',
      areas: ['DHA'],
    });
    const id = String(created['id']);
    await prisma.campaign.update({ where: { id }, data: { status: 'COMPLETED' } });

    expect((await call('POST', `/campaigns/${id}/pause`)).status).toBe(409);
  });

  it('refuses to resume from a pause that is not the one it read', async () => {
    const { body: created } = await create({
      nicheSlug: 'dental-clinic',
      city: 'Lahore',
      areas: ['DHA'],
    });
    const id = String(created['id']);
    await prisma.campaign.update({
      where: { id },
      data: { status: 'PAUSED', pausedFrom: 'SCORING' },
    });
    const repository = app.getContainer().resolve(CampaignsRepository);

    // Meanwhile another request resumed it, it moved on, and it was paused again from a later stage.
    await prisma.campaign.update({ where: { id }, data: { pausedFrom: 'SCRIPTING' } });
    const applied = await repository.updateStatusIf(
      id,
      { status: 'PAUSED', pausedFrom: 'SCORING' },
      { status: 'SCORING', pausedFrom: null },
    );

    expect(applied).toBe(false);
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'PAUSED',
      pausedFrom: 'SCRIPTING',
    });
  });
});
