/**
 * Integration test of what the pipeline writes to the log: the whole demo pipeline (discover,
 * reviews, every lead graph) runs with a recording logger, and no log line carries a full phone
 * number or review text (the fixtures store no review authors, like the real mapper).
 *
 * Serves: NFR-5; CLAUDE.md ("Never log secrets, full phone numbers (mask to last 4), transcripts
 * or review authors"); T-1 audit.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FakeLeadSourceAdapter } from '../src/adapters/lead-source/fake.adapter.js';
import { FakeLlmAdapter } from '../src/adapters/llm/fake.adapter.js';
import { FakeWebContextAdapter } from '../src/adapters/web-context/fake.adapter.js';
import { FakeWebReaderAdapter } from '../src/adapters/web-reader/fake.adapter.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed } from '../src/db/seed.js';
import type { Logger } from '../src/logging/logger.js';
import { PaidStartGate } from '../src/pipeline/paid-start-gate.js';
import { buildLeadRunnerDeps, runLeadRunnerOnce } from '../src/scheduler/lead-runner.js';
import { discoverDemoCampaign } from './demo-campaign.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

// Whole demo passes: Jest's 5-second default is too short under the full suite's load.
jest.setTimeout(120_000);

// Every argument of every log call, as JSON.
const lines: string[] = [];
const record =
  (level: string) =>
  (...args: unknown[]): void => {
    lines.push(`${level} ${JSON.stringify(args)}`);
  };
const logger = {
  info: record('info'),
  warn: record('warn'),
  error: record('error'),
  debug: record('debug'),
} as unknown as Logger;

let prisma: PrismaProvider;

beforeAll(async () => {
  prisma = new PrismaProvider(
    testEnv({ DATABASE_URL: await createTestDatabase('voxflow_log_privacy_test') }),
  );
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  await discoverDemoCampaign(prisma, logger, false);
  const deps = buildLeadRunnerDeps({
    prisma,
    leadSource: new FakeLeadSourceAdapter(logger),
    webReader: new FakeWebReaderAdapter(),
    webContext: new FakeWebContextAdapter(),
    llm: new FakeLlmAdapter(),
    logger,
    now: () => new Date(),
    concurrency: 3,
    startGate: new PaidStartGate(),
  });
  for (let pass = 0; pass < 10; pass += 1) {
    if ((await runLeadRunnerOnce(deps)).leads === 0) break;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

// Proves the CLAUDE.md logging rule over a real run: masked phones only, no authors, no review text.
describe('pipeline logs', () => {
  it('were written, and the demo clinics have phones, so the scan means something', async () => {
    expect(lines.length).toBeGreaterThan(20);
    expect(await prisma.lead.count({ where: { phone: { not: null } } })).toBeGreaterThan(0);
  });

  it('carry no full Pakistani phone number, in E.164 or local form', () => {
    // +92 and 10 digits, or a local 03… mobile, with optional spaces or dashes.
    const full = /(?:\+92[\s-]?\d{3}[\s-]?\d{7}|\b0\d{3}[\s-]?\d{7}\b)/;
    // The pattern itself catches what it should, and lets a masked number through.
    expect(['+923001234567', '+92 300 1234567', '0300-1234567'].every((x) => full.test(x))).toBe(
      true,
    );
    expect(full.test('+92*******4567')).toBe(false);
    expect(lines.filter((line) => full.test(line))).toEqual([]);
  });

  it('carry no review author and no review text from the fixtures', () => {
    const fixtures = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../../../fixtures/reviews/dental-lahore.json'),
        'utf8',
      ),
    ) as { reviews: { text?: string | null; name?: string | null }[] }[];
    const secrets = fixtures
      .flatMap((place) => place.reviews)
      .flatMap((review) => [review.text ?? '', review.name ?? ''])
      .filter((text) => text.length >= 12);
    expect(secrets.length).toBeGreaterThan(0);
    expect(secrets.filter((text) => lines.some((line) => line.includes(text)))).toEqual([]);
  });
});
