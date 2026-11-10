/**
 * Integration test of the web context part of the enrich step on real Postgres, with the fake web
 * context that DEMO_MODE binds. No Perplexity call is made.
 *
 * Serves: FR-12, FR-33, NFR-4, FR-36, ADR-0007; issue #12 acceptance criteria.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { resolve } from 'node:path';
import type { HazelApp } from '@hazeljs/core';
import { BusinessContext } from '@voxflow/shared';
import { FakeWebContextAdapter } from '../src/adapters/web-context/fake.adapter.js';
import { LeadContextRepository } from '../src/db/lead-context.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import type { Logger } from '../src/logging/logger.js';
import { enrichContext, type EnrichContextDeps } from '../src/pipeline/enrich-context.step.js';
import {
  WEB_CONTEXT,
  WebContextError,
  type WebContextPort,
} from '../src/ports/web-context.port.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

const NOW = new Date('2026-11-10T09:00:00Z');
const warn = jest.fn();
const info = jest.fn();
let app: HazelApp;
let prisma: PrismaProvider;
let fake: WebContextPort;
let deps: EnrichContextDeps;
let campaignId = '';
let places = 0;

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_context_test');
  app = await startServer(testEnv({ DATABASE_URL: url }), 0);
  prisma = app.getContainer().resolve(PrismaProvider);
  fake = app.getContainer().resolve<WebContextPort>(WEB_CONTEXT);
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  const niche = await prisma.nicheProfile.findFirstOrThrow();
  campaignId = (
    await prisma.campaign.create({
      data: { organizationId: SEED_ORGANIZATION_ID, nicheProfileId: niche.id, city: 'Lahore' },
    })
  ).id;
  deps = {
    leads: new LeadContextRepository(prisma),
    webContext: fake,
    logger: { warn, info } as unknown as Logger,
    now: () => NOW,
  };
}, 120_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  warn.mockClear();
  info.mockClear();
  // Each test starts with no spend and the default cap, so none depends on another.
  await prisma.costRecord.deleteMany({ where: { service: 'PERPLEXITY_SEARCH' } });
  await setCap('2.00');
});

const setCap = async (usd: string) => {
  const { spendCaps } = await prisma.settings.findFirstOrThrow();
  await prisma.settings.updateMany({
    data: { spendCaps: { ...(spendCaps as object), perplexityDailyUsd: usd } },
  });
};

const newLead = async (name: string, status: 'DISCOVERED' | 'FILTERED_OUT' = 'DISCOVERED') => {
  places += 1;
  return prisma.lead.create({
    data: {
      organizationId: SEED_ORGANIZATION_ID,
      campaignId,
      placeId: `ctx-${String(places)}`,
      name,
      area: 'DHA Phase 5',
      city: 'Lahore',
      rawPlace: {},
      status,
    },
  });
};

const costs = () => prisma.costRecord.findMany({ where: { service: 'PERPLEXITY_SEARCH' } });

// Proves FR-12: a lead gets its context and sources stored, and the search is recorded as a cost.
describe('enrichContext', () => {
  it('runs on the fake web context that DEMO_MODE binds', () => {
    expect(fake).toBeInstanceOf(FakeWebContextAdapter);
  });

  it('stores the context and one cost record for a lead', async () => {
    const lead = await newLead('Fictional Bright Smile Dental');

    const outcome = await enrichContext(deps, lead.id);

    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(outcome).toEqual({ status: 'STORED', sources: 2 });
    expect(BusinessContext.parse(row.businessContext).sources[0]?.url).toBe(
      'https://directory.example.com/fictional-bright-smile-dental',
    );
    const [cost] = await costs();
    expect(cost).toMatchObject({ leadId: lead.id, campaignId, units: 2 });
    expect(cost?.amountUsd.toString()).toBe('0.005');
  });

  it('stores an empty context, and its cost, when the search finds nothing', async () => {
    const lead = await newLead('Fictional Unknown Clinic');

    expect(await enrichContext(deps, lead.id)).toEqual({ status: 'STORED', sources: 0 });
    expect(await costs()).toHaveLength(1);
  });

  it('does not search, or pay, again for a lead that has a context', async () => {
    const lead = await newLead('Fictional Smile Studio');
    await enrichContext(deps, lead.id);

    expect(await enrichContext(deps, lead.id)).toEqual({
      status: 'SKIPPED',
      reason: 'ALREADY_HAS_CONTEXT',
    });
    expect(await costs()).toHaveLength(1);
  });

  it('skips a lead that failed the filter', async () => {
    const lead = await newLead('Fictional Bright Smile Dental', 'FILTERED_OUT');

    expect(await enrichContext(deps, lead.id)).toEqual({
      status: 'SKIPPED',
      reason: 'FILTERED_OUT',
    });
    expect(await costs()).toHaveLength(0);
  });
});

// Proves FR-33: the daily cap stops the search before it is paid, counting only today's spend.
describe('enrichContext cap', () => {
  it('stops before the call that would pass the cap, with a banner sentence', async () => {
    await setCap('0.01');
    const getContext = jest.spyOn(fake, 'getContext');
    const outcomes = [];
    for (const name of ['One', 'Two', 'Three']) {
      outcomes.push(await enrichContext(deps, (await newLead(`Fictional ${name}`)).id));
    }

    expect(outcomes.map(({ status }) => status)).toEqual(['STORED', 'STORED', 'CAP_REACHED']);
    expect(outcomes[2]).toMatchObject({
      reason:
        'Perplexity daily cap: $0.010 spent today, the next search may cost $0.005, the cap is $0.010',
    });
    expect(getContext).toHaveBeenCalledTimes(2);
    getContext.mockRestore();
  });

  it('does not count yesterday in Asia/Karachi against today', async () => {
    await setCap('0.01');
    const lead = await newLead('Fictional Bright Smile Dental');
    // 18:59 UTC on the 9th is 23:59 on the 9th in Karachi; the 10th began at 19:00 UTC.
    await prisma.costRecord.create({
      data: {
        organizationId: SEED_ORGANIZATION_ID,
        service: 'PERPLEXITY_SEARCH',
        amountUsd: '0.01',
        at: new Date('2026-11-09T18:59:00Z'),
      },
    });
    const nextKarachiDay = { ...deps, now: () => new Date('2026-11-09T19:00:00Z') };

    expect((await enrichContext(nextKarachiDay, lead.id)).status).toBe('STORED');
  });
});

// Proves FR-12 is "should" and FR-33 is hard: a failed search leaves the context empty, logs no
// text, and costs the cap only when it may have been billed.
describe('enrichContext failure', () => {
  const failing = (error: Error): WebContextPort => ({
    maxCostUsd: () => fake.maxCostUsd(),
    getContext: () => Promise.reject(error),
  });
  const run = async (error: Error, name = 'Fictional Secret Clinic') => {
    const lead = await newLead(name);
    const outcome = await enrichContext({ ...deps, webContext: failing(error) }, lead.id);
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    return { outcome, row, lead };
  };

  it('records nothing for a failure that was not billed, and logs no text', async () => {
    const { outcome, row } = await run(
      new WebContextError('Fictional Secret Clinic leaked', false),
    );

    expect(outcome).toEqual({ status: 'FAILED' });
    expect(row.businessContext).toBeNull();
    expect(await costs()).toHaveLength(0);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Secret|leaked/);
  });

  it('records the full price for a failure that may have been billed, context left empty', async () => {
    const { outcome, row, lead } = await run(new WebContextError('Search API timed out', true));

    const [cost] = await costs();
    expect(outcome).toEqual({ status: 'FAILED' });
    expect(row.businessContext).toBeNull();
    expect(cost).toMatchObject({ leadId: lead.id, units: 0 });
    expect(cost?.amountUsd.toString()).toBe('0.005');
  });

  it('treats an error it does not know as possibly billed', async () => {
    await run(new Error('something else'));

    expect(await costs()).toHaveLength(1);
  });

  it('counts that spend against the cap on the next lead', async () => {
    await setCap('0.01');
    await run(new WebContextError('Search API timed out', true), 'Fictional One');
    await run(new WebContextError('Search API timed out', true), 'Fictional Two');

    const next = await newLead('Fictional Bright Smile Dental');

    expect((await enrichContext(deps, next.id)).status).toBe('CAP_REACHED');
  });

  it('records the cost when the context cannot be saved, and still throws', async () => {
    const lead = await newLead('Fictional Bright Smile Dental');
    const brokenSave = Object.create(deps.leads) as LeadContextRepository;
    brokenSave.saveContext = () => Promise.reject(new Error('database went away'));

    await expect(enrichContext({ ...deps, leads: brokenSave }, lead.id)).rejects.toThrow(
      'database',
    );

    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.businessContext).toBeNull();
    expect(await costs()).toHaveLength(1);
  });
});
