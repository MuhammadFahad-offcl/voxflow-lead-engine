/**
 * Seeds the one organization, its settings, the dental-clinic niche profile and the service catalog.
 *
 * Serves: FR-4 (niche profile), FR-16 (catalog rows; embeddings follow in C2-01), FR-20, FR-26,
 * FR-33 and ADR-0006 (settings defaults).
 * Used by: apps/api/src/seed.ts (`pnpm db:seed`), apps/api/test/seed.int.spec.ts.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  Booking,
  CallingHours,
  CatalogFile,
  DEFAULT_SETTINGS,
  LlmModels,
  NicheFile,
  SpendCaps,
} from '@voxflow/shared';
import type { PrismaClient } from '../generated/prisma/client.js';

/** Fixed id, because `Organization` has no other unique field to upsert on; v1 has one organization. */
export const SEED_ORGANIZATION_ID = 'org_voxflow';

const NICHE_FILE = 'niches/dental-clinic.json';
const CATALOG_FILE = 'catalog/services.json';

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

/**
 * Reads and validates the config files, then creates whatever seed rows are missing.
 *
 * Does not overwrite a row that already exists, so a second run changes nothing and settings
 * edited later on the dashboard survive a re-seed. To change a niche, raise its `version` in the
 * file: the new version is added next to the old one, which campaigns may still use.
 * Does not write `Service.embedding`: it stays NULL until C2-01.
 * Does not store the niche's `tiers`, `reviewLabels` or `defaultAreas`: they are validated here,
 * and get their columns in the issues that use them (#14, #16), as decided for #7.
 * @param prisma - Client connected to the database to seed.
 * @param configDir - The repo's `config/` folder.
 * @throws ZodError when a config file or a default does not match its schema; Error when a service
 * names a signal the niche does not have, or when the niche file changed but kept its `version`;
 * SyntaxError when a file is not valid JSON; ENOENT when a file is missing; Prisma errors from the
 * database. Nothing is written in any of these cases.
 */
export async function seed(prisma: PrismaClient, configDir: string): Promise<void> {
  const niche = NicheFile.parse(await readJson(join(configDir, NICHE_FILE)));
  const scriptTemplate = await readFile(
    join(configDir, 'niches', niche.scriptTemplateFile),
    'utf8',
  );
  const { services } = CatalogFile.parse(await readJson(join(configDir, CATALOG_FILE)));

  const signalKeys = new Set(
    Object.values(niche.signalWeights).flatMap((group) => Object.keys(group)),
  );
  for (const service of services) {
    const unknown = service.fittingSignals.filter((key) => !signalKeys.has(key));
    if (unknown.length > 0) {
      throw new Error(`Service ${service.slug} names unknown signals: ${unknown.join(', ')}`);
    }
  }

  const organizationId = SEED_ORGANIZATION_ID;
  const nicheRow = {
    name: niche.name,
    searchTerms: niche.searchTerms,
    categoryKeywords: niche.categoryKeywords,
    idealClient: niche.idealClient,
    signalWeights: niche.signalWeights,
    premiumAreas: niche.premiumAreas,
    scriptTemplate,
  };
  // An edit that keeps the version would otherwise be skipped without a word.
  const stored = await prisma.nicheProfile.findUnique({
    where: {
      organizationId_slug_version: { organizationId, slug: niche.slug, version: niche.version },
    },
    select: {
      name: true,
      searchTerms: true,
      categoryKeywords: true,
      idealClient: true,
      signalWeights: true,
      premiumAreas: true,
      scriptTemplate: true,
    },
  });
  if (stored !== null && !isDeepStrictEqual(stored, nicheRow)) {
    throw new Error(
      `${niche.slug} v${String(niche.version)} is already stored with different content: raise "version" in the niche file`,
    );
  }

  // The defaults live in code, so check them too: a bad edit fails here, not on the dashboard.
  const settings = {
    callingHours: CallingHours.parse(DEFAULT_SETTINGS.callingHours),
    booking: Booking.parse(DEFAULT_SETTINGS.booking),
    spendCaps: SpendCaps.parse(DEFAULT_SETTINGS.spendCaps),
    llmModels: LlmModels.parse(DEFAULT_SETTINGS.llmModels),
  };

  // One transaction: a failure halfway leaves the database as it was.
  await prisma.$transaction([
    prisma.organization.upsert({
      where: { id: organizationId },
      create: { id: organizationId, name: 'VoxFlow AI Solutions' },
      update: {},
    }),
    prisma.settings.upsert({
      where: { organizationId },
      create: { organizationId, ...settings },
      update: {},
    }),
    prisma.nicheProfile.upsert({
      where: {
        organizationId_slug_version: { organizationId, slug: niche.slug, version: niche.version },
      },
      create: { organizationId, slug: niche.slug, version: niche.version, ...nicheRow },
      update: {},
    }),
    ...services.map((service) =>
      prisma.service.upsert({
        where: { organizationId_slug: { organizationId, slug: service.slug } },
        create: { organizationId, ...service },
        update: {},
      }),
    ),
  ]);
}
