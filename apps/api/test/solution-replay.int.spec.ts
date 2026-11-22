/**
 * Demo-mode test of the recorded solution answers: builds the DHA demo clinics exactly as
 * `pnpm llm:record:solution` does, then runs the solution agent with the fake LLM, which replays
 * fixtures/llm/solution. Pins each WARM clinic's outcome, so a change to a prompt, a signal or the
 * catalog search shows up here (and means re-recording) before the graph node depends on it.
 *
 * Serves: FR-17, FR-36 (demo mode with recorded LLM answers), NFR-9; issue #19.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { resolve } from 'node:path';
import { AgentRuntime, LogLevel } from '@hazeljs/agent';
import { FakeEmbeddingAdapter } from '../src/adapters/embedding/fake.adapter.js';
import { FakeLeadSourceAdapter } from '../src/adapters/lead-source/fake.adapter.js';
import { FakeLlmAdapter } from '../src/adapters/llm/fake.adapter.js';
import { FakeWebContextAdapter } from '../src/adapters/web-context/fake.adapter.js';
import { FakeWebReaderAdapter } from '../src/adapters/web-reader/fake.adapter.js';
import {
  createCatalogSearch,
  registerSolutionAgent,
  runSolutionAgent,
} from '../src/agents/solution.agent.js';
import { CatalogRepository } from '../src/db/catalog.repository.js';
import { LlmSpendRepository } from '../src/db/llm-spend.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { embedMissingServices, seed } from '../src/db/seed.js';
import { SolutionRepository } from '../src/db/solution.repository.js';
import { GATED_RUNTIME_OPTIONS, GatedLlmProvider } from '../src/llm/gated-llm.provider.js';
import { LlmService } from '../src/llm/llm.service.js';
import type { Logger } from '../src/logging/logger.js';
import { discoverDemoCampaign } from '../src/pipeline/demo-campaign.js';
import { PaidStartGate } from '../src/pipeline/paid-start-gate.js';
import { buildLeadRunnerDeps, runLeadRunnerOnce } from '../src/scheduler/lead-runner.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as Logger;
let prisma: PrismaProvider;

// `migrate deploy` starts a process and can download the schema engine on a fresh machine.
beforeAll(async () => {
  prisma = new PrismaProvider(
    testEnv({ DATABASE_URL: await createTestDatabase('voxflow_solution_replay_test') }),
  );
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

// Proves the recorded answers replay: same clinics, same prompts, same outcomes, no network.
describe('solution agent on the recorded demo answers', () => {
  it('gives each WARM demo clinic the outcome recorded in #19', async () => {
    const embedder = new FakeEmbeddingAdapter();
    await seed(prisma, resolve(import.meta.dirname, '../../../config'));
    await embedMissingServices(prisma, { demoMode: true, embedder, logger });
    await discoverDemoCampaign(prisma, logger);
    const deps = buildLeadRunnerDeps({
      prisma,
      leadSource: new FakeLeadSourceAdapter(logger),
      webReader: new FakeWebReaderAdapter(),
      webContext: new FakeWebContextAdapter(),
      llm: new FakeLlmAdapter(),
      logger,
      now: () => new Date(),
      concurrency: 4,
      startGate: new PaidStartGate(),
    });
    while ((await runLeadRunnerOnce(deps)).leads > 0);

    const runtime = new AgentRuntime({
      llmProvider: new GatedLlmProvider(
        new LlmService(new LlmSpendRepository(prisma), new FakeLlmAdapter(), logger),
      ),
      ...GATED_RUNTIME_OPTIONS,
      logLevel: LogLevel.ERROR,
      enableMetrics: false,
    });
    registerSolutionAgent(runtime, createCatalogSearch(embedder, new CatalogRepository(prisma)));
    const solutions = new SolutionRepository(prisma);
    const warm = await prisma.lead.findMany({
      where: { tier: { in: ['WARM', 'HOT'] } },
      orderBy: { placeId: 'asc' },
      select: { id: true, placeId: true },
    });
    const outcomes: Record<string, string> = {};
    for (const { id, placeId } of warm) {
      // Recorded with no lead or campaign; the replay keys on the prompts only.
      const lead = { ...(await solutions.forSolution(id)), campaignId: null, leadId: null };
      const outcome = await runSolutionAgent(runtime, lead);
      outcomes[placeId] =
        outcome.kind === 'pick'
          ? `${outcome.serviceSlug} [${outcome.signalKeys.join(', ')}]`
          : outcome.kind;
    }

    expect(outcomes).toEqual({
      'fictional-place-p01': 'missed-call-whatsapp-reply [phone_unanswered_reviews, mobile_number]',
      'fictional-place-p03': 'noStrongSignal',
      'fictional-place-p06': 'whatsapp-booking-assistant [booking_wait_reviews, no_online_booking]',
      'fictional-place-p07': 'whatsapp-booking-assistant [booking_wait_reviews, category_match]',
      'fictional-place-p10': 'online-booking-page [no_online_booking, working_website]',
      'fictional-place-p11': 'online-booking-page [no_online_booking, working_website]',
    });
  }, 120_000);
});
