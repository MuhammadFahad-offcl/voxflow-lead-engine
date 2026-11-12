/**
 * Integration tests of the lead graph on the fictional DHA demo clinics, with every fake adapter:
 * one HazelJS AgentGraph run per lead stored in the SQL durable run store, a failing step, a
 * resumed run that pays nothing twice, and a spend cap that pauses.
 *
 * Serves: FR-32, FR-33, NFR-1, NFR-2, ADR-0001; issue #15 acceptance (each lead goes through
 * enrich → score; one lead's failure is stored and the others continue; works with DEMO_MODE=true).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { DEFAULT_SETTINGS } from '@voxflow/shared';
import { resolve } from 'node:path';
import { FakeLlmAdapter } from '../src/adapters/llm/fake.adapter.js';
import { FakeWebContextAdapter } from '../src/adapters/web-context/fake.adapter.js';
import { FakeWebReaderAdapter } from '../src/adapters/web-reader/fake.adapter.js';
import { LeadContextRepository } from '../src/db/lead-context.repository.js';
import { LeadRunRepository, type ClaimedLead } from '../src/db/lead-run.repository.js';
import { LeadWebsiteRepository } from '../src/db/lead-website.repository.js';
import { LlmSpendRepository } from '../src/db/llm-spend.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { ReviewLabelRepository } from '../src/db/review-label.repository.js';
import { ScoreRepository } from '../src/db/score.repository.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { LlmService } from '../src/llm/llm.service.js';
import type { Logger } from '../src/logging/logger.js';
import {
  createLeadGraphRuntime,
  LEAD_STEP,
  runLeadGraph,
  type LeadGraphDeps,
} from '../src/pipeline/lead.graph.js';
import type { WebContextPort } from '../src/ports/web-context.port.js';
import type { WebReaderPort } from '../src/ports/web-reader.port.js';
import { discoverDemoCampaign } from './demo-campaign.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

const LEASE_MS = 15 * 60 * 1000;
let prisma: PrismaProvider;
let campaignId: string;
const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as Logger;

// The demo website reader, except one site that makes the step throw (a bug, not UNREADABLE).
let brokenSite: string | null = null;
const fakeReader = new FakeWebReaderAdapter();
const reads = jest.fn((url: string) => {
  if (url === brokenSite) return Promise.reject(new Error('Fictional reader crash'));
  return fakeReader.read(url);
});
const webReader: WebReaderPort = { read: reads };
// The demo web context, counted: a resumed run must not search (and pay) again.
const fakeContext = new FakeWebContextAdapter();
const searches = jest.fn((query: Parameters<WebContextPort['getContext']>[0]) =>
  fakeContext.getContext(query),
);
const webContext: WebContextPort = {
  maxCostUsd: () => fakeContext.maxCostUsd(),
  getContext: searches,
};

let deps: LeadGraphDeps;
const runs = () => new LeadRunRepository(prisma);

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_lead_graph_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  campaignId = await discoverDemoCampaign(prisma, logger);
  const { runtime, store } = createLeadGraphRuntime(prisma);
  deps = {
    runtime,
    store,
    runs: runs(),
    website: { leads: new LeadWebsiteRepository(prisma), webReader, logger },
    context: {
      leads: new LeadContextRepository(prisma),
      webContext,
      logger,
      now: () => new Date(),
    },
    label: {
      reviews: new ReviewLabelRepository(prisma),
      llm: new LlmService(new LlmSpendRepository(prisma), new FakeLlmAdapter(), logger),
      logger,
    },
    score: { leads: new ScoreRepository(prisma), logger },
    logger,
  };
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

// Claims every free lead, keeps the claim on one and frees the others.
const claimOne = async (leadId: string): Promise<ClaimedLead> => {
  const claimed = await runs().claimNext(new Date(), LEASE_MS, 100);
  const lead = claimed.find((candidate) => candidate.id === leadId);
  if (lead === undefined) throw new Error(`Lead ${leadId} was not claimable`);
  await prisma.lead.updateMany({
    where: { campaignId, id: { not: leadId } },
    data: { graphClaimedAt: null },
  });
  return lead;
};

// Proves one graph run per lead, stored through HazelJS's run store, and that one failing lead
// is marked FAILED while every other lead is scored (FR-32).
describe('runLeadGraph on the demo campaign', () => {
  it('scores every lead but the one whose website step throws', async () => {
    const broken = await prisma.lead.findFirstOrThrow({
      where: { campaignId, status: 'DISCOVERED', website: { not: null } },
      orderBy: { placeId: 'asc' },
    });
    brokenSite = broken.website;
    const claimed = await runs().claimNext(new Date(), LEASE_MS, 100);

    const outcomes = [];
    for (const lead of claimed) outcomes.push(await runLeadGraph(deps, lead));
    brokenSite = null;

    expect(outcomes.filter((outcome) => outcome.status === 'FAILED')).toHaveLength(1);
    const leads = await prisma.lead.findMany({
      where: { id: { in: claimed.map((lead) => lead.id) } },
    });
    for (const lead of leads) {
      const expected =
        lead.id === broken.id
          ? { status: 'FAILED', failedStep: LEAD_STEP.WEBSITE, error: 'Fictional reader crash' }
          : { status: 'SCORED', failedStep: null };
      expect({ place: lead.placeId, ...lead }).toMatchObject({ place: lead.placeId, ...expected });
      expect(lead.graphClaimedAt).toBeNull();
      expect(lead.graphRunId).toMatch(/^lead_/);
    }
  });

  it('stores each run in the HazelJS run store, with a checkpoint per finished step', async () => {
    // One with a website: a lead without one starts at the web context (nothing to read).
    const scored = await prisma.lead.findFirstOrThrow({
      where: { campaignId, status: 'SCORED', website: { not: null } },
    });
    const failed = await prisma.lead.findFirstOrThrow({ where: { campaignId, status: 'FAILED' } });

    const done = await prisma.agentRun.findUniqueOrThrow({
      where: { id: scored.graphRunId ?? '' },
    });
    const broke = await prisma.agentRun.findUniqueOrThrow({
      where: { id: failed.graphRunId ?? '' },
    });
    const checkpoints = await prisma.agentRunCheckpoint.findMany({
      where: { runId: done.id },
      orderBy: { step: 'asc' },
    });

    expect(done).toMatchObject({ agentName: 'lead-graph', status: 'completed' });
    expect(checkpoints.map((checkpoint) => checkpoint.step)).toEqual([1, 2, 3, 4]);
    expect(broke).toMatchObject({ status: 'failed', error: { message: 'Fictional reader crash' } });
  });
});

// Proves a resumed lead (worker stopped mid-run, or a retry) starts at its next step and pays for
// nothing twice: no second website read, web search or LLM call.
describe('runLeadGraph resuming a lead', () => {
  it('cancels the unfinished run and repeats no stored or paid work', async () => {
    const lead = await prisma.lead.findFirstOrThrow({
      where: { campaignId, status: 'SCORED', websiteStatus: { not: 'PENDING' } },
    });
    // As if the worker stopped mid-run: the lead is back before scoring, its run still running.
    await prisma.agentRun.update({
      where: { id: lead.graphRunId ?? '' },
      data: { status: 'running' },
    });
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'DISCOVERED' } });
    const costsBefore = await prisma.costRecord.count({ where: { leadId: lead.id } });
    reads.mockClear();
    searches.mockClear();
    const claimed = await claimOne(lead.id);

    const outcome = await runLeadGraph(deps, claimed);

    expect(outcome.status).toBe('COMPLETED');
    expect(reads).not.toHaveBeenCalled();
    expect(searches).not.toHaveBeenCalled();
    expect(await prisma.costRecord.count({ where: { leadId: lead.id } })).toBe(costsBefore);
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      status: 'SCORED',
    });
    const old = await prisma.agentRun.findUniqueOrThrow({ where: { id: lead.graphRunId ?? '' } });
    expect(old.status).toBe('cancelled');
  });
});

// Proves FR-33: a spend cap pauses the step; the lead keeps its status and is not FAILED.
describe('runLeadGraph at the LLM spend cap', () => {
  it('suspends the run and leaves the lead ENRICHED, unclaimed, without an error', async () => {
    const lead = await prisma.lead.findFirstOrThrow({
      where: { campaignId, status: 'SCORED', reviews: { some: { text: { not: '' } } } },
    });
    await prisma.review.updateMany({ where: { leadId: lead.id }, data: { labels: [] } });
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'ENRICHED' } });
    await prisma.settings.update({
      where: { organizationId: SEED_ORGANIZATION_ID },
      data: { spendCaps: { ...DEFAULT_SETTINGS.spendCaps, llmMonthlyUsd: '0.00' } },
    });
    const claimed = await claimOne(lead.id);

    const outcome = await runLeadGraph(deps, claimed);

    expect(outcome).toMatchObject({ status: 'PAUSED', step: LEAD_STEP.LABEL });
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      status: 'ENRICHED',
      failedStep: null,
      error: null,
      graphClaimedAt: null,
    });
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: outcome.runId } });
    expect(run.status).toBe('suspended');
    await prisma.settings.update({
      where: { organizationId: SEED_ORGANIZATION_ID },
      data: { spendCaps: DEFAULT_SETTINGS.spendCaps },
    });
  });
});
