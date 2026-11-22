/**
 * Seeds the one organization, its settings, the dental-clinic niche profile and the service catalog,
 * and embeds every service that has no vector yet.
 *
 * Serves: FR-4 (niche profile), FR-13 (review labels), FR-15 (score thresholds), FR-16 (catalog
 * rows and their embeddings, #17), FR-20, FR-26, FR-33 and ADR-0006 (settings defaults).
 * Used by: apps/api/src/seed.ts (`pnpm db:seed`), apps/api/test/seed.int.spec.ts,
 * apps/api/test/catalog.int.spec.ts; other integration tests call `seed` only.
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
import { FakeEmbeddingAdapter } from '../adapters/embedding/fake.adapter.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Logger } from '../logging/logger.js';
import type { EmbeddingPort } from '../ports/embedding.port.js';
import { CatalogRepository } from './catalog.repository.js';
import { toStoredUsd } from './stored-usd.js';

/** Fixed id, because `Organization` has no other unique field to upsert on; v1 has one organization. */
export const SEED_ORGANIZATION_ID = 'org_voxflow';

const NICHE_FILE = 'niches/dental-clinic.json';
const CATALOG_FILE = 'catalog/services.json';

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

/** What {@link embedMissingServices} needs besides the database. */
export interface EmbedDeps {
  /** Embeds the services that have no vector; the fake in demo mode. */
  embedder: EmbeddingPort;
  /** Gets one line before any embedding request. */
  logger: Pick<Logger, 'info'>;
}

/** The niche version a seed run found in the niche file. */
export interface SeededNiche {
  slug: string;
  version: number;
  /** False when that version was already stored, so this run left it alone. */
  added: boolean;
}

/**
 * Reads and validates the config files, then creates whatever seed rows are missing.
 *
 * Does not overwrite a row that already exists, so a second run changes nothing and settings
 * edited later on the dashboard survive a re-seed. To change a niche, raise its `version` in the
 * file: the new version is added next to the old one, which campaigns may still use.
 * Does not write `Service.embedding`: {@link embedMissingServices} does, right after this in
 * `pnpm db:seed`.
 * `reviewLabels` got its column in #13, `tiers` in #14 and `defaultAreas` in #16 (niche v5).
 * @param prisma - Client connected to the database to seed.
 * @param configDir - The repo's `config/` folder.
 * @returns The niche version the file holds, and whether this run added it (false when it was
 * already stored), for the seed's log line.
 * @throws ZodError when a config file or a default does not match its schema; Error when a service
 * names a signal the niche does not have, or when the niche file changed but kept its `version`;
 * SyntaxError when a file is not valid JSON; ENOENT when a file is missing; Prisma errors from the
 * database. Nothing is written in any of these cases.
 */
export async function seed(prisma: PrismaClient, configDir: string): Promise<SeededNiche> {
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
    tiers: niche.tiers,
    premiumAreas: niche.premiumAreas,
    reviewLabels: niche.reviewLabels,
    defaultAreas: niche.defaultAreas,
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
      tiers: true,
      premiumAreas: true,
      reviewLabels: true,
      defaultAreas: true,
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
  return { slug: niche.slug, version: niche.version, added: stored === null };
}

/**
 * Embeds, in one request, every seeded service whose `embedding` is NULL (name, problem and
 * expected result), and records one `CostRecord(PERPLEXITY_EMBEDDINGS)`: the exact token count in
 * `units`, the cost rounded up to 5 decimals so it is never stored as $0.
 *
 * Does not re-embed a service that has a vector, so a second run sends no request.
 * @param prisma - Client connected to the seeded database.
 * @param deps - The embedder and the logger.
 * @param deps.embedder - The bound embedder; the fake in demo mode.
 * @param deps.logger - Gets one line, before the request, naming the embedder and the count.
 * @returns How many services it embedded; 0 when none was missing.
 * @throws EmbeddingError when embedding fails: nothing is written, and the next run retries;
 * Prisma errors from the database.
 */
export async function embedMissingServices(
  prisma: PrismaClient,
  { embedder, logger }: EmbedDeps,
): Promise<number> {
  const organizationId = SEED_ORGANIZATION_ID;
  const catalog = new CatalogRepository(prisma);
  const missing = await catalog.withoutEmbedding(organizationId);
  if (missing.length === 0) return 0;
  // Before the request, so a real (billed) run in the wrong mode shows at once.
  const mode = embedder instanceof FakeEmbeddingAdapter ? 'fake' : 'real';
  logger.info(
    { services: missing.length, adapter: embedder.constructor.name, mode },
    `embedding ${String(missing.length)} services with the ${mode} embedder (${embedder.constructor.name})`,
  );
  const { vectors, tokens, costUsd } = await embedder.embed(
    missing.map((service) => [service.name, service.problem, service.expectedResult].join('\n')),
  );
  await prisma.$transaction([
    ...missing.map((service, index) => {
      const vector = vectors[index];
      // The port promises one vector per text; a short answer must not store a partial catalog.
      if (vector === undefined) throw new Error('Embedder returned fewer vectors than texts');
      return catalog.setEmbedding(service.id, vector);
    }),
    prisma.costRecord.create({
      data: {
        organizationId,
        service: 'PERPLEXITY_EMBEDDINGS',
        amountUsd: toStoredUsd(costUsd),
        units: tokens,
      },
    }),
  ]);
  return missing.length;
}
