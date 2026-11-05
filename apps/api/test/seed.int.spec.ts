/**
 * Integration test of the seed against a fresh, migrated database.
 *
 * Serves: FR-4, FR-16, FR-20, FR-26, FR-33; issue #7 acceptance criteria.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { DEFAULT_SETTINGS } from '@voxflow/shared';
import { SEED_ORGANIZATION_ID, seed } from '../src/db/seed.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createTestDatabase } from './test-database.js';

const configDir = resolve(import.meta.dirname, '../../../config');
let prisma: PrismaClient;

const counts = async () => ({
  organizations: await prisma.organization.count(),
  settings: await prisma.settings.count(),
  niches: await prisma.nicheProfile.count({ where: { slug: 'dental-clinic', version: 3 } }),
  services: await prisma.service.count(),
});

// `migrate deploy` starts a process and can download the schema engine on a fresh machine.
beforeAll(async () => {
  const url = await createTestDatabase('voxflow_seed_test');
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

// Proves the seed creates exactly the v1 rows, with the PRD defaults, and that a re-run changes nothing.
describe('seed', () => {
  it('creates 1 organization, its settings, dental-clinic v1 and 10 services, twice in a row', async () => {
    await seed(prisma, configDir);
    const settingsAfterFirst = await prisma.settings.findUniqueOrThrow({
      where: { organizationId: SEED_ORGANIZATION_ID },
    });

    await seed(prisma, configDir);

    expect(await counts()).toEqual({ organizations: 1, settings: 1, niches: 1, services: 10 });
    // updatedAt would move if the second run had written the row.
    expect(
      await prisma.settings.findUniqueOrThrow({ where: { organizationId: SEED_ORGANIZATION_ID } }),
    ).toEqual(settingsAfterFirst);
  });

  it('stores the PRD defaults for calling hours, booking, spend caps and models', async () => {
    const settings = await prisma.settings.findUniqueOrThrow({
      where: { organizationId: SEED_ORGANIZATION_ID },
    });

    expect(settings).toMatchObject({ ...DEFAULT_SETTINGS, retentionDays: 90 });
    expect(settings.spendCaps).toEqual({
      llmMonthlyUsd: '10.00',
      apifyDailyUsd: '2.00',
      perplexityDailyUsd: '2.00',
      vapiDailyUsd: '3.00',
    });
  });

  it('stores the niche search terms, ideal-client rules, weights and the script file as text', async () => {
    const niche = await prisma.nicheProfile.findFirstOrThrow({ where: { slug: 'dental-clinic' } });
    const script = await readFile(join(configDir, 'niches/dental-clinic.script.md'), 'utf8');

    expect(niche.searchTerms).toContain('dental clinic');
    expect(niche.idealClient).toMatchObject({ minRating: 4, minReviewCount: 30 });
    expect(niche.signalWeights).toMatchObject({
      PAIN: { phone_unanswered_reviews: { points: 15 } },
    });
    expect(niche.scriptTemplate).toBe(script);
  });

  it('does not overwrite settings changed after the first seed', async () => {
    const edited = { ...DEFAULT_SETTINGS.spendCaps, vapiDailyUsd: '7.50' };
    await prisma.settings.update({
      where: { organizationId: SEED_ORGANIZATION_ID },
      data: { spendCaps: edited },
    });

    await seed(prisma, configDir);

    const settings = await prisma.settings.findUniqueOrThrow({
      where: { organizationId: SEED_ORGANIZATION_ID },
    });
    expect(settings.spendCaps).toEqual(edited);
  });

  it('stops, and writes nothing, when the niche file changed but kept its version', async () => {
    const editedConfig = await mkdtemp(join(tmpdir(), 'voxflow-seed-'));
    try {
      await cp(configDir, editedConfig, { recursive: true });
      const nichePath = join(editedConfig, 'niches/dental-clinic.json');
      const niche = JSON.parse(await readFile(nichePath, 'utf8')) as { premiumAreas: string[] };
      niche.premiumAreas.push('Fictional Town');
      await writeFile(nichePath, JSON.stringify(niche));

      await expect(seed(prisma, editedConfig)).rejects.toThrow('raise "version"');
      expect(await prisma.nicheProfile.count()).toBe(1);
    } finally {
      await rm(editedConfig, { recursive: true, force: true });
    }
  });

  it('writes nothing when a service names a signal the niche does not have', async () => {
    const badConfig = await mkdtemp(join(tmpdir(), 'voxflow-seed-'));
    try {
      await cp(configDir, badConfig, { recursive: true });
      const catalogPath = join(badConfig, 'catalog/services.json');
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
        services: Record<string, unknown>[];
      };
      catalog.services.push({
        ...catalog.services[0],
        slug: 'fictional-new-service',
        fittingSignals: ['no_such_signal'],
      });
      await writeFile(catalogPath, JSON.stringify(catalog));

      await expect(seed(prisma, badConfig)).rejects.toThrow('no_such_signal');
      expect(await prisma.service.count({ where: { slug: 'fictional-new-service' } })).toBe(0);
    } finally {
      await rm(badConfig, { recursive: true, force: true });
    }
  });
});
