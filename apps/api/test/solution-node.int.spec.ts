/**
 * Integration tests of the lead graph's SOLUTION node on the DHA demo campaign, with every fake
 * adapter and the recorded solution answers: #19's acceptance test, which scored leads the runner
 * takes, when a campaign moves on, and a failed solution and its retry.
 *
 * Serves: FR-17, FR-32 (fail once, retry from the failed step), FR-33 and NFR-4 (cost per lead),
 * FR-36 (demo mode); issue #19.
 * The cases share one demo database and run in order: each puts back the lead, campaign status or
 * cap it needs first.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { FakeEmbeddingAdapter } from '../src/adapters/embedding/fake.adapter.js';
import { FakeLeadSourceAdapter } from '../src/adapters/lead-source/fake.adapter.js';
import { FakeLlmAdapter } from '../src/adapters/llm/fake.adapter.js';
import { FakeWebContextAdapter } from '../src/adapters/web-context/fake.adapter.js';
import { FakeWebReaderAdapter } from '../src/adapters/web-reader/fake.adapter.js';
import { LeadRunRepository } from '../src/db/lead-run.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { Prisma } from '../src/generated/prisma/client.js';
import type { Logger } from '../src/logging/logger.js';
import { LeadsRepository } from '../src/modules/leads/leads.repository.js';
import { LeadsService } from '../src/modules/leads/leads.service.js';
import { runDemoClinics } from '../src/pipeline/demo-campaign.js';
import { runLeadGraph } from '../src/pipeline/lead.graph.js';
import { PaidStartGate } from '../src/pipeline/paid-start-gate.js';
import { karachiDayStart } from '../src/pipeline/spend-cap.js';
import { LlmError, type LlmPort } from '../src/ports/llm.port.js';
import {
  buildLeadRunnerDeps,
  LEAD_LEASE_MS,
  runLeadRunnerOnce,
  type LeadRunnerParts,
} from '../src/scheduler/lead-runner.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

// Whole demo runs: Jest's 5-second default is too short under the full suite's load.
jest.setTimeout(120_000);
const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as Logger;
const embedder = new FakeEmbeddingAdapter();
let prisma: PrismaProvider;
let campaignId: string;

// Builds the runner the way worker.ts does, on the demo fakes unless a test swaps one.
const runner = (swap: Partial<LeadRunnerParts> = {}) =>
  buildLeadRunnerDeps({
    prisma,
    leadSource: new FakeLeadSourceAdapter(logger),
    webReader: new FakeWebReaderAdapter(),
    webContext: new FakeWebContextAdapter(),
    llm: new FakeLlmAdapter(),
    embedder,
    logger,
    now: () => new Date(),
    concurrency: 4,
    startGate: new PaidStartGate(),
    ...swap,
  });

const leadAt = (place: string) =>
  prisma.lead.findFirstOrThrow({ where: { placeId: `fictional-place-${place}` } });
// As if the lead's solution step never finished (paused at a cap, or stopped by a crash).
const unsolve = async (place: string) => {
  const lead = await leadAt(place);
  await prisma.solution.deleteMany({ where: { leadId: lead.id } });
  return lead;
};
// The solution agent's model calls on a lead; its labelling call is a separate LLM cost record.
const solutionCalls = (leadId: string) =>
  prisma.costRecord.count({
    where: { service: 'LLM', leadId, note: { contains: '"task":"SOLUTION"' } },
  });
const setPerplexityCap = async (usd: string) => {
  const { spendCaps } = await prisma.settings.findFirstOrThrow();
  await prisma.settings.updateMany({
    data: { spendCaps: { ...(spendCaps as object), perplexityDailyUsd: usd } },
  });
};
const setCampaign = (status: 'ENRICHING' | 'SCORING' | 'PAUSED') =>
  prisma.campaign.update({
    where: { id: campaignId },
    data: { status, pausedFrom: status === 'PAUSED' ? 'SCORING' : null },
  });

beforeAll(async () => {
  prisma = new PrismaProvider(
    testEnv({ DATABASE_URL: await createTestDatabase('voxflow_solution_node_test') }),
  );
  await runDemoClinics(prisma, logger, embedder);
  ({ id: campaignId } = await prisma.campaign.findFirstOrThrow());
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
});

// Proves #19's acceptance: each WARM demo clinic ends with a Solution or an exit status, and every
// model call of the run is recorded against its lead and campaign.
describe('SOLUTION node on the demo campaign', () => {
  it('gives each WARM clinic the recorded Solution or exit status, with its cost per lead', async () => {
    const warm = await prisma.lead.findMany({
      where: { tier: { in: ['WARM', 'HOT'] } },
      orderBy: { placeId: 'asc' },
      include: { solution: { include: { service: true } }, signals: true },
    });
    const outcomes = Object.fromEntries(
      warm.map(({ placeId, status, solution, signals }) => {
        if (solution === null) return [placeId, status];
        const keys = solution.signalIds.map((id) => signals.find((s) => s.id === id)?.key);
        return [placeId, `${solution.service.slug} [${keys.join(', ')}] by ${solution.model}`];
      }),
    );

    expect(outcomes).toEqual({
      'fictional-place-p01':
        'missed-call-whatsapp-reply [phone_unanswered_reviews, mobile_number] by claude-haiku-5-5',
      'fictional-place-p03': 'NO_STRONG_SIGNAL',
      'fictional-place-p06':
        'whatsapp-booking-assistant [booking_wait_reviews, no_online_booking] by claude-haiku-5-5',
      'fictional-place-p07':
        'whatsapp-booking-assistant [booking_wait_reviews, category_match] by claude-haiku-5-5',
      'fictional-place-p10':
        'online-booking-page [no_online_booking, working_website] by claude-haiku-5-5',
      'fictional-place-p11':
        'online-booking-page [no_online_booking, working_website] by claude-haiku-5-5',
    });
    // Two turns per agent run (tool, answer); p03's rejected pick and retry make four.
    const agentTurns = Object.fromEntries(
      await Promise.all(
        warm.map(async ({ id, placeId }): Promise<[string, number]> => [
          placeId,
          await solutionCalls(id),
        ]),
      ),
    );
    expect(agentTurns).toEqual({
      'fictional-place-p01': 2,
      'fictional-place-p03': 4,
      'fictional-place-p06': 2,
      'fictional-place-p07': 2,
      'fictional-place-p10': 2,
      'fictional-place-p11': 2,
    });
    // Every model call of the run names its lead and campaign: the solution step never passes null.
    expect(
      await prisma.costRecord.count({
        where: { service: 'LLM', OR: [{ leadId: null }, { campaignId: null }] },
      }),
    ).toBe(0);
    // One query embedding per agent run, each recorded on its lead: six clinics, and p03 runs twice
    // (its first pick was rejected).
    expect(
      await prisma.costRecord.count({
        where: { service: 'PERPLEXITY_EMBEDDINGS', leadId: { in: warm.map(({ id }) => id) } },
      }),
    ).toBe(7);
    expect(await prisma.solution.count({ where: { lead: { tier: 'COLD' } } })).toBe(0);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe(
      'SCORING',
    );
  });
});

// Proves the runner resumes a WARM lead with no Solution at SOLUTION, but only in a running
// campaign (ENRICHING or SCORING), never in a PAUSED one.
describe('claiming a scored lead for its solution', () => {
  it('leaves it in a PAUSED campaign and takes it to SOLUTION once the campaign runs', async () => {
    const lead = await unsolve('p01');
    const leads = new LeadRunRepository(prisma);
    await setCampaign('PAUSED');

    expect(await leads.claimNext(new Date(), LEAD_LEASE_MS, 100)).toEqual([]);

    await setCampaign('SCORING');
    const claimed = await leads.claimNext(new Date(), LEAD_LEASE_MS, 100);
    expect(claimed.map(({ id, status }) => [id, status])).toEqual([[lead.id, 'SCORED']]);
    const [held] = claimed;
    if (held === undefined) throw new Error('no lead claimed');
    const outcome = await runLeadGraph(runner().graph, held);

    expect(outcome.status).toBe('COMPLETED');
    const run = await prisma.agentRun.findFirstOrThrow({
      where: { id: outcome.status === 'COMPLETED' ? outcome.runId : '' },
    });
    expect(run.input).toEqual({ leadId: lead.id, entry: 'SOLUTION' });
    expect(await prisma.solution.count({ where: { leadId: lead.id } })).toBe(1);
  });
});

// Proves FR-32 for the solution step: an outage fails the lead once, the runner never takes it
// again by itself, and the founder's retry runs it again from SOLUTION, not from the start.
describe('a SOLUTION step that fails', () => {
  it('fails the lead, is not taken again, and a retry restarts it at SOLUTION', async () => {
    const lead = await unsolve('p10');
    await setCampaign('SCORING');
    const outage: LlmPort = {
      complete: () => Promise.reject(new LlmError('Fictional LLM outage', false)),
    };

    await runLeadRunnerOnce(runner({ llm: outage }));
    expect(await leadAt('p10')).toMatchObject({ status: 'FAILED', failedStep: 'SOLUTION' });
    expect((await runLeadRunnerOnce(runner())).leads).toBe(0);

    await expect(new LeadsService(new LeadsRepository(prisma)).retry(lead.id)).resolves.toEqual({
      id: lead.id,
      status: 'SCORED',
    });
    const reads = jest.fn((url: string) => new FakeWebReaderAdapter().read(url));
    await runLeadRunnerOnce(runner({ webReader: { read: reads } }));

    const retried = await leadAt('p10');
    expect(retried.status).toBe('SCORED');
    expect(await prisma.solution.count({ where: { leadId: lead.id } })).toBe(1);
    expect(reads).not.toHaveBeenCalled();
    const run = await prisma.agentRun.findUniqueOrThrow({
      where: { id: retried.graphRunId ?? '' },
    });
    expect(run.input).toEqual({ leadId: lead.id, entry: 'SOLUTION' });
  });
});

// Proves the shared Perplexity cap holds the solution step (#19): search spend alone leaves room
// for one more query embedding, the day's embeddings with it do not. The lead pauses, then resumes.
describe('the Perplexity cap on the solution step', () => {
  it('pauses a lead when search and embedding spend together would pass the cap', async () => {
    const lead = await unsolve('p07');
    await setCampaign('SCORING');
    // One clock for the test and the runner, so both count the same Asia/Karachi day.
    const now = new Date();
    const since = karachiDayStart(now);
    const spent = async (service: 'PERPLEXITY_SEARCH' | 'PERPLEXITY_EMBEDDINGS') =>
      (
        await prisma.costRecord.aggregate({
          where: { service, at: { gte: since } },
          _sum: { amountUsd: true },
        })
      )._sum.amountUsd ?? new Prisma.Decimal(0);
    // A cap in whole cents (as Settings holds it) with room for the next query embedding on
    // today's search spend alone; an earlier embedding row fills that room, so the two together
    // leave none.
    const searched = await spent('PERPLEXITY_SEARCH');
    const capUsd = searched.plus('0.00001').toDecimalPlaces(2, Prisma.Decimal.ROUND_UP);
    await prisma.costRecord.create({
      data: {
        organizationId: lead.organizationId,
        service: 'PERPLEXITY_EMBEDDINGS',
        amountUsd: capUsd.minus(searched),
      },
    });
    await setPerplexityCap(capUsd.toFixed(2));
    const embeddings = () =>
      prisma.costRecord.count({ where: { service: 'PERPLEXITY_EMBEDDINGS' } });
    const before = await embeddings();
    const turnsBefore = await solutionCalls(lead.id);

    expect((await runLeadRunnerOnce(runner({ now: () => now }))).paused).toBe(1);
    expect(await leadAt('p07')).toMatchObject({ status: 'SCORED', failedStep: null });
    expect(await prisma.solution.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await embeddings()).toBe(before);
    // The agent's first turn (asking for the search) is paid before the search meets the cap.
    expect(await solutionCalls(lead.id)).toBe(turnsBefore + 1);

    // Once the cap allows it and the paused claim has run out, the lead resumes at SOLUTION.
    await setPerplexityCap('2.00');
    const later = () => new Date(now.getTime() + LEAD_LEASE_MS + 1000);
    await runLeadRunnerOnce(runner({ now: later }));
    expect(await prisma.solution.count({ where: { leadId: lead.id } })).toBe(1);
    expect(
      await prisma.costRecord.count({
        where: { service: 'PERPLEXITY_EMBEDDINGS', leadId: lead.id },
      }),
    ).toBeGreaterThan(0);
    // The resumed run pays both turns again: a pause mid-agent repeats the turn already paid.
    expect(await solutionCalls(lead.id)).toBe(turnsBefore + 3);
  });
});

// Proves the campaign waits in ENRICHING for its WARM leads' solutions, and is never stuck there:
// a FAILED WARM lead, or a campaign of only COLD leads, lets it move on.
describe('moving a campaign on to SCORING', () => {
  it('waits for a WARM lead with no Solution, and moves on once that lead FAILED', async () => {
    const lead = await unsolve('p06');
    const leads = new LeadRunRepository(prisma);
    await setCampaign('ENRICHING');

    expect(await leads.finishEnrichment()).toEqual([]);

    await prisma.lead.update({
      where: { id: lead.id },
      data: { status: 'FAILED', failedStep: 'SOLUTION' },
    });
    expect(await leads.finishEnrichment()).toEqual([campaignId]);
  });

  it('moves on a campaign whose scored leads are all COLD', async () => {
    await prisma.solution.deleteMany();
    await prisma.lead.updateMany({
      where: { campaignId, status: { not: 'FILTERED_OUT' } },
      data: { status: 'SCORED', tier: 'COLD', failedStep: null },
    });
    await setCampaign('ENRICHING');

    expect(await new LeadRunRepository(prisma).finishEnrichment()).toEqual([campaignId]);
  });
});
