/**
 * Integration test of the first migration, the invariants it adds by hand and the Prisma provider.
 *
 * Serves: ADR-0002, docs/database.md "Invariants" (issue #5, database setup; pausedFrom, issue #8).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
// Not the package root: 2.0.13's index needs @hazeljs/eval, which is not installed.
import { createSqlDurableRunStore } from '@hazeljs/agent/dist/run/durable-run-store.js';
import type { HazelApp } from '@hazeljs/core';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let testUrl: string;
let prisma: PrismaClient;

// `migrate deploy` starts a process and can download the schema engine on a fresh machine.
beforeAll(async () => {
  testUrl = await createTestDatabase();
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl }) });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

// Proves the hand-added lines of the first migration (docs/database.md checklist) and the run tables.
describe('first migration', () => {
  it('creates the vector extension', async () => {
    const rows = await prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname = 'vector'`;

    expect(rows).toEqual([{ extname: 'vector' }]);
  });

  it('creates the Service embedding index as HNSW with cosine distance', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'service_embedding_hnsw'`;

    expect(rows[0]?.indexdef).toContain('USING hnsw (embedding vector_cosine_ops)');
  });

  it('creates run tables that the HazelJS SQL durable store can write to', async () => {
    // HazelJS types each delegate as `(args: unknown) => ...`; Prisma's generic ones are narrower.
    const client = prisma as unknown as Parameters<typeof createSqlDurableRunStore>[0];
    const { runRepository } = createSqlDurableRunStore(client);

    await runRepository.create({ id: 'run-fictional-1', agentName: 'fictional-agent' });

    expect(await runRepository.get('run-fictional-1')).toMatchObject({
      agentName: 'fictional-agent',
    });
  });
});

// Proves the database itself refuses a third call attempt, a duplicate business (FR-7, FR-23) and a
// paused campaign that does not know where to resume (FR-3).
describe('database invariants', () => {
  let organizationId: string;
  let campaignId: string;
  let leadId: string;

  const fictionalLead = (placeId: string) => ({
    organizationId,
    campaignId,
    placeId,
    name: 'Fictional Dental Clinic',
    rawPlace: {},
  });

  const fictionalAttempt = (attemptNumber: number) => ({
    leadId,
    attemptNumber,
    window: 'MORNING' as const,
    scheduledAt: new Date('2026-11-10T05:00:00Z'),
    idempotencyKey: `fictional-attempt-${String(attemptNumber)}`,
  });

  beforeAll(async () => {
    const organization = await prisma.organization.create({ data: { name: 'Fictional Org' } });
    organizationId = organization.id;
    const niche = await prisma.nicheProfile.create({
      data: {
        organizationId,
        slug: 'fictional-niche',
        version: 1,
        name: 'Fictional niche',
        idealClient: {},
        signalWeights: {},
        scriptTemplate: 'Fictional template',
      },
    });
    const campaign = await prisma.campaign.create({
      data: { organizationId, nicheProfileId: niche.id, city: 'Fictional City' },
    });
    campaignId = campaign.id;
    const lead = await prisma.lead.create({ data: fictionalLead('place-fictional-1') });
    leadId = lead.id;
  });

  it('accepts a CallAttempt with attemptNumber 2', async () => {
    const attempt = await prisma.callAttempt.create({ data: fictionalAttempt(2) });

    expect(attempt.attemptNumber).toBe(2);
  });

  it('rejects a CallAttempt with attemptNumber 3', async () => {
    await expect(prisma.callAttempt.create({ data: fictionalAttempt(3) })).rejects.toThrow(
      'attempt_number_1_or_2',
    );
  });

  it('rejects a second Lead with the same organizationId and placeId', async () => {
    await expect(
      prisma.lead.create({ data: fictionalLead('place-fictional-1') }),
    ).rejects.toMatchObject({
      code: 'P2002',
      meta: {
        driverAdapterError: { cause: { constraint: { index: 'Lead_organizationId_placeId_key' } } },
      },
    });
  });

  it('accepts a PAUSED campaign that remembers where to resume', async () => {
    const campaign = await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'PAUSED', pausedFrom: 'SCORING' },
    });

    expect(campaign.pausedFrom).toBe('SCORING');
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'DISCOVERING', pausedFrom: null },
    });
  });

  it.each([
    ['PAUSED without pausedFrom', { status: 'PAUSED' }],
    ['pausedFrom on an active campaign', { status: 'SCORING', pausedFrom: 'ENRICHING' }],
    ['pausedFrom set to a final status', { status: 'PAUSED', pausedFrom: 'COMPLETED' }],
  ] as const)('rejects a Campaign with %s', async (_case, data) => {
    await expect(prisma.campaign.update({ where: { id: campaignId }, data })).rejects.toThrow(
      'campaign_paused_from_only_when_paused',
    );
  });
});

// Proves one client per process and that shutdown really closes its connections (ADR-0002).
describe('PrismaProvider', () => {
  const applicationName = 'voxflow_provider_test';
  let app: HazelApp;

  const openConnections = async (): Promise<number> => {
    const rows = await prisma.$queryRaw<{ open: number }[]>`
      SELECT count(*)::int AS open FROM pg_stat_activity WHERE application_name = ${applicationName}`;
    return rows[0]?.open ?? 0;
  };

  beforeAll(async () => {
    const providerUrl = new URL(testUrl);
    providerUrl.searchParams.set('application_name', applicationName);
    app = await startServer(testEnv({ DATABASE_URL: providerUrl.href }), 0);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('gives every consumer the same instance', () => {
    const container = app.getContainer();

    expect(container.resolve(PrismaProvider)).toBe(container.resolve(PrismaProvider));
  });

  it('closes its connections, after the HTTP server, when the API shuts down', async () => {
    const provider = app.getContainer().resolve(PrismaProvider);
    await provider.$queryRaw`SELECT 1`;
    const openBeforeShutdown = await openConnections();
    let listeningAtDisconnect: boolean | undefined;
    const disconnect = provider.$disconnect.bind(provider);
    jest.spyOn(provider, '$disconnect').mockImplementation(async () => {
      listeningAtDisconnect = app.getServer()?.listening;
      await disconnect();
    });
    // The real shutdown ends with process.exit, which would end the test run too.
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const timers = jest.spyOn(globalThis, 'setTimeout');

    await app.getShutdownManager().shutdown('TEST');
    // ShutdownManager leaves its per-handler timeouts running, because it expects to exit next.
    timers.mock.results.forEach(({ value }) => {
      clearTimeout(value as NodeJS.Timeout);
    });

    expect(openBeforeShutdown).toBeGreaterThan(0);
    expect(await openConnections()).toBe(0);
    expect(listeningAtDisconnect).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
