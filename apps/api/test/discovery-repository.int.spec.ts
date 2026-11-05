/**
 * Integration test of the discovery repository's guards on real Postgres.
 *
 * Serves: FR-3, FR-7, FR-33, NFR-1, NFR-2; issue #10 (founder decisions on Q2 and Q3).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { DiscoveryRepository, type Claim } from '../src/db/discovery.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let prisma: PrismaProvider;
let repository: DiscoveryRepository;
let organizationId: string;
let nicheProfileId: string;

const newClaim = async (): Promise<Claim> => {
  const claimedAt = new Date('2026-11-05T07:00:00.000Z');
  const { id } = await prisma.campaign.create({
    data: {
      organizationId,
      nicheProfileId,
      city: 'Lahore',
      areas: ['DHA'],
      discoveryClaimedAt: claimedAt,
    },
  });
  return { id, claimedAt };
};

const campaign = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });
const later = new Date('2026-11-05T07:05:00.000Z');

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_discovery_repository_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
  repository = new DiscoveryRepository(prisma);
  ({ id: organizationId } = await prisma.organization.create({ data: { name: 'Fictional Org' } }));
  ({ id: nicheProfileId } = await prisma.nicheProfile.create({
    data: {
      organizationId,
      slug: 'fictional',
      version: 1,
      name: 'Fictional niche',
      searchTerms: ['fictional term'],
      idealClient: {},
      signalWeights: {},
      scriptTemplate: 'Fictional template',
    },
  }));
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.costRecord.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.campaign.deleteMany();
});

// Proves only the holder of a live claim can go on: the check before every paid start.
describe('renewClaim', () => {
  it('moves the lease forward for the holder', async () => {
    const claim = await newClaim();

    await expect(repository.renewClaim(claim, later)).resolves.toEqual({
      id: claim.id,
      claimedAt: later,
    });
    expect((await campaign(claim.id)).discoveryClaimedAt).toEqual(later);
  });

  it('fails for a runner whose lease another runner took over', async () => {
    const claim = await newClaim();
    await repository.renewClaim(claim, later);

    await expect(repository.renewClaim(claim, new Date())).resolves.toBeNull();
  });

  it('fails once an operator has paused the campaign', async () => {
    const claim = await newClaim();
    await prisma.campaign.update({
      where: { id: claim.id },
      data: { status: 'PAUSED', pausedFrom: 'DISCOVERING' },
    });

    await expect(repository.renewClaim(claim, later)).resolves.toBeNull();
  });
});

// Proves a stale runner cannot clear or pause what it no longer holds.
describe('releaseClaim and pause', () => {
  it('clears the holder own claim', async () => {
    const claim = await newClaim();

    await repository.releaseClaim(claim);

    expect((await campaign(claim.id)).discoveryClaimedAt).toBeNull();
  });

  it('leaves a newer claim alone', async () => {
    const claim = await newClaim();
    await repository.renewClaim(claim, later);

    await repository.releaseClaim(claim);

    expect((await campaign(claim.id)).discoveryClaimedAt).toEqual(later);
  });

  it('pauses with the reason, remembering where to resume', async () => {
    const claim = await newClaim();

    await expect(repository.pause(claim, 'Fictional reason')).resolves.toBe(true);

    expect(await campaign(claim.id)).toMatchObject({
      status: 'PAUSED',
      pausedFrom: 'DISCOVERING',
      pauseReason: 'Fictional reason',
      discoveryClaimedAt: null,
    });
  });

  it('does not pause for a stale runner', async () => {
    const claim = await newClaim();
    await repository.renewClaim(claim, later);

    await expect(repository.pause(claim, 'Fictional reason')).resolves.toBe(false);

    expect(await campaign(claim.id)).toMatchObject({ status: 'DISCOVERING', pauseReason: null });
  });
});

// Proves the daily total: reservations count, other services and earlier days do not.
describe('apifySpentSince', () => {
  it('adds Apify records from the moment given, in Decimal', async () => {
    const since = new Date('2026-11-04T19:00:00.000Z');
    const record = (service: 'APIFY' | 'LLM', amountUsd: string, at: Date) =>
      prisma.costRecord.create({ data: { organizationId, service, amountUsd, at } });
    await record('APIFY', '0.10000', since);
    await record('APIFY', '0.20000', later);
    await record('LLM', '5.00000', later);
    await record('APIFY', '7.00000', new Date(since.getTime() - 1));

    const spent = await repository.apifySpentSince(organizationId, since);

    expect(spent.toFixed(2)).toBe('0.30');
  });

  it('is 0 with no records', async () => {
    const spent = await repository.apifySpentSince(organizationId, later);

    expect(spent.isZero()).toBe(true);
  });
});
