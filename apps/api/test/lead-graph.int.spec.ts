/**
 * Integration tests of the lead graph on the fictional DHA demo clinics, with every fake adapter:
 * one HazelJS AgentGraph run per lead stored in the SQL durable run store, a failing step, a
 * failed web search that does not fail the lead, a resumed run that pays nothing twice, a lost
 * claim, and the LLM and Perplexity spend caps that pause.
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
import { Prisma } from '../src/generated/prisma/client.js';
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
  type LeadRunOutcome,
} from '../src/pipeline/lead.graph.js';
import { LlmError, type LlmPort } from '../src/ports/llm.port.js';
import { WebContextError, type WebContextPort } from '../src/ports/web-context.port.js';
import type { WebReaderPort } from '../src/ports/web-reader.port.js';
import { discoverDemoCampaign } from './demo-campaign.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

const LEASE_MS = 15 * 60 * 1000;
// Every test here runs whole graph runs (several database steps per lead); Jest's 5-second
// default is too short under the full suite's parallel load.
jest.setTimeout(60_000);
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
    now: () => new Date(),
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

// Puts a scored lead back before its web context, as if never searched.
const backToDiscovered = (leadId: string) =>
  prisma.lead.update({
    where: { id: leadId },
    data: { status: 'DISCOVERED', businessContext: Prisma.DbNull, graphClaimedAt: null },
  });

// Runs `test` with one spend cap changed, and always puts the default caps back.
const withCap = async (
  cap: Partial<typeof DEFAULT_SETTINGS.spendCaps>,
  test: () => Promise<void>,
) => {
  const where = { organizationId: SEED_ORGANIZATION_ID };
  await prisma.settings.update({
    where,
    data: { spendCaps: { ...DEFAULT_SETTINGS.spendCaps, ...cap } },
  });
  try {
    await test();
  } finally {
    await prisma.settings.update({ where, data: { spendCaps: DEFAULT_SETTINGS.spendCaps } });
  }
};

const runOf = (outcome: LeadRunOutcome) => {
  if (!('runId' in outcome)) throw new Error(`Run ended ${outcome.status}, with no run`);
  return prisma.agentRun.findUniqueOrThrow({ where: { id: outcome.runId } });
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
      // The library's own message is not stored: it could quote page data.
      const expected =
        lead.id === broken.id
          ? {
              status: 'FAILED',
              failedStep: LEAD_STEP.WEBSITE,
              error: 'Unexpected Error in this step',
            }
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
    expect(broke).toMatchObject({
      status: 'failed',
      error: { message: 'Unexpected Error in this step' },
    });
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

// Proves FR-12 stays "should" (#12): a failed web search leaves the lead without context, and the
// lead is still labelled and scored.
describe('runLeadGraph when the web search fails', () => {
  it('scores the lead without context instead of failing it', async () => {
    const lead = await prisma.lead.findFirstOrThrow({ where: { campaignId, status: 'SCORED' } });
    await backToDiscovered(lead.id);
    searches.mockRejectedValueOnce(new WebContextError('Fictional search outage', false));
    const claimed = await claimOne(lead.id);

    const outcome = await runLeadGraph(deps, claimed);

    expect(outcome.status).toBe('COMPLETED');
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      status: 'SCORED',
      businessContext: null,
      error: null,
    });
  });
});

// Proves a labelling failure fails the lead with a fixed sentence, at its step (FR-32).
describe('runLeadGraph when review labelling fails', () => {
  it('marks the lead FAILED at LABEL_REVIEWS with "Review labelling failed"', async () => {
    const lead = await prisma.lead.findFirstOrThrow({
      where: { campaignId, status: 'SCORED', reviews: { some: { text: { not: '' } } } },
    });
    await prisma.review.updateMany({ where: { leadId: lead.id }, data: { labels: [] } });
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'ENRICHED' } });
    const brokenModel: LlmPort = {
      complete: () => Promise.reject(new LlmError('Fictional model outage', false)),
    };
    const llm = new LlmService(new LlmSpendRepository(prisma), brokenModel, logger);
    const claimed = await claimOne(lead.id);

    const outcome = await runLeadGraph({ ...deps, label: { ...deps.label, llm } }, claimed);

    expect(outcome).toMatchObject({ status: 'FAILED', step: LEAD_STEP.LABEL });
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      status: 'FAILED',
      failedStep: LEAD_STEP.LABEL,
      error: 'Review labelling failed',
      graphClaimedAt: null,
    });
  });
});

// Proves a run never works on a lead whose claim another pass now holds.
describe('runLeadGraph after losing its claim', () => {
  it('starts no run when the claim was taken before it began', async () => {
    const lead = await prisma.lead.findFirstOrThrow({ where: { campaignId, status: 'SCORED' } });
    await backToDiscovered(lead.id);
    const claimed = await claimOne(lead.id);
    // Another pass took the lead after this claim's lease ran out.
    await prisma.lead.update({ where: { id: lead.id }, data: { graphClaimedAt: new Date() } });

    const outcome = await runLeadGraph(deps, claimed);

    expect(outcome).toEqual({ status: 'CLAIM_LOST' });
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
      status: 'DISCOVERED',
      graphRunId: lead.graphRunId,
    });
  });

  it('cancels the run before its first step when the claim cannot be renewed', async () => {
    const lead = await prisma.lead.findFirstOrThrow({
      where: { campaignId, status: 'DISCOVERED', graphClaimedAt: { not: null } },
    });
    await prisma.lead.update({ where: { id: lead.id }, data: { graphClaimedAt: null } });
    const claimed = await claimOne(lead.id);
    const real = runs();
    const losing: LeadGraphDeps['runs'] = {
      startRun: (claim, runId) => real.startRun(claim, runId),
      renew: () => Promise.resolve(false),
      markEnriched: (leadId) => real.markEnriched(leadId),
      release: (claim) => real.release(claim),
      fail: (claim, step, error) => real.fail(claim, step, error),
    };
    searches.mockClear();

    const outcome = await runLeadGraph({ ...deps, runs: losing }, claimed);

    expect(outcome).toEqual({ status: 'CLAIM_LOST' });
    expect(searches).not.toHaveBeenCalled();
    const stored = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(stored.status).toBe('DISCOVERED');
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: stored.graphRunId ?? '' } });
    expect(run.status).toBe('cancelled');
    await prisma.lead.update({ where: { id: lead.id }, data: { graphClaimedAt: null } });
  });
});

// Proves FR-33: a spend cap pauses the step. The lead keeps its status, is not FAILED, and stays
// claimed so the lease spaces out the next try.
describe('runLeadGraph at a spend cap', () => {
  it('suspends the run at the LLM cap and leaves the lead ENRICHED and claimed', async () => {
    const lead = await prisma.lead.findFirstOrThrow({
      where: { campaignId, status: 'SCORED', reviews: { some: { text: { not: '' } } } },
    });
    await prisma.review.updateMany({ where: { leadId: lead.id }, data: { labels: [] } });
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'ENRICHED' } });

    await withCap({ llmMonthlyUsd: '0.00' }, async () => {
      const claimed = await claimOne(lead.id);

      const outcome = await runLeadGraph(deps, claimed);

      expect(outcome).toMatchObject({ status: 'PAUSED', step: LEAD_STEP.LABEL });
      const stored = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(stored).toMatchObject({ status: 'ENRICHED', failedStep: null, error: null });
      expect(stored.graphClaimedAt).not.toBeNull();
      expect((await runOf(outcome)).status).toBe('suspended');
    });
  });

  it('suspends the run at the Perplexity cap without searching', async () => {
    const lead = await prisma.lead.findFirstOrThrow({
      where: { campaignId, status: 'SCORED', websiteStatus: { not: 'PENDING' } },
    });
    await backToDiscovered(lead.id);
    searches.mockClear();

    await withCap({ perplexityDailyUsd: '0.00' }, async () => {
      const claimed = await claimOne(lead.id);

      const outcome = await runLeadGraph(deps, claimed);

      expect(outcome).toMatchObject({ status: 'PAUSED', step: LEAD_STEP.CONTEXT });
      expect(searches).not.toHaveBeenCalled();
      expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({
        status: 'DISCOVERED',
        error: null,
      });
      expect((await runOf(outcome)).status).toBe('suspended');
    });
  });
});
