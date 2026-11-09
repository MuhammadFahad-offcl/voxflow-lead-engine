/**
 * Integration test of the website part of the enrich step on real Postgres, with the web reader
 * that DEMO_MODE binds.
 *
 * Serves: FR-9, FR-10, FR-36, ADR-0007; issue #11 acceptance criteria.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { resolve } from 'node:path';
import type { HazelApp } from '@hazeljs/core';
import { FakeWebReaderAdapter } from '../src/adapters/web-reader/fake.adapter.js';
import { LeadWebsiteRepository } from '../src/db/lead-website.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import type { Logger } from '../src/logging/logger.js';
import { enrichWebsite, type EnrichWebsiteDeps } from '../src/pipeline/enrich.step.js';
import { WEB_READER, type WebReaderPort } from '../src/ports/web-reader.port.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let app: HazelApp;
let prisma: PrismaProvider;
let deps: EnrichWebsiteDeps;
let campaignId = '';
const info = jest.fn();

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_enrich_test');
  app = await startServer(testEnv({ DATABASE_URL: url }), 0);
  const container = app.getContainer();
  prisma = container.resolve(PrismaProvider);
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  const niche = await prisma.nicheProfile.findFirstOrThrow();
  const campaign = await prisma.campaign.create({
    data: { organizationId: SEED_ORGANIZATION_ID, nicheProfileId: niche.id, city: 'Lahore' },
  });
  campaignId = campaign.id;
  deps = {
    leads: new LeadWebsiteRepository(prisma),
    webReader: container.resolve<WebReaderPort>(WEB_READER),
    logger: { info } as unknown as Logger,
  };
}, 120_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const enrich = async (website: string | null) => {
  const lead = await prisma.lead.create({
    data: {
      organizationId: SEED_ORGANIZATION_ID,
      campaignId,
      placeId: `place-${String(website)}`,
      name: 'Fictional Clinic',
      rawPlace: {},
      website,
    },
  });
  const evidence = await enrichWebsite(deps, lead.id);
  return { evidence, row: await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } }) };
};

// Proves issue #11's acceptance in DEMO_MODE: each fixture site stores its status and fields.
describe('enrichWebsite', () => {
  it('runs on the fake web reader that DEMO_MODE binds', () => {
    expect(deps.webReader).toBeInstanceOf(FakeWebReaderAdapter);
  });

  it.each([
    ['p01', 'READ_FETCH', { hasOnlineBooking: true, hasChatWidget: false }],
    ['p03', 'READ_FETCH', { hasChatWidget: true, decisionMakerName: 'Dr. Hamza Fictional' }],
    ['p06', 'READ_FETCH', { hasOnlineBooking: false, decisionMakerName: 'Dr. Ayesha Inventa' }],
    ['p07', 'READ_LIGHTPANDA', { hasOnlineBooking: true, hasChatWidget: true }],
    ['p08', 'UNREADABLE', { hasOnlineBooking: null, hasChatWidget: null, emails: [] }],
    ['p10', 'READ_FETCH', { emails: ['info@p10.example.com', 'appointments@p10.example.com'] }],
  ])('stores %s as %s with its fields', async (name, websiteStatus, fields) => {
    const { row } = await enrich(`https://${name}.example.com`);

    expect(row).toMatchObject({ websiteStatus, ...fields });
  });

  it('stores the WhatsApp and social links it found', async () => {
    const { row } = await enrich('https://p03.example.com/');

    expect(row.whatsappLinks).toHaveLength(2);
    expect((await enrich('https://p01.example.com/')).row.socialLinks).toHaveLength(2);
  });

  it('returns the doctors and treatments, which have no column yet', async () => {
    const { evidence } = await enrich('https://p06.example.com/');

    expect(evidence.doctors).toHaveLength(3);
    expect(evidence.treatments).toHaveLength(5);
  });

  it('marks a lead with no website NONE, and logs only id, domain and status', async () => {
    info.mockClear();
    const { row } = await enrich(null);
    await enrich('https://p10.example.com/');

    expect(row.websiteStatus).toBe('NONE');
    expect(info.mock.calls.map(([fields]) => Object.keys(fields as object))).toEqual([
      ['leadId', 'status'],
      ['leadId', 'domain', 'status'],
    ]);
  });
});
