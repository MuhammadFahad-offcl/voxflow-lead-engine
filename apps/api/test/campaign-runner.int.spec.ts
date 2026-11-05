/**
 * Integration test of the campaign runner: real DI in demo mode, real Postgres, racing runners.
 *
 * Serves: FR-3, FR-5, NFR-1, NFR-2, ADR-0007; issue #10 (idempotent, one claim under two runners).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { HazelApp } from '@hazeljs/core';
import { CampaignSummary } from '@voxflow/shared';
import { FakeLeadSourceAdapter } from '../src/adapters/lead-source/fake.adapter.js';
import { DiscoveryRepository } from '../src/db/discovery.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed } from '../src/db/seed.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createLogger, type Logger } from '../src/logging/logger.js';
import { AREAS_DIR, loadAreaPolygons } from '../src/pipeline/area-polygons.js';
import type { DiscoverDeps } from '../src/pipeline/discover.step.js';
import { PaidStartGate } from '../src/pipeline/paid-start-gate.js';
import { readSearchNote, searchNote } from '../src/pipeline/search-plan.js';
import {
  LEAD_SOURCE,
  type LeadSourcePort,
  type PlaceSearch,
} from '../src/ports/lead-source.port.js';
import {
  registerRunnerShutdown,
  runCampaignRunnerOnce,
  startCampaignRunner,
} from '../src/scheduler/campaign-runner.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

const LEASE_MS = 15 * 60 * 1000;
const expected = { status: 'ENRICHING', foundCount: 12, duplicateCount: 1, filteredCount: 2 };

let app: HazelApp;
let baseUrl: string;
let prisma: PrismaProvider;
let deps: DiscoverDeps;
let starts: PlaceSearch[];

// The DI-bound lead source, with a pause in start so racing runners really overlap.
const counting = (leadSource: LeadSourcePort): LeadSourcePort => ({
  chargeLimitUsd: (maxResults) => leadSource.chargeLimitUsd(maxResults),
  start: async (search) => {
    starts.push(search);
    await sleep(10);
    return leadSource.start(search);
  },
  collect: (runId) => leadSource.collect(runId),
});

const post = async (path: string, body?: unknown) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as Record<string, unknown>;
};

const createCampaign = async (): Promise<string> => {
  const body = { nicheSlug: 'dental-clinic', city: 'Lahore', areas: ['DHA'] };
  return String((await post('/campaigns', body))['id']);
};

const row = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });
const claimedAgo = (id: string, ms: number) =>
  prisma.campaign.update({
    where: { id },
    data: { discoveryClaimedAt: new Date(Date.now() - ms) },
  });

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_campaign_runner_test');
  app = await startServer(testEnv({ DATABASE_URL: url }), 0);
  const address = app.getServer()?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('API server is not listening on a TCP port');
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  const container = app.getContainer();
  prisma = container.resolve(PrismaProvider);
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  deps = {
    repository: container.resolve(DiscoveryRepository),
    leadSource: counting(container.resolve<LeadSourcePort>(LEAD_SOURCE)),
    polygons: loadAreaPolygons(AREAS_DIR),
    logger: createLogger('error'),
    now: () => new Date(),
    startGate: new PaidStartGate(),
  };
}, 120_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  starts = [];
  await prisma.costRecord.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.campaign.deleteMany();
});

// Proves issue #10's acceptance in DEMO_MODE: API to ENRICHING through the real wiring.
describe('campaign runner in demo mode', () => {
  it('binds the fake lead source', () => {
    expect(app.getContainer().resolve(LEAD_SOURCE)).toBeInstanceOf(FakeLeadSourceAdapter);
  });

  it('takes a new campaign from the API to ENRICHING with 12 found, 1 duplicate, 2 filtered', async () => {
    const id = await createCampaign();

    await expect(runCampaignRunnerOnce(deps)).resolves.toBe(true);

    const response = await fetch(`${baseUrl}/campaigns/${id}`);
    expect(CampaignSummary.parse(await response.json())).toMatchObject({
      ...expected,
      duplicateRate: 0.08,
      pauseReason: null,
    });
  });

  it('has nothing to do without a DISCOVERING campaign', async () => {
    await expect(runCampaignRunnerOnce(deps)).resolves.toBe(false);
  });
});

// Proves running twice does nothing extra, in sequence and against paused campaigns (NFR-1).
describe('campaign runner idempotency', () => {
  it('does nothing on a second pass', async () => {
    const id = await createCampaign();
    await runCampaignRunnerOnce(deps);
    const before = await row(id);

    await expect(runCampaignRunnerOnce(deps)).resolves.toBe(false);

    expect(starts).toHaveLength(4);
    expect(await row(id)).toEqual(before);
    expect(await prisma.costRecord.count()).toBe(4);
  });

  it('leaves a paused campaign alone until it is resumed', async () => {
    const id = await createCampaign();
    await post(`/campaigns/${id}/pause`);

    await expect(runCampaignRunnerOnce(deps)).resolves.toBe(false);

    await post(`/campaigns/${id}/resume`);
    await expect(runCampaignRunnerOnce(deps)).resolves.toBe(true);
    expect(await row(id)).toMatchObject(expected);
  });

  it('releases its claim when an operator pauses mid-run, so resume need not wait', async () => {
    const id = await createCampaign();
    const pausing: DiscoverDeps = {
      ...deps,
      leadSource: {
        ...deps.leadSource,
        start: async (search) => {
          await post(`/campaigns/${id}/pause`);
          return deps.leadSource.start(search);
        },
      },
    };

    await runCampaignRunnerOnce(pausing);

    expect(await row(id)).toMatchObject({ status: 'PAUSED', discoveryClaimedAt: null });
  });
});

// Proves the claim holds under racing runners: one winner, one set of paid runs, one set of counts.
describe('campaign runner under concurrent runners', () => {
  it('lets one of two runners claim a campaign', async () => {
    const id = await createCampaign();

    const claimed = await Promise.all([runCampaignRunnerOnce(deps), runCampaignRunnerOnce(deps)]);

    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(starts).toHaveLength(4);
    expect(await row(id)).toMatchObject(expected);
    expect(await prisma.lead.count()).toBe(11);
    expect(await prisma.costRecord.count()).toBe(4);
  });

  it.each([1, 2, 3, 4, 5])('holds with 8 runners racing (round %d)', async () => {
    const id = await createCampaign();

    const passes = Array.from({ length: 8 }, () => runCampaignRunnerOnce(deps));
    const claimed = await Promise.all(passes);

    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(starts).toHaveLength(4);
    expect(await row(id)).toMatchObject(expected);
  });

  it('gives two campaigns to two runners without mixing them', async () => {
    const first = await createCampaign();
    const second = await createCampaign();

    await Promise.all([runCampaignRunnerOnce(deps), runCampaignRunnerOnce(deps)]);
    await runCampaignRunnerOnce(deps);

    expect([(await row(first)).status, (await row(second)).status]).toEqual([
      'ENRICHING',
      'ENRICHING',
    ]);
    expect(await prisma.lead.count()).toBe(11);
  });
});

// Proves the lease: a live run is left alone, a dead one is picked up without paying again.
describe('campaign runner lease', () => {
  it('does not take a campaign whose lease is still running', async () => {
    const id = await createCampaign();
    await claimedAgo(id, LEASE_MS - 60_000);

    await expect(runCampaignRunnerOnce(deps)).resolves.toBe(false);
  });

  it('takes over an abandoned campaign and reattaches to its saved run', async () => {
    const id = await createCampaign();
    await claimedAgo(id, LEASE_MS + 60_000);
    const search = { term: 'dental clinic', area: 'DHA', maxResults: 100 };
    const { organizationId } = await row(id);
    await prisma.costRecord.create({
      data: {
        organizationId,
        campaignId: id,
        service: 'APIFY',
        amountUsd: deps.leadSource.chargeLimitUsd(100),
        note: searchNote({ term: search.term, area: search.area, runId: JSON.stringify(search) }),
      },
    });

    await expect(runCampaignRunnerOnce(deps)).resolves.toBe(true);

    expect(starts.map((started) => started.term)).not.toContain('dental clinic');
    expect(await row(id)).toMatchObject(expected);
  });

  it('lets one of two runners take over an abandoned campaign', async () => {
    const id = await createCampaign();
    await claimedAgo(id, LEASE_MS + 60_000);

    const claimed = await Promise.all([runCampaignRunnerOnce(deps), runCampaignRunnerOnce(deps)]);

    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(starts).toHaveLength(4);
  });
});

// Proves an unexpected error ends in a visible pause, not a campaign retried after every lease.
describe('campaign runner on an unexpected error', () => {
  it('pauses the campaign with the fixed reason and does not pick it up again', async () => {
    const id = await createCampaign();
    const { organizationId } = await row(id);
    const { spendCaps } = await prisma.settings.findUniqueOrThrow({ where: { organizationId } });
    await prisma.settings.update({
      where: { organizationId },
      data: { spendCaps: { broken: true } },
    });

    await expect(runCampaignRunnerOnce(deps)).resolves.toBe(true);
    await prisma.settings.update({
      where: { organizationId },
      data: { spendCaps: spendCaps as Prisma.InputJsonObject },
    });

    expect(await row(id)).toMatchObject({
      status: 'PAUSED',
      pausedFrom: 'DISCOVERING',
      pauseReason: expect.stringContaining('unexpected error'),
      discoveryClaimedAt: null,
    });
    await expect(runCampaignRunnerOnce(deps)).resolves.toBe(false);
    expect(starts).toHaveLength(0);
  });

  it('logs the error name and code only, never its message', async () => {
    const error = jest.fn();
    const warn = jest.fn();
    const id = await createCampaign();
    const failing: DiscoverDeps = {
      ...deps,
      logger: { error, warn, info: jest.fn() } as unknown as Logger,
      leadSource: {
        ...deps.leadSource,
        start: () => Promise.reject(new Error('value +923000000001 failed')),
      },
    };

    await runCampaignRunnerOnce(failing);

    expect(JSON.stringify(error.mock.calls)).not.toContain('+923000000001');
    expect(error).toHaveBeenCalledWith(
      { campaignId: id, errorName: 'Error', errorCode: null },
      'Apify start failed',
    );
  });
});

// Proves the loop outlives a failed pass, because one bad campaign must not end the worker.
describe('startCampaignRunner', () => {
  it('logs a failed pass and tries again', async () => {
    const error = jest.fn();
    const claimNext = jest.fn<() => Promise<null>>().mockRejectedValueOnce(new Error('fictional'));
    claimNext.mockResolvedValue(null);
    const failing = {
      ...deps,
      logger: { error } as unknown as Logger,
      repository: { claimNext } as unknown as DiscoveryRepository,
    };

    const stop = startCampaignRunner({ ...failing, startGate: new PaidStartGate() }, 1);
    await sleep(50);
    await stop(0);

    expect(error).toHaveBeenCalledTimes(1);
    expect(claimNext.mock.calls.length).toBeGreaterThan(1);
  });
});

// Proves a stop signal lets the paid start finish and its run id reach the database (NFR-2).
describe('campaign runner shutdown', () => {
  // A start that ends when the test says so, so these tests do not depend on the machine's speed.
  const heldStart = (release: Promise<null>): LeadSourcePort => ({
    ...deps.leadSource,
    start: async (search) => {
      starts.push(search);
      await release;
      return app.getContainer().resolve<LeadSourcePort>(LEAD_SOURCE).start(search);
    },
  });
  const started = async (): Promise<void> => {
    while (starts.length === 0) await sleep(5);
  };
  // A stopped pass gives its claim up last, so the next test starts on a quiet database.
  const passEnded = async (id: string): Promise<void> => {
    while ((await row(id)).discoveryClaimedAt !== null) await sleep(5);
  };

  it('waits for the run id to be saved, and starts nothing after it', async () => {
    const id = await createCampaign();
    const { promise, resolve: release } = Promise.withResolvers<null>();
    const runner = { ...deps, leadSource: heldStart(promise), startGate: new PaidStartGate() };

    const stop = startCampaignRunner(runner, 1);
    await started();
    const stopped = stop(30_000);
    release(null);
    await expect(stopped).resolves.toBe(true);
    const [record] = await prisma.costRecord.findMany({ where: { campaignId: id } });

    expect(readSearchNote(record?.note ?? null)?.runId).not.toBeNull();
    await passEnded(id);
    expect(starts).toHaveLength(1);
  });

  it('gives up after the wait, leaving a record the next pass pauses on', async () => {
    const id = await createCampaign();
    const { promise, resolve: release } = Promise.withResolvers<null>();
    const runner = { ...deps, leadSource: heldStart(promise), startGate: new PaidStartGate() };

    const stop = startCampaignRunner(runner, 1);
    await started();

    await expect(stop(10)).resolves.toBe(false);
    const [record] = await prisma.costRecord.findMany({ where: { campaignId: id } });
    expect(readSearchNote(record?.note ?? null)?.runId).toBeNull();
    release(null);
    await passEnded(id);
  });

  it('registers a handler that stops the runner and warns when the wait ran out', async () => {
    const handlers: (() => Promise<void>)[] = [];
    const warn = jest.fn();
    const stop = jest.fn<(waitMs: number) => Promise<boolean>>().mockResolvedValue(false);

    registerRunnerShutdown(
      {
        registerShutdownHandler: ({ handler }) => {
          handlers.push(handler);
        },
      },
      stop,
      { warn },
    );
    await handlers[0]?.();

    expect(stop).toHaveBeenCalledWith(10_000);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
