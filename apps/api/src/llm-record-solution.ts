/**
 * Entry point of `pnpm llm:record:solution`: records the real model's solution-agent answers for the
 * six WARM demo clinics, so the fake LLM can replay them in demo mode and in tests. Not part of the
 * app. Costs real money: run it only with the founder's approval.
 *
 * Serves: FR-17, FR-36 (demo mode with recorded LLM answers), FR-33, ADR-0006, ADR-0007; issue #19.
 * Used by: the root package.json script `llm:record:solution`, which runs it through tsx with `.env`.
 *
 * The answers must replay exactly, so the clinics are built by `runDemoClinics`, as the solution
 * acceptance test builds them, not read from the dev database (its demo leads may come from an
 * older niche version). It creates the scratch database `voxflow_solution_record` next to the dev
 * one, runs the clinics' graphs there with every fake adapter (a WARM clinic whose answer is not
 * recorded yet ends FAILED there, which changes nothing here), then runs the solution agent for the
 * WARM clinics with the real model.
 *
 * Spend is counted where it matters: each call goes through the real LLM gate against the database
 * in DATABASE_URL, so it counts against the monthly LLM cap and leaves a CostRecord there (no lead,
 * no campaign). The dev database gains only those cost rows. On top of that, a guard refuses any
 * call whose worst case (its real prompt and token limit) could take the total past `--max-usd`
 * (default $0.10). The scratch database is dropped at the end, also when a run fails.
 * It prints place ids, outcomes and dollars; never the API key, a prompt or evidence.
 * Usage: `pnpm llm:record:solution [--max-usd=0.10]`.
 */
import { resolve } from 'node:path';
import process from 'node:process';
import { AgentRuntime, LogLevel } from '@hazeljs/agent';
import { z } from 'zod';
import { FakeEmbeddingAdapter } from './adapters/embedding/fake.adapter.js';
import { AnthropicLlmAdapter } from './adapters/llm/anthropic.adapter.js';
import {
  createCatalogSearch,
  registerSolutionAgent,
  runSolutionAgent,
} from './agents/solution.agent.js';
import { loadEnv } from './config/env.js';
import { llmCostUsd, llmMaxCostUsd } from './config/llm-prices.js';
import { CatalogRepository } from './db/catalog.repository.js';
import { LlmSpendRepository } from './db/llm-spend.repository.js';
import { PrismaProvider } from './db/prisma.provider.js';
import { createScratchDatabase, dropScratchDatabase } from './db/scratch-database.js';
import { SEED_ORGANIZATION_ID } from './db/seed.js';
import { SolutionRepository } from './db/solution.repository.js';
import { Prisma } from './generated/prisma/client.js';
import { GATED_RUNTIME_OPTIONS, GatedLlmProvider } from './llm/gated-llm.provider.js';
import { LlmService } from './llm/llm.service.js';
import { RecordingLlm } from './llm/recording-llm.js';
import { createLogger } from './logging/logger.js';
import { runDemoClinics } from './pipeline/demo-campaign.js';
import { karachiMonthStart } from './pipeline/spend-cap.js';
import { LlmError, type LlmPort, type LlmReply, type LlmRequest } from './ports/llm.port.js';

const REPO = resolve(import.meta.dirname, '../../..');
const FIXTURES_DIR = resolve(REPO, 'fixtures/llm');
const SCRATCH_DATABASE = 'voxflow_solution_record';
// The founder approved these six and nothing else; any other set stops the script before a call.
const WARM_CLINICS = ['p01', 'p03', 'p06', 'p07', 'p10', 'p11'].map((p) => `fictional-place-${p}`);
// A typical run: a tool turn, then the answer with the tool's result (tokens, from the first
// recording's usage).
const TYPICAL_TURNS = [
  { inputTokens: 1_900, outputTokens: 26 },
  { inputTokens: 2_400, outputTokens: 120 },
];

// An amount above zero. NaN or Infinity would switch the guard off, so they are refused.
const MaxUsd = z
  .string()
  .regex(/^\d+(\.\d+)?$/, '--max-usd must be an amount in US dollars, e.g. 0.10')
  .refine((usd) => Number(usd) > 0, '--max-usd must be more than 0');

/** Refuses a call whose worst case could take the script's total past its cap; sums the real cost. */
class SpendGuard implements LlmPort {
  /** Real US dollars spent so far. */
  spent = new Prisma.Decimal(0);

  /**
   * Wraps the real adapter.
   * @param real - The Anthropic adapter.
   * @param maxUsd - The script's cap, in US dollars.
   */
  constructor(
    private readonly real: LlmPort,
    private readonly maxUsd: Prisma.Decimal,
  ) {}

  /**
   * Sends the request only when its worst case fits under the cap, then adds its real cost.
   * @param request - The request.
   * @returns The real answer.
   * @throws LlmError (not billed) before a call that could pass the cap; the real adapter's errors.
   */
  async complete(request: LlmRequest): Promise<LlmReply> {
    if (this.spent.plus(llmMaxCostUsd(request)).greaterThan(this.maxUsd)) {
      throw new LlmError(
        `Stopped before a call that could take the total past $${this.maxUsd.toFixed(2)}`,
        false,
      );
    }
    // A reply that fails after billing (e.g. an unexpected shape) is not added, so the printed total
    // can be low; the gate still records that attempt at its worst-case cost against the cap.
    const reply = await this.real.complete(request);
    this.spent = this.spent.plus(llmCostUsd(reply.model, reply.usage));
    return reply;
  }
}

/**
 * Builds the demo clinics in a scratch database and records their solution answers.
 * @param args - Command-line arguments after the script name.
 * @throws Error for a bad `--max-usd`, a missing ANTHROPIC_API_KEY or seeded organization, or a
 * WARM set other than the approved six; LlmError when the guard stops a call; database errors.
 */
async function main(args: readonly string[]): Promise<void> {
  const maxArg = MaxUsd.safeParse(
    args.find((arg) => arg.startsWith('--max-usd='))?.split('=')[1] ?? '0.10',
  );
  if (!maxArg.success) throw new Error(maxArg.error.issues[0]?.message ?? 'Invalid --max-usd');
  const maxUsd = new Prisma.Decimal(maxArg.data);
  const env = loadEnv(process.env);
  if (env.ANTHROPIC_API_KEY === undefined) throw new Error('ANTHROPIC_API_KEY is not set in .env');
  const logger = createLogger(env.LOG_LEVEL);
  // The demo pipeline's own lines would bury the script's output.
  const quiet = createLogger('error');
  const dev = new PrismaProvider(env);
  const spend = new LlmSpendRepository(dev);
  const guard = new SpendGuard(new AnthropicLlmAdapter(env, logger), maxUsd);
  let scratch: PrismaProvider | null = null;
  try {
    // The seeded organization: the clinics belong to it, so their calls are billed to it.
    const organization = await dev.organization.findUnique({ where: { id: SEED_ORGANIZATION_ID } });
    if (organization === null) throw new Error('No seeded organization found: run pnpm db:seed');
    const { model } = await spend.budget(
      organization.id,
      'SOLUTION',
      karachiMonthStart(new Date()),
    );
    const perClinic = TYPICAL_TURNS.reduce(
      (sum, usage) => sum.plus(llmCostUsd(model, usage)),
      new Prisma.Decimal(0),
    );
    process.stdout.write(
      [
        `Clinics: ${WARM_CLINICS.join(', ')}`,
        `Model: ${model} (Settings.llmModels.SOLUTION)`,
        `Estimate: about $${perClinic.toFixed(5)} per clinic (2 calls), $${perClinic.times(WARM_CLINICS.length).toFixed(5)} for all six; a retry doubles a clinic's cost.`,
        `Hard cap: $${maxUsd.toFixed(2)}; any call whose worst case could pass it is refused.`,
        '',
      ].join('\n'),
    );

    const scratchUrl = await createScratchDatabase(env.DATABASE_URL, SCRATCH_DATABASE);
    scratch = new PrismaProvider({ ...env, DATABASE_URL: scratchUrl });
    const embedder = new FakeEmbeddingAdapter();
    const warm = await runDemoClinics(scratch, quiet, embedder);
    const found = warm.map(({ placeId }) => placeId);
    if (found.join() !== WARM_CLINICS.join()) {
      throw new Error(`Expected the six WARM demo clinics, found: ${found.join(', ') || 'none'}`);
    }

    const recording = new LlmService(spend, new RecordingLlm(guard, FIXTURES_DIR), logger);
    const runtime = new AgentRuntime({
      llmProvider: new GatedLlmProvider(recording),
      ...GATED_RUNTIME_OPTIONS,
      logLevel: LogLevel.ERROR,
      enableMetrics: false,
    });
    // No spend: the fake embedder's query costs nothing real, and the scratch leads are not in the
    // database that holds the caps.
    const search = createCatalogSearch(embedder, new CatalogRepository(scratch), null);
    registerSolutionAgent(runtime, search);
    const solutions = new SolutionRepository(scratch);
    for (const { id, placeId } of warm) {
      // No lead or campaign: they exist only in the scratch database, not where the cost is stored.
      const lead = { ...(await solutions.forSolution(id)), campaignId: null, leadId: null };
      const outcome = await runSolutionAgent(runtime, lead);
      const what =
        outcome.kind === 'pick'
          ? `pick ${outcome.serviceSlug} citing ${outcome.signalKeys.join(', ')}`
          : outcome.kind;
      process.stdout.write(`${placeId}: ${what}, $${outcome.costUsd.toFixed(5)}\n`);
    }
  } finally {
    process.stdout.write(`Total spent: $${guard.spent.toFixed(6)}\n`);
    await scratch?.$disconnect();
    await dropScratchDatabase(env.DATABASE_URL, SCRATCH_DATABASE).then(
      () => process.stdout.write(`Dropped ${SCRATCH_DATABASE}\n`),
      () => process.stderr.write(`Could not drop ${SCRATCH_DATABASE}; drop it by hand\n`),
    );
    await dev.$disconnect();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // Only the message, never the stack: an LlmError never holds a prompt, and the rest are the
  // script's own messages or Postgres, Prisma and migrate errors, which hold no secrets.
  process.stderr.write(`${error instanceof Error ? error.message : 'Recording failed'}\n`);
  process.exitCode = 1;
});
