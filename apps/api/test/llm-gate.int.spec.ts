/**
 * Integration test of the LLM gate on real Postgres with a stub model: the model comes from
 * Settings, every call leaves a cost record, the monthly cap refuses a call before it is sent, and
 * a bad answer is retried once.
 *
 * Serves: FR-13, FR-33, NFR-4, ADR-0006; issue #13 acceptance ("with a tiny cap the second call is
 * refused").
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DEFAULT_SETTINGS } from '@voxflow/shared';
import { resolve } from 'node:path';
import { z } from 'zod';
import { LlmSpendRepository } from '../src/db/llm-spend.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { LlmOutputInvalidError, LlmService, SpendCapReachedError } from '../src/llm/llm.service.js';
import type { Logger } from '../src/logging/logger.js';
import { LlmError, type LlmPort, type LlmReply, type LlmRequest } from '../src/ports/llm.port.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

// 12 Nov 2026, 15:00 in Karachi: the capped month began at 2026-10-31T19:00Z.
const NOW = new Date('2026-11-12T10:00:00.000Z');
const Labels = z.object({ labels: z.array(z.string()).min(1) });

const answer = (text: string, outputTokens = 600): LlmReply => ({
  text,
  usage: { inputTokens: 3_000, outputTokens },
  model: 'claude-haiku-5-5',
  stopReason: 'end_turn',
});
const good = answer('{"labels":["PHONE_UNANSWERED"]}');

/** A model that answers from a queue and keeps every request it got. */
class StubModel implements LlmPort {
  requests: LlmRequest[] = [];
  queue: (LlmReply | Error)[] = [];
  complete(request: LlmRequest): Promise<LlmReply> {
    this.requests.push(request);
    const next = this.queue.shift() ?? good;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

class AtNow extends LlmService {
  protected override now(): Date {
    return NOW;
  }
}

let prisma: PrismaProvider;
let model: StubModel;
let gate: LlmService;
const warn = jest.fn();

// Each test spends in its own organization, so one test's spend never counts against another's.
const organization = async (caps: Partial<typeof DEFAULT_SETTINGS.spendCaps> = {}) => {
  const { id } = await prisma.organization.create({ data: { name: 'Fictional Org' } });
  await prisma.settings.create({
    data: {
      ...DEFAULT_SETTINGS,
      organizationId: id,
      spendCaps: { ...DEFAULT_SETTINGS.spendCaps, ...caps },
    },
  });
  return id;
};
const call = (organizationId: string) => ({
  organizationId,
  campaignId: null,
  leadId: null,
  task: 'REVIEW_LABELLING' as const,
  system: 'Label each review.',
  user: 'Fictional review: nobody picks up the phone',
  schema: Labels,
  maxTokens: 2_000,
});
const costsOf = (organizationId: string) =>
  prisma.costRecord.findMany({ where: { organizationId, service: 'LLM' }, orderBy: { at: 'asc' } });

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_llm_gate_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  model = new StubModel();
  gate = new AtNow(new LlmSpendRepository(prisma), model, { warn } as unknown as Logger);
  warn.mockClear();
});

// Proves a call runs on the Settings model and leaves a cost record tied to its lead and campaign.
describe('LlmService.complete', () => {
  it('uses the task model from Settings and records the cost against the lead', async () => {
    const niche = await prisma.nicheProfile.findFirstOrThrow();
    const campaign = await prisma.campaign.create({
      data: { organizationId: SEED_ORGANIZATION_ID, nicheProfileId: niche.id, city: 'Lahore' },
    });
    const lead = await prisma.lead.create({
      data: {
        organizationId: SEED_ORGANIZATION_ID,
        campaignId: campaign.id,
        placeId: 'gate-1',
        name: 'Fictional Clinic',
        rawPlace: {},
      },
    });

    const result = await gate.complete({
      ...call(SEED_ORGANIZATION_ID),
      campaignId: campaign.id,
      leadId: lead.id,
    });

    expect(model.requests[0]).toMatchObject({
      task: 'REVIEW_LABELLING',
      model: 'claude-haiku-5-5',
    });
    expect(result).toMatchObject({
      data: { labels: ['PHONE_UNANSWERED'] },
      model: 'claude-haiku-5-5',
    });
    expect(result.costUsd.toString()).toBe('0.0006');
    const [record] = await costsOf(SEED_ORGANIZATION_ID);
    expect(record).toMatchObject({ leadId: lead.id, campaignId: campaign.id, units: 3_600 });
    expect(record?.amountUsd.toString()).toBe('0.0006');
    expect(JSON.parse(record?.note ?? '')).toEqual({
      task: 'REVIEW_LABELLING',
      model: 'claude-haiku-5-5',
      attempt: 1,
      inputTokens: 3_000,
      outputTokens: 600,
    });
  });

  it('refuses a task whose model has no price, before anything is sent', async () => {
    const org = await organization();
    await prisma.settings.update({
      where: { organizationId: org },
      data: { llmModels: { ...DEFAULT_SETTINGS.llmModels, REVIEW_LABELLING: 'fictional-model' } },
    });

    await expect(gate.complete(call(org))).rejects.toThrow(
      'No LLM price for model fictional-model',
    );
    expect(model.requests).toHaveLength(0);
    expect(await costsOf(org)).toHaveLength(0);
  });
});

// Proves the cap looks ahead: a call is refused when its worst case could pass the month's cap.
describe('LlmService monthly cap', () => {
  it('refuses the second call once the first has used a tiny cap, and never sends it', async () => {
    // SpendCaps takes whole cents, so the tiny cap is $0.01. With an 18,000-token answer a call's
    // worst case is about $0.0091, so the first fits; it really uses 3,000 + 17,000 tokens
    // ($0.0088), after which the second call's worst case no longer fits.
    const org = await organization({ llmMonthlyUsd: '0.01' });
    model.queue = [answer('{"labels":["OTHER"]}', 17_000)];
    const big = { ...call(org), maxTokens: 18_000 };

    await gate.complete(big);
    const refused = await gate.complete(big).catch((caught: unknown) => caught);

    expect(refused).toBeInstanceOf(SpendCapReachedError);
    expect((refused as SpendCapReachedError).reason).toMatch(
      /^LLM monthly cap: \$0\.0088 spent this month, .* the cap is \$0\.0100$/,
    );
    expect(model.requests).toHaveLength(1);
    expect(await costsOf(org)).toHaveLength(1);
  });

  it.each([
    ['one second before the Karachi month began', '2026-10-31T18:59:59.000Z', false],
    ['at the moment the Karachi month began', '2026-10-31T19:00:00.000Z', true],
  ])('with the whole cap spent %s, refuses: %s', async (_when, at, refused) => {
    const org = await organization({ llmMonthlyUsd: '1.00' });
    await prisma.costRecord.create({
      data: { organizationId: org, service: 'LLM', amountUsd: '1.00', at: new Date(at) },
    });

    const outcome = await gate.complete(call(org)).catch((caught: unknown) => caught);

    expect(outcome instanceof SpendCapReachedError).toBe(refused);
  });
});

// Proves a bad answer gets exactly one retry that names its problems, and both calls are paid for.
describe('LlmService answer checks', () => {
  it('retries once with the problems appended, then returns the good answer', async () => {
    const org = await organization();
    model.queue = [answer('{"labels":"SECRET_MARKER"}'), good];

    const result = await gate.complete(call(org));

    expect(result.data).toEqual({ labels: ['PHONE_UNANSWERED'] });
    expect(result.costUsd.toString()).toBe('0.0012');
    expect(model.requests[1]?.user).toMatch(/^Fictional review: nobody picks up the phone\n\n/);
    expect(model.requests[1]?.user).toContain('labels');
    expect(
      (await costsOf(org)).map(
        (record) => (JSON.parse(record.note ?? '') as { attempt: number }).attempt,
      ),
    ).toEqual([1, 2]);
    // Logs say which task and attempt failed, never the answer or the prompt.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/SECRET_MARKER|nobody picks up/);
  });

  it('throws LlmOutputInvalidError after a second bad answer, with both calls recorded', async () => {
    const org = await organization();
    model.queue = [answer('not json at all'), answer('{"labels":"PHONE_UNANSWERED"}')];

    await expect(gate.complete(call(org))).rejects.toBeInstanceOf(LlmOutputInvalidError);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.user).toContain('not valid JSON');
    expect(await costsOf(org)).toHaveLength(2);
  });
});

// Proves a failed call costs what it may have cost: its worst case if it may have been billed.
describe('LlmService failed calls', () => {
  it('records the worst case for a call that may have been billed, then rethrows', async () => {
    const org = await organization();
    model.queue = [new LlmError('Anthropic API timed out', true)];

    await expect(gate.complete(call(org))).rejects.toThrow('timed out');
    const [record] = await costsOf(org);
    expect(record).toMatchObject({ units: 0 });
    expect(JSON.parse(record?.note ?? '')).toMatchObject({ estimated: true });
    expect(record?.amountUsd.toNumber()).toBeGreaterThan(0.001);
  });

  it('records nothing for a call that was not billed', async () => {
    const org = await organization();
    model.queue = [new LlmError('Anthropic API refused the request: HTTP 400', false)];

    await expect(gate.complete(call(org))).rejects.toThrow('HTTP 400');
    expect(await costsOf(org)).toHaveLength(0);
  });
});
