/**
 * Integration test of the lead context repository on real Postgres: the first context wins a
 * race, and spend with no context is recorded.
 *
 * Serves: FR-12, FR-33, NFR-4; issue #12.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { resolve } from 'node:path';
import { LeadContextRepository } from '../src/db/lead-context.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let prisma: PrismaProvider;
let repository: LeadContextRepository;
let lead: { id: string; organizationId: string; campaignId: string };

const context = (summary: string) => ({ summary, sources: [] });
const cost = new Prisma.Decimal('0.005');

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_context_repo_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
  repository = new LeadContextRepository(prisma);
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  const niche = await prisma.nicheProfile.findFirstOrThrow();
  const campaign = await prisma.campaign.create({
    data: { organizationId: SEED_ORGANIZATION_ID, nicheProfileId: niche.id, city: 'Lahore' },
  });
  const row = await prisma.lead.create({
    data: {
      organizationId: SEED_ORGANIZATION_ID,
      campaignId: campaign.id,
      placeId: 'repo-1',
      name: 'Fictional Clinic',
      rawPlace: {},
    },
  });
  lead = { id: row.id, organizationId: row.organizationId, campaignId: campaign.id };
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

const costs = () =>
  prisma.costRecord.findMany({ where: { leadId: lead.id, service: 'PERPLEXITY_SEARCH' } });

// Proves the DbNull guard: a second save of the same lead keeps the first context, and both paid
// searches are recorded.
describe('LeadContextRepository.saveContext', () => {
  it('keeps the first context when two runs race, and records both costs', async () => {
    await repository.saveContext(lead, context('first'), cost);
    await repository.saveContext(lead, context('second'), cost);

    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.businessContext).toEqual(context('first'));
    expect(await costs()).toHaveLength(2);
  });
});

// Proves a search that may have been billed leaves a cost record and no context.
describe('LeadContextRepository.recordSpend', () => {
  it('records the cost with no units and leaves the context alone', async () => {
    const other = await prisma.lead.create({
      data: {
        organizationId: lead.organizationId,
        campaignId: lead.campaignId,
        placeId: 'repo-2',
        name: 'Fictional Two',
        rawPlace: {},
      },
    });

    await repository.recordSpend({ ...lead, id: other.id }, cost);

    const row = await prisma.lead.findUniqueOrThrow({ where: { id: other.id } });
    const [record] = await prisma.costRecord.findMany({ where: { leadId: other.id } });
    expect(row.businessContext).toBeNull();
    expect(record).toMatchObject({ units: 0, service: 'PERPLEXITY_SEARCH' });
    expect(record?.amountUsd.toString()).toBe('0.005');
  });
});
