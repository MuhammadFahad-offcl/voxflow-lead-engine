/**
 * Integration test of the service catalog on a real server and its own migrated database, with
 * the fake embedder: the seed's embeddings, `GET /services`, and the pgvector similarity search.
 *
 * Serves: FR-16, ADR-0006 (1024-dim vectors, HNSW cosine search), ADR-0007; issue #17.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { resolve } from 'node:path';
import type { HazelApp } from '@hazeljs/core';
import { ServiceSummary } from '@voxflow/shared';
import { z } from 'zod';
import { FakeEmbeddingAdapter } from '../src/adapters/embedding/fake.adapter.js';
import { CatalogRepository } from '../src/db/catalog.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { embedMissingServices, SEED_ORGANIZATION_ID, seed } from '../src/db/seed.js';
import type { Logger } from '../src/logging/logger.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

const embedder = new FakeEmbeddingAdapter();
const info = jest.fn();
const logger = { info } as unknown as Logger;

let app: HazelApp;
let baseUrl: string;
let prisma: PrismaProvider;
let catalog: CatalogRepository;

const embedQuery = async (text: string): Promise<number[]> => {
  const [vector] = (await embedder.embed([text])).vectors;
  if (vector === undefined) throw new Error('no vector');
  return vector;
};

// `migrate deploy` starts a process and can download the schema engine on a fresh machine.
beforeAll(async () => {
  const url = await createTestDatabase('voxflow_catalog_test');
  app = await startServer(testEnv({ DATABASE_URL: url }), 0);
  const address = app.getServer()?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('API server is not listening on a TCP port');
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  prisma = app.getContainer().resolve(PrismaProvider);
  catalog = app.getContainer().resolve(CatalogRepository);
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
}, 120_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

// The tests below run in order: the first one embeds the catalog the others read.

// Proves the seed embeds every service once, says which embedder before it calls, and never stores $0.
describe('embedMissingServices', () => {
  it('embeds the 10 services once, logs the fake embedder first, and records one rounded-up cost', async () => {
    const first = await embedMissingServices(prisma, { embedder, logger });
    const second = await embedMissingServices(prisma, { embedder, logger });

    expect([first, second]).toEqual([10, 0]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      { services: 10, adapter: 'FakeEmbeddingAdapter', mode: 'fake' },
      'embedding 10 services with the fake embedder (FakeEmbeddingAdapter)',
    );
    const services = await catalog.list();
    const { tokens } = await embedder.embed(
      services.map((service) => [service.name, service.problem, service.expectedResult].join('\n')),
    );
    const costs = await prisma.costRecord.findMany({ where: { service: 'PERPLEXITY_EMBEDDINGS' } });
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ organizationId: SEED_ORGANIZATION_ID, units: tokens });
    // About $0.000001 exactly; rounded up so it is never stored as $0.
    expect(costs[0]?.amountUsd.toString()).toBe('0.00001');
  });
});

// Proves the read-only list returns every service with its flags and never the vector.
describe('GET /services', () => {
  it('answers 200 with the 10 services by slug, active and embedded, without vectors', async () => {
    const response = await fetch(`${baseUrl}/services`);
    const body = (await response.json()) as Record<string, unknown>[];

    expect(response.status).toBe(200);
    const services = z.array(ServiceSummary).parse(body);
    expect(services.map(({ slug }) => slug)).toEqual(
      services.map(({ slug }) => slug).toSorted((a, b) => a.localeCompare(b)),
    );
    expect(services).toHaveLength(10);
    expect(services.every(({ active, embedded }) => active && embedded)).toBe(true);
    expect(body.some((service) => 'embedding' in service)).toBe(false);
  });
});

// Proves search ranks the obviously closest service first and never returns a retired one.
describe('CatalogRepository.searchSimilar', () => {
  it.each([
    ['Nobody picks up when patients call the clinic', 'ai-voice-receptionist'],
    ['Google reviews have no reply', 'review-reply-automation'],
    ['Visitors book a time slot on the website', 'online-booking-page'],
  ])('puts the service sharing the words of "%s" first: %s', async (query, slug) => {
    const results = await catalog.searchSimilar(await embedQuery(query));

    expect(results).toHaveLength(5);
    expect(results[0]?.slug).toBe(slug);
    const distances = results.map(({ distance }) => distance);
    expect(distances).toEqual(distances.toSorted((a, b) => a - b));
  });

  it('leaves out a retired service', async () => {
    await prisma.service.update({
      where: {
        organizationId_slug: {
          organizationId: SEED_ORGANIZATION_ID,
          slug: 'ai-voice-receptionist',
        },
      },
      data: { active: false },
    });

    const results = await catalog.searchSimilar(
      await embedQuery('Nobody picks up when patients call the clinic'),
      10,
    );

    expect(results).toHaveLength(9);
    expect(results.map(({ slug }) => slug)).not.toContain('ai-voice-receptionist');
  });
});
