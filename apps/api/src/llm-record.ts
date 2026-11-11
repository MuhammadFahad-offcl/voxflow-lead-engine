/**
 * Entry point of `pnpm llm:record`: records the real model's review-labelling answers for the
 * fictional demo clinics, so the fake LLM can replay them in demo mode and in tests. Not part of
 * the app. Costs real money: run it only with the founder's approval.
 *
 * Serves: FR-13, FR-36 (demo mode with recorded LLM responses), FR-33, ADR-0006, ADR-0007;
 * issue #13 (labelling fixtures for the demo clinics; one lead costs < $0.001).
 * Used by: the root package.json script `llm:record`, which runs it through tsx with `.env`.
 *
 * Each call goes through the real LLM gate against the database in DATABASE_URL, so it is counted
 * against the monthly LLM cap and leaves a CostRecord (no lead, no campaign), like any other call.
 * On top of that, the script stops before any call that could take its own total past `--max-usd`
 * (default $0.10), counting a possible retry with its longer prompt. It prints the total so far
 * even when it stops early.
 * It builds each prompt as the labelling step would from the stored reviews: the 30 newest,
 * star-only reviews left out, newest first. That holds while no two reviews of a demo clinic share
 * a date, because the database breaks a tie by random id; the demo test fails if it ever differs.
 * A clinic already recorded is skipped unless `--force`.
 * `--size-check` also sends one call with 30 reviews made from the demo texts and records nothing:
 * it measures what a full-size lead costs.
 * It prints place ids, review counts, label counts and dollars; never the API key.
 * Usage: `pnpm llm:record [--max-usd=0.10] [--force] [--size-check]`.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { NicheFile } from '@voxflow/shared';
import { z } from 'zod';
import { AnthropicLlmAdapter } from './adapters/llm/anthropic.adapter.js';
import { llmFixturePath } from './adapters/llm/fake.adapter.js';
import { ScraperlinkReviewsItem } from './adapters/lead-source/apify-items.js';
import { loadEnv } from './config/env.js';
import { llmMaxCostUsd } from './config/llm-prices.js';
import { LlmSpendRepository } from './db/llm-spend.repository.js';
import { PrismaProvider } from './db/prisma.provider.js';
import { Prisma } from './generated/prisma/client.js';
import { LlmService } from './llm/llm.service.js';
import { buildLabellingTask, type ReviewToLabel } from './llm/review-labelling.js';
import { createLogger } from './logging/logger.js';
import { karachiMonthStart } from './pipeline/spend-cap.js';
import { mapReviewsToRows } from './pipeline/review-mapper.js';
import type { LlmPort, LlmReply, LlmRequest } from './ports/llm.port.js';

const REPO = resolve(import.meta.dirname, '../../..');
const FIXTURES_DIR = resolve(REPO, 'fixtures/llm');

/** Calls the real model and saves each answer where the fake adapter will look for it. */
class RecordingLlm implements LlmPort {
  /**
   * Wraps the real adapter.
   * @param real - The Anthropic adapter.
   */
  constructor(private readonly real: LlmPort) {}

  /**
   * Sends the request and saves the raw answer and its usage, a bad answer included: the gate's
   * retry prompt differs, so the fake replays the same two steps.
   * @param request - The request.
   * @returns The real answer.
   */
  async complete(request: LlmRequest): Promise<LlmReply> {
    const reply = await this.real.complete(request);
    const path = llmFixturePath(FIXTURES_DIR, request);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(reply, null, 2)}\n`);
    return reply;
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

// The rows the labelling step would send for one clinic: newest first, star-only ones left out.
// Review dates within a clinic must not tie (see the header).
const toLabel = (item: ScraperlinkReviewsItem): ReviewToLabel[] =>
  mapReviewsToRows('recording', item.reviews)
    .filter((row) => row.text.trim() !== '')
    .map((row) => ({ id: row.externalId, text: row.text, rating: row.rating }));

// An amount above zero. NaN or Infinity would switch the guard off, so they are refused.
const MaxUsd = z
  .string()
  .regex(/^\d+(\.\d+)?$/, '--max-usd must be an amount in US dollars, e.g. 0.10')
  .refine((usd) => Number(usd) > 0, '--max-usd must be more than 0');
// Room for the problem list the gate appends to a retry's prompt.
const RETRY_PROMPT_ALLOWANCE = ' '.repeat(2_000);

const labelCounts = (answer: { reviews: { labels: string[] }[] }): string => {
  const counts = new Map<string, number>();
  for (const label of answer.reviews.flatMap((review) => review.labels)) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label}×${String(count)}`).join(' ');
};

/**
 * Records the demo answers and, when asked, measures a 30-review call.
 * @param args - Command-line arguments after the script name.
 */
async function main(args: readonly string[]): Promise<void> {
  const maxArg = MaxUsd.safeParse(
    args.find((arg) => arg.startsWith('--max-usd='))?.split('=')[1] ?? '0.10',
  );
  if (!maxArg.success) throw new Error(maxArg.error.issues[0]?.message ?? 'Invalid --max-usd');
  const maxUsd = new Prisma.Decimal(maxArg.data);
  const env = loadEnv(process.env);
  if (env.ANTHROPIC_API_KEY === undefined) {
    throw new Error('ANTHROPIC_API_KEY is not set in .env');
  }
  const logger = createLogger(env.LOG_LEVEL);
  const prisma = new PrismaProvider(env);
  const spend = new LlmSpendRepository(prisma);
  const real = new AnthropicLlmAdapter(env, logger);
  const recording = new LlmService(spend, new RecordingLlm(real), logger);
  const measuring = new LlmService(spend, real, logger);
  // Outside the try, so the total so far is printed even when a call fails or the guard stops.
  let total = new Prisma.Decimal(0);
  try {
    const organization = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
    if (organization === null) throw new Error('No organization found: run pnpm db:seed');
    const niche = NicheFile.parse(
      JSON.parse(await readFile(resolve(REPO, 'config/niches/dental-clinic.json'), 'utf8')),
    );
    const demo = z
      .array(ScraperlinkReviewsItem)
      .parse(
        JSON.parse(await readFile(resolve(REPO, 'fixtures/reviews/dental-lahore.json'), 'utf8')),
      );
    const { model } = await spend.budget(
      organization.id,
      'REVIEW_LABELLING',
      karachiMonthStart(new Date()),
    );
    const run = async (label: string, reviews: ReviewToLabel[], gate: LlmService) => {
      const task = await buildLabellingTask(reviews, niche.reviewLabels);
      // The first attempt's worst case, and a retry's with its longer prompt.
      const worst = llmMaxCostUsd({ ...task, model }).plus(
        llmMaxCostUsd({ ...task, model, user: task.user + RETRY_PROMPT_ALLOWANCE }),
      );
      if (total.plus(worst).greaterThan(maxUsd)) {
        throw new Error(
          `Stopped before ${label}: it could take the total past $${maxUsd.toFixed(2)}`,
        );
      }
      const result = await gate.complete({
        organizationId: organization.id,
        campaignId: null,
        leadId: null,
        task: 'REVIEW_LABELLING',
        system: task.system,
        user: task.user,
        schema: task.schema,
        maxTokens: task.maxTokens,
      });
      total = total.plus(result.costUsd);
      process.stdout.write(
        `${label}: ${String(reviews.length)} reviews, ${labelCounts(result.data)}, $${result.costUsd.toFixed(5)}\n`,
      );
    };

    for (const item of demo) {
      const reviews = toLabel(item);
      if (reviews.length === 0) {
        process.stdout.write(`${item.placeId}: no review with text, no call\n`);
        continue;
      }
      const task = await buildLabellingTask(reviews, niche.reviewLabels);
      const path = llmFixturePath(FIXTURES_DIR, { task: 'REVIEW_LABELLING', ...task });
      if (!args.includes('--force') && (await exists(path))) {
        process.stdout.write(`${item.placeId}: already recorded\n`);
        continue;
      }
      await run(item.placeId, reviews, recording);
    }

    if (args.includes('--size-check')) {
      const texts = demo.flatMap(toLabel);
      const thirty = Array.from({ length: 30 }, (_, index) => {
        const review = texts[index % texts.length];
        if (review === undefined) throw new Error('The demo has no review with text');
        return { ...review, id: `size-check-${String(index)}` };
      });
      await run('size check (30 reviews, not recorded)', thirty, measuring);
    }
  } finally {
    process.stdout.write(`Total: $${total.toFixed(5)}\n`);
    await prisma.$disconnect();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // Only the message: the script's own messages are fixed, and an LlmError never holds a prompt.
  process.stderr.write(`${error instanceof Error ? error.message : 'Recording failed'}\n`);
  process.exitCode = 1;
});
