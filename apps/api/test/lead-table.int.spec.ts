/**
 * Integration tests of the lead table over HTTP on a test database: `GET /campaigns/:id/leads`
 * filters, sorts and pages one campaign's leads with their evidence.
 *
 * Serves: FR-30 (lead table: filter, sort), FR-14, FR-32, US-14; issue #16 acceptance ("filter by
 * tier and score range, sort by column").
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { HazelApp } from '@hazeljs/core';
import { LeadPage } from '@voxflow/shared';
import { resolve } from 'node:path';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let app: HazelApp;
let prisma: PrismaProvider;
let baseUrl: string;
let campaignId: string;
let pagedCampaignId: string;

const get = (path: string) => fetch(`${baseUrl}${path}`);
const page = async (query = '', id = campaignId) => {
  const response = await get(`/campaigns/${id}/leads${query}`);
  return LeadPage.parse(await response.json());
};
const names = async (query = '') => (await page(query)).leads.map((lead) => lead.name);

const newCampaign = async (): Promise<string> => {
  const niche = await prisma.nicheProfile.findFirstOrThrow();
  const { id } = await prisma.campaign.create({
    data: {
      organizationId: SEED_ORGANIZATION_ID,
      nicheProfileId: niche.id,
      city: 'Lahore',
      areas: ['DHA', 'Gulberg'],
      searchCount: 8,
      status: 'SCORING',
    },
  });
  return id;
};

const lead = (
  campaign: string,
  placeId: string,
  data: Partial<Prisma.LeadUncheckedCreateInput>,
): Prisma.LeadUncheckedCreateInput => ({
  organizationId: SEED_ORGANIZATION_ID,
  campaignId: campaign,
  placeId,
  name: placeId,
  rawPlace: {},
  ...data,
});

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_lead_table_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  campaignId = await newCampaign();
  // Fictional leads covering every filter: tiers, areas in two spellings, a FAILED lead and one
  // filtered out, scores and review counts with gaps.
  await prisma.lead.createMany({
    data: [
      lead(campaignId, 'fictional-a', {
        name: 'Alpha Dental, DHA',
        area: 'DHA',
        score: 74,
        tier: 'HOT',
        reviewCount: 140,
        rating: 4.6,
        phone: '+923000000001',
        phoneType: 'MOBILE',
        status: 'SCORED',
        scoreBreakdown: { pain: 30, fit: 25, reachability: 12, abilityToPay: 7 },
      }),
      lead(campaignId, 'fictional-b', {
        name: 'Bravo Clinic',
        area: 'Gulberg',
        score: 50,
        tier: 'WARM',
        reviewCount: 30,
        status: 'SCORED',
      }),
      lead(campaignId, 'fictional-c', {
        name: 'Charlie Dental',
        area: 'dha',
        score: 20,
        tier: 'COLD',
        status: 'SCORED',
      }),
      lead(campaignId, 'fictional-d', {
        name: 'Delta Dental',
        area: 'DHA',
        status: 'FAILED',
        failedStep: 'LABEL_REVIEWS',
        error: 'Review labelling failed',
        reviewCount: 200,
      }),
      lead(campaignId, 'fictional-e', { name: 'Echo Dental', area: 'DHA', status: 'FILTERED_OUT' }),
    ],
  });
  const alpha = await prisma.lead.findFirstOrThrow({ where: { placeId: 'fictional-a' } });
  await prisma.signal.createMany({
    data: [
      {
        leadId: alpha.id,
        key: 'mobile_number',
        dimension: 'REACHABILITY',
        points: 12,
        evidence: 'Listing phone ends 0001',
      },
      {
        leadId: alpha.id,
        key: 'reviews_unreplied',
        dimension: 'PAIN',
        points: 0,
        evidence: 'Only 3 reviews stored, fewer than the 10 needed',
      },
      {
        leadId: alpha.id,
        key: 'phone_unanswered_reviews',
        dimension: 'PAIN',
        points: 15,
        evidence: '2 of the last 3 reviews say the phone goes unanswered',
      },
      {
        leadId: alpha.id,
        key: 'category_match',
        dimension: 'FIT',
        points: 10,
        evidence: 'Maps category: Dental clinic',
      },
      {
        leadId: alpha.id,
        key: 'many_reviews',
        dimension: 'FIT',
        points: 7,
        evidence: 'Google reviews: 140',
      },
    ],
  });
  pagedCampaignId = await newCampaign();
  await prisma.lead.createMany({
    data: Array.from({ length: 55 }, (_, n) =>
      // Equal scores and names: only the id tie-break keeps the two pages apart.
      lead(pagedCampaignId, `fictional-page-${String(n).padStart(2, '0')}`, {
        name: 'Fictional Same Name',
        score: 50,
        status: 'SCORED',
      }),
    ),
  });

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

// Proves the lead table shows one campaign's leads with their evidence, highest score first.
describe('GET /campaigns/:id/leads', () => {
  it('lists every lead, highest score first, unscored last by name', async () => {
    expect(await names()).toEqual([
      'Alpha Dental, DHA',
      'Bravo Clinic',
      'Charlie Dental',
      'Delta Dental',
      'Echo Dental',
    ]);
  });

  it('returns a lead with its breakdown, rating and signals, highest points first', async () => {
    const [alpha] = (await page('?tier=HOT')).leads;

    expect(alpha).toMatchObject({
      score: 74,
      tier: 'HOT',
      rating: 4.6,
      breakdown: { pain: 30, fit: 25, reachability: 12, abilityToPay: 7 },
    });
    expect(alpha?.signals.map((signal) => signal.points)).toEqual([15, 12, 10, 7, 0]);
  });

  it.each([
    ['?tier=WARM', ['Bravo Clinic']],
    ['?status=FAILED', ['Delta Dental']],
    ['?area=dha', ['Alpha Dental, DHA', 'Charlie Dental', 'Delta Dental', 'Echo Dental']],
    ['?minScore=30&maxScore=80', ['Alpha Dental, DHA', 'Bravo Clinic']],
    ['?maxScore=20', ['Charlie Dental']],
    // Empty fields, as a GET form sends them, mean "no bound": unscored leads stay.
    [
      '?minScore=&maxScore=',
      ['Alpha Dental, DHA', 'Bravo Clinic', 'Charlie Dental', 'Delta Dental', 'Echo Dental'],
    ],
    [
      '?sort=name&dir=desc',
      ['Echo Dental', 'Delta Dental', 'Charlie Dental', 'Bravo Clinic', 'Alpha Dental, DHA'],
    ],
    [
      '?sort=reviews',
      ['Delta Dental', 'Alpha Dental, DHA', 'Bravo Clinic', 'Charlie Dental', 'Echo Dental'],
    ],
    [
      '?sort=score&dir=asc',
      ['Charlie Dental', 'Bravo Clinic', 'Alpha Dental, DHA', 'Delta Dental', 'Echo Dental'],
    ],
  ])('filters and sorts with %s', async (query, expected) => {
    expect(await names(query)).toEqual(expected);
  });

  it('shows a FAILED lead with its step and error, for the retry button', async () => {
    const [delta] = (await page('?status=FAILED')).leads;

    expect(delta).toMatchObject({ failedStep: 'LABEL_REVIEWS', error: 'Review labelling failed' });
  });

  it('pages 50 rows at a time, with the total, and no row on two pages', async () => {
    const first = await page('', pagedCampaignId);
    const second = await page('?page=2', pagedCampaignId);

    expect([first.total, first.pageSize, first.leads.length, second.leads.length]).toEqual([
      55, 50, 50, 5,
    ]);
    const ids = [...first.leads, ...second.leads].map((row) => row.id);
    expect(new Set(ids).size).toBe(55);
  });

  it('answers 400 for a bad filter, without echoing it, and 404 for an unknown campaign', async () => {
    for (const query of [
      '?area=D_A',
      '?area=%25',
      '?minScore=abc',
      '?minScore=80&maxScore=30',
      '?tier=LUKEWARM',
      '?colour=red',
    ]) {
      const response = await get(`/campaigns/${campaignId}/leads${query}`);
      expect({ query, status: response.status }).toEqual({ query, status: 400 });
      expect(await response.text()).not.toContain('LUKEWARM');
    }
    expect((await get('/campaigns/fictionalmissingcampaign0/leads')).status).toBe(404);
  });
});
