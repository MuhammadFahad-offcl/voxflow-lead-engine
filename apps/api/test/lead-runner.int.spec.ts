/**
 * Integration tests of the lead-runner loop on the fictional DHA demo clinics, with every fake
 * adapter: reviews once per campaign, then each lead through its graph, at most
 * LEAD_RUNNER_CONCURRENCY at a time, and the campaign to SCORING. Also a worker that stops in the
 * middle of a pass: a restarted worker finishes every lead without doing a finished step twice.
 *
 * Serves: FR-11, FR-32, NFR-1, NFR-2; issue #15 acceptance (each lead SCORED, FILTERED_OUT or
 * FAILED with one failing site, the campaign not FAILED; restart test; DEMO_MODE=true).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { resolve } from 'node:path';
import { FakeLeadSourceAdapter } from '../src/adapters/lead-source/fake.adapter.js';
import { FakeLlmAdapter } from '../src/adapters/llm/fake.adapter.js';
import { FakeWebContextAdapter } from '../src/adapters/web-context/fake.adapter.js';
import { FakeWebReaderAdapter } from '../src/adapters/web-reader/fake.adapter.js';
import { DiscoveryRepository } from '../src/db/discovery.repository.js';
import { LeadContextRepository } from '../src/db/lead-context.repository.js';
import { LeadRunRepository } from '../src/db/lead-run.repository.js';
import { LeadWebsiteRepository } from '../src/db/lead-website.repository.js';
import { LlmSpendRepository } from '../src/db/llm-spend.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { ReviewLabelRepository } from '../src/db/review-label.repository.js';
import { ReviewRepository } from '../src/db/review.repository.js';
import { ScoreRepository } from '../src/db/score.repository.js';
import { seed } from '../src/db/seed.js';
import { LlmService } from '../src/llm/llm.service.js';
import type { Logger } from '../src/logging/logger.js';
import { createLeadGraphRuntime } from '../src/pipeline/lead.graph.js';
import type { WebContextPort } from '../src/ports/web-context.port.js';
import type { WebReaderPort } from '../src/ports/web-reader.port.js';
import {
  LEAD_LEASE_MS,
  runLeadRunnerOnce,
  type LeadRunnerDeps,
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

/** The adapters a pass may swap for counted or broken ones. */
interface Adapters {
  leadSource: FakeLeadSourceAdapter;
  webReader: WebReaderPort;
  webContext: WebContextPort;
}

/**
 * Builds a runner pass's dependencies on the fakes, the way worker.ts wires the real ones.
 * @param prisma - The test database's client.
 * @param adapters - The adapters to use.
 * @param now - The pass's clock.
 * @returns The dependencies.
 */
const runnerDeps = (
  prisma: PrismaProvider,
  adapters: Adapters,
  now: () => Date = () => new Date(),
): LeadRunnerDeps => {
  const { runtime, store } = createLeadGraphRuntime(prisma);
  const leads = new LeadRunRepository(prisma);
  const discovery = new DiscoveryRepository(prisma);
  return {
    leads,
    reviews: {
      prisma,
      reviewRepo: new ReviewRepository(prisma, discovery),
      leadSource: adapters.leadSource,
      logger,
      now,
    },
    graph: {
      runtime,
      store,
      runs: leads,
      website: { leads: new LeadWebsiteRepository(prisma), webReader: adapters.webReader, logger },
      context: {
        leads: new LeadContextRepository(prisma),
        webContext: adapters.webContext,
        logger,
        now,
      },
      label: {
        reviews: new ReviewLabelRepository(prisma),
        llm: new LlmService(new LlmSpendRepository(prisma), new FakeLlmAdapter(), logger),
        logger,
      },
      score: { leads: new ScoreRepository(prisma), logger },
      logger,
      now,
    },
    logger,
    now,
    concurrency: CONCURRENCY,
  };
};

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

const fakeReader = new FakeWebReaderAdapter();
const fakeContext = new FakeWebContextAdapter();

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

    const sizes = await runUntilIdle(
      runnerDeps(prisma, { leadSource, webReader, webContext: fakeContext }),
    );

    expect(Math.max(...sizes)).toBe(CONCURRENCY);
    expect(startReviews).toHaveBeenCalledTimes(1);
    const leads = await prisma.lead.findMany({ where: { campaignId } });
    const byStatus = (status: string) => leads.filter((lead) => lead.status === status);
    expect(byStatus('FAILED').map((lead) => [lead.id, lead.failedStep])).toEqual([
      [broken.id, 'ENRICH_WEBSITE'],
    ]);
    expect(byStatus('SCORED').length + byStatus('FILTERED_OUT').length).toBe(leads.length - 1);
    expect(byStatus('SCORED').length).toBeGreaterThan(0);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('SCORING');
  });
});

// Proves NFR-2: a worker stopped mid-pass leaves its leads to a restarted worker, which finishes
// them without reading a website, searching or labelling a second time.
describe('lead runner after the worker stopped mid-pass', () => {
  it('resumes every lead at its next step once the claims expire', async () => {
    const { prisma, campaignId } = await demoDatabase('voxflow_lead_runner_restart_test');
    const leadSource = new FakeLeadSourceAdapter(logger);
    const reads = jest.fn((url: string) => fakeReader.read(url));
    const webReader: WebReaderPort = { read: reads };
    // The first worker stops inside the web search: the call never returns.
    const stuck = jest.fn(() => new Promise<never>(() => undefined));
    const stuckContext: WebContextPort = {
      maxCostUsd: () => fakeContext.maxCostUsd(),
      getContext: stuck,
    };
    void runLeadRunnerOnce(runnerDeps(prisma, { leadSource, webReader, webContext: stuckContext }));
    for (let wait = 0; stuck.mock.calls.length < CONCURRENCY && wait < 300; wait += 1) {
      await new Promise((done) => setTimeout(done, 100));
    }
    expect(stuck).toHaveBeenCalledTimes(CONCURRENCY);
    const interrupted = await prisma.lead.findMany({
      where: { campaignId, graphClaimedAt: { not: null } },
    });

    // The restarted worker: same fakes, but its clock is past the first worker's leases.
    const searches = jest.fn((query: Parameters<WebContextPort['getContext']>[0]) =>
      fakeContext.getContext(query),
    );
    const later = () => new Date(Date.now() + LEAD_LEASE_MS + 1000);
    await runUntilIdle(
      runnerDeps(
        prisma,
        {
          leadSource,
          webReader,
          webContext: { maxCostUsd: () => fakeContext.maxCostUsd(), getContext: searches },
        },
        later,
      ),
    );

    const leads = await prisma.lead.findMany({
      where: { campaignId, status: { not: 'FILTERED_OUT' } },
      include: { costRecords: true },
    });
    expect(leads.map((lead) => lead.status)).toEqual(leads.map(() => 'SCORED'));
    // No site read twice; no lead searched twice by the restarted worker.
    const urls = reads.mock.calls.map(([url]) => url);
    expect(new Set(urls).size).toBe(urls.length);
    const searched = searches.mock.calls.map(([query]) => query.name);
    expect(new Set(searched).size).toBe(searched.length);
    for (const lead of leads) {
      const llmCosts = lead.costRecords.filter((record) => record.service === 'LLM');
      expect({ lead: lead.placeId, llmCosts: llmCosts.length }).toEqual({
        lead: lead.placeId,
        llmCosts: llmCosts.length > 0 ? 1 : 0,
      });
    }
    // The interrupted runs are closed in the HazelJS run store, not left running.
    const oldRuns = await prisma.agentRun.findMany({
      where: { id: { in: interrupted.flatMap((lead) => lead.graphRunId ?? []) } },
    });
    expect(oldRuns.map((run) => run.status)).toEqual(oldRuns.map(() => 'cancelled'));
    expect(oldRuns).toHaveLength(CONCURRENCY);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe('SCORING');
  });
});
