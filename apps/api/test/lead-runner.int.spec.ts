/**
 * Integration tests of the lead-runner loop on the fictional DHA demo clinics, through the same
 * wiring as the worker (`buildLeadRunnerDeps`) on fake adapters: reviews once per campaign, each
 * lead through its graph at most LEAD_RUNNER_CONCURRENCY at a time, the campaign to SCORING; a
 * worker stopped mid-pass; a reviews run that needs an Apify check; a spend cap.
 *
 * Serves: FR-11, FR-32, FR-33, NFR-1, NFR-2; issue #15 acceptance (each lead SCORED, FILTERED_OUT
 * or FAILED with one failing site, the campaign not FAILED; restart test; DEMO_MODE=true).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { DEFAULT_SETTINGS } from '@voxflow/shared';
import { resolve } from 'node:path';
import { FakeLeadSourceAdapter } from '../src/adapters/lead-source/fake.adapter.js';
import { FakeLlmAdapter } from '../src/adapters/llm/fake.adapter.js';
import { FakeWebContextAdapter } from '../src/adapters/web-context/fake.adapter.js';
import { FakeWebReaderAdapter } from '../src/adapters/web-reader/fake.adapter.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import type { Logger } from '../src/logging/logger.js';
import { PaidStartGate } from '../src/pipeline/paid-start-gate.js';
import { readReviewsRunNote } from '../src/pipeline/reviews-run-note.js';
import type { LlmPort } from '../src/ports/llm.port.js';
import type { WebContextPort } from '../src/ports/web-context.port.js';
import type { WebReaderPort } from '../src/ports/web-reader.port.js';
import {
  buildLeadRunnerDeps,
  LEAD_LEASE_MS,
  runLeadRunnerOnce,
  type LeadRunnerDeps,
  type LeadRunnerParts,
  type LeadRunnerState,
} from '../src/scheduler/lead-runner.js';
import { discoverDemoCampaign } from './demo-campaign.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

// Whole passes of database steps for nine clinics: Jest's 5-second default is too short.
jest.setTimeout(120_000);

const CONCURRENCY = 3;
const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as Logger;
const clients: PrismaProvider[] = [];

afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
});

/**
 * A seeded test database with a discovered demo campaign whose reviews are not stored yet.
 * @param name - The test database's name.
 * @returns Its client and the campaign id.
 */
const demoDatabase = async (name: string) => {
  const prisma = new PrismaProvider(testEnv({ DATABASE_URL: await createTestDatabase(name) }));
  clients.push(prisma);
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  return { prisma, campaignId: await discoverDemoCampaign(prisma, logger, false) };
};

const fakeReader = new FakeWebReaderAdapter();
const fakeContext = new FakeWebContextAdapter();

/**
 * Builds a pass's dependencies the way worker.ts does, on fakes unless a test swaps one.
 * @param prisma - The test database's client.
 * @param swap - Adapters or settings to replace.
 * @returns The dependencies.
 */
const runnerDeps = (prisma: PrismaProvider, swap: Partial<LeadRunnerParts> = {}): LeadRunnerDeps =>
  buildLeadRunnerDeps({
    prisma,
    leadSource: new FakeLeadSourceAdapter(logger),
    webReader: fakeReader,
    webContext: fakeContext,
    llm: new FakeLlmAdapter(),
    logger,
    now: () => new Date(),
    concurrency: CONCURRENCY,
    startGate: new PaidStartGate(),
    ...swap,
  });

/**
 * Runs passes until one claims no lead.
 * @param deps - The pass's dependencies.
 * @returns How many leads each pass ran, ending with the empty one.
 */
const runUntilIdle = async (deps: LeadRunnerDeps): Promise<number[]> => {
  const sizes: number[] = [];
  for (let pass = 0; pass < 20; pass += 1) {
    const { leads } = await runLeadRunnerOnce(deps);
    sizes.push(leads);
    if (leads === 0) return sizes;
  }
  throw new Error('The runner never went idle');
};

const campaignStatus = async (prisma: PrismaProvider, id: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id } })).status;

// Proves the runner takes a demo campaign from ENRICHING to SCORING with one failing lead (FR-32).
describe('lead runner on a demo campaign', () => {
  it('scores every lead but the broken one, buys reviews once and moves the campaign on', async () => {
    const { prisma, campaignId } = await demoDatabase('voxflow_lead_runner_test');
    const broken = await prisma.lead.findFirstOrThrow({
      where: { campaignId, status: 'DISCOVERED', website: { not: null } },
      orderBy: { placeId: 'asc' },
    });
    const leadSource = new FakeLeadSourceAdapter(logger);
    const startReviews = jest.spyOn(leadSource, 'startReviews');
    const webReader: WebReaderPort = {
      read: (url) =>
        url === broken.website
          ? Promise.reject(new Error('Fictional reader crash'))
          : fakeReader.read(url),
    };
    const deps = runnerDeps(prisma, { leadSource, webReader });

    const first = await runLeadRunnerOnce(deps);
    // Leads are still waiting after one batch: the campaign is not done yet.
    expect(first.leads).toBe(CONCURRENCY);
    expect(await campaignStatus(prisma, campaignId)).toBe('ENRICHING');
    await runUntilIdle(deps);

    expect(startReviews).toHaveBeenCalledTimes(1);
    const leads = await prisma.lead.findMany({ where: { campaignId } });
    const byStatus = (status: string) => leads.filter((lead) => lead.status === status);
    expect(byStatus('FAILED').map((lead) => [lead.id, lead.failedStep])).toEqual([
      [broken.id, 'ENRICH_WEBSITE'],
    ]);
    expect(byStatus('SCORED').length + byStatus('FILTERED_OUT').length).toBe(leads.length - 1);
    expect(byStatus('SCORED').length).toBeGreaterThan(0);
    expect(await campaignStatus(prisma, campaignId)).toBe('SCORING');
  });
});

// Proves NFR-2: a worker stopped inside an LLM call leaves its leads to a restarted worker, which
// finishes them without buying reviews, reading a website or searching a second time.
describe('lead runner after the worker stopped mid-pass', () => {
  it('resumes every lead at its next step once the claims expire', async () => {
    const { prisma, campaignId } = await demoDatabase('voxflow_lead_runner_restart_test');
    const leadSource = new FakeLeadSourceAdapter(logger);
    const startReviews = jest.spyOn(leadSource, 'startReviews');
    const reads = jest.fn((url: string) => fakeReader.read(url));
    const searches = jest.fn((query: Parameters<WebContextPort['getContext']>[0]) =>
      fakeContext.getContext(query),
    );
    const counted = {
      leadSource,
      webReader: { read: reads },
      webContext: { maxCostUsd: () => fakeContext.maxCostUsd(), getContext: searches },
    };
    // The first worker stops inside review labelling: the LLM call never returns.
    const stuck = jest.fn(() => new Promise<never>(() => undefined));
    const stuckModel: LlmPort = { complete: stuck };
    void runLeadRunnerOnce(runnerDeps(prisma, { ...counted, llm: stuckModel }));
    // Each claimed lead either hangs in the LLM call or, with nothing to label, finishes.
    const settled = async () =>
      stuck.mock.calls.length +
      (await prisma.lead.count({ where: { campaignId, status: 'SCORED' } }));
    for (let wait = 0; (await settled()) < CONCURRENCY && wait < 300; wait += 1) {
      await new Promise((done) => setTimeout(done, 100));
    }
    expect(stuck.mock.calls.length).toBeGreaterThan(0);
    const interrupted = await prisma.lead.findMany({
      where: { campaignId, graphClaimedAt: { not: null } },
    });
    expect(interrupted.map((lead) => lead.status)).toEqual(interrupted.map(() => 'ENRICHED'));

    // The restarted worker: same counted adapters, a clock past the first worker's leases.
    const later = () => new Date(Date.now() + LEAD_LEASE_MS + 1000);
    await runUntilIdle(runnerDeps(prisma, { ...counted, now: later }));

    expect(startReviews).toHaveBeenCalledTimes(1);
    const urls = reads.mock.calls.map(([url]) => url);
    expect(new Set(urls).size).toBe(urls.length);
    const leads = await prisma.lead.findMany({
      where: { campaignId, status: { not: 'FILTERED_OUT' } },
      include: { costRecords: true },
    });
    expect(leads.map((lead) => lead.status)).toEqual(leads.map(() => 'SCORED'));
    for (const lead of leads) {
      const paid = (service: string) =>
        lead.costRecords.filter((record) => record.service === service).length;
      // One web search each, ever; at most one labelling call (none when nothing has text).
      expect({ lead: lead.placeId, searches: paid('PERPLEXITY_SEARCH') }).toEqual({
        lead: lead.placeId,
        searches: 1,
      });
      expect(paid('LLM')).toBeLessThanOrEqual(1);
    }
    // The interrupted runs are closed in the HazelJS run store, not left running.
    const oldRuns = await prisma.agentRun.findMany({
      where: { id: { in: interrupted.flatMap((lead) => lead.graphRunId ?? []) } },
    });
    expect(oldRuns.map((run) => run.status)).toEqual(interrupted.map(() => 'cancelled'));
    expect(await campaignStatus(prisma, campaignId)).toBe('SCORING');
  });
});

// Proves a reviews run that may exist without a saved id pauses the campaign with a reason, runs no
// lead, and that the founder's resume starts a new run (ADR-0015, as discover does).
describe('lead runner when a reviews run needs an Apify check', () => {
  it('pauses the campaign, then pays for a new run only after the resume', async () => {
    const { prisma, campaignId } = await demoDatabase('voxflow_lead_runner_check_test');
    const leadSource = new FakeLeadSourceAdapter(logger);
    const startReviews = jest
      .spyOn(leadSource, 'startReviews')
      .mockRejectedValueOnce(new Error('Fictional dropped connection'));
    const deps = runnerDeps(prisma, { leadSource });

    const first = await runLeadRunnerOnce(deps);

    expect(first.leads).toBe(0);
    const paused = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(paused).toMatchObject({ status: 'PAUSED', pausedFrom: 'ENRICHING' });
    expect(paused.pauseReason).toContain('Check the Apify console');
    const records = await prisma.costRecord.findMany({
      where: { campaignId, note: { contains: 'pass2-reviews' } },
    });
    expect(records.map((record) => readReviewsRunNote(record.note)?.state)).toEqual(['ABANDONED']);
    // Paused: another pass pays for nothing.
    await runLeadRunnerOnce(deps);
    expect(startReviews).toHaveBeenCalledTimes(1);

    // The founder checked the console and resumed.
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'ENRICHING', pausedFrom: null, pauseReason: null },
    });
    await runUntilIdle(deps);

    expect(startReviews).toHaveBeenCalledTimes(2);
    expect(await campaignStatus(prisma, campaignId)).toBe('SCORING');
  });
});

// Proves FR-33 without churn: after a spend cap pauses leads, the runner claims no new lead for one
// lease, and the campaign stays ENRICHING while leads wait.
describe('lead runner at the LLM spend cap', () => {
  it('stops claiming for one lease after a pass paused leads', async () => {
    const { prisma, campaignId } = await demoDatabase('voxflow_lead_runner_cap_test');
    await prisma.settings.update({
      where: { organizationId: SEED_ORGANIZATION_ID },
      data: { spendCaps: { ...DEFAULT_SETTINGS.spendCaps, llmMonthlyUsd: '0.00' } },
    });
    const deps = runnerDeps(prisma);
    const state: LeadRunnerState = { claimsHeldUntil: null };

    let first = await runLeadRunnerOnce(deps, state);
    // A batch of leads with nothing to label finishes without the LLM; the next batch meets the cap.
    for (let pass = 0; first.paused === 0 && first.leads > 0 && pass < 5; pass += 1) {
      first = await runLeadRunnerOnce(deps, state);
    }
    const second = await runLeadRunnerOnce(deps, state);

    expect(first.paused).toBeGreaterThan(0);
    expect(state.claimsHeldUntil).not.toBeNull();
    expect(second.leads).toBe(0);
    expect(await campaignStatus(prisma, campaignId)).toBe('ENRICHING');
  });
});
