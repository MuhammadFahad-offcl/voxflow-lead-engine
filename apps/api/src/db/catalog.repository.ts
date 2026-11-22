/**
 * Database access for the service catalog: the list, the vectors the seed writes, and the
 * pgvector similarity search. Raw SQL because Prisma cannot read or write `vector(1024)`.
 *
 * Serves: FR-16 (catalog searched by similarity), ADR-0002 (pgvector), ADR-0006; issue #17.
 * Used by: apps/api/src/modules/catalog/, apps/api/src/db/seed.ts, apps/api/test/catalog.int.spec.ts.
 */
import { Inject, Injectable } from '@hazeljs/core';
import { ServiceSummary } from '@voxflow/shared';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { PrismaProvider } from './prisma.provider.js';

const SimilarService = ServiceSummary.extend({
  // Cosine distance: 0 for the same direction, up to 2 for the opposite one.
  distance: z.number(),
});

// Every ServiceSummary field; the vector itself is never read back.
const SUMMARY_COLUMNS = Prisma.sql`id, slug, name, "nameUrdu", problem, "fittingSignals",
  "expectedResult", "expectedResultUrdu", active, embedding IS NOT NULL AS embedded`;

// pgvector reads a vector from its text form, "[0.1,0.2,...]"; sent as a bound parameter.
const toVectorText = (vector: number[]): string => `[${vector.join(',')}]`;

/** Reads and writes `Service` rows. */
@Injectable()
export class CatalogRepository {
  /**
   * Wires the repository to a database client.
   * @param prisma - The process's Prisma client in the API; the seed passes its own client.
   */
  constructor(@Inject(PrismaProvider) private readonly prisma: PrismaClient) {}

  /**
   * Lists every service, active or retired, by slug.
   * @returns The services without their vectors; empty before `pnpm db:seed`.
   * @throws Prisma errors when the database cannot be read; ZodError if a row has an unexpected shape.
   */
  async list(): Promise<ServiceSummary[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT ${SUMMARY_COLUMNS} FROM "Service" ORDER BY slug`;
    return z.array(ServiceSummary).parse(rows);
  }

  /**
   * Lists an organization's services that have no vector yet, by slug.
   * @param organizationId - `Organization.id`.
   * @returns Each service's id and the fields its embedded text is built from.
   * @throws Prisma errors when the database cannot be read.
   */
  withoutEmbedding(
    organizationId: string,
  ): Promise<{ id: string; name: string; problem: string; expectedResult: string }[]> {
    return this.prisma.$queryRaw`
      SELECT id, name, problem, "expectedResult" FROM "Service"
      WHERE "organizationId" = ${organizationId} AND embedding IS NULL
      ORDER BY slug`;
  }

  /**
   * Builds the write of one service's vector, for the caller to run or put in a transaction.
   * @param id - `Service.id`.
   * @param vector - 1024 numbers, unit length.
   * @returns The pending UPDATE; it resolves to the number of rows changed.
   */
  setEmbedding(id: string, vector: number[]): Prisma.PrismaPromise<number> {
    return this.prisma.$executeRaw`
      UPDATE "Service" SET embedding = ${toVectorText(vector)}::vector WHERE id = ${id}`;
  }

  /**
   * Finds the active services closest to a query vector, by cosine distance (HNSW index).
   *
   * Does not return retired services or services the seed has not embedded yet.
   * @param queryVector - 1024 numbers from the same embedder as the stored vectors.
   * @param k - The most services to return.
   * @returns Up to `k` services, closest first, each with its distance.
   * @throws Prisma errors when the database cannot be read, or when the vector is not 1024 long.
   */
  async searchSimilar(queryVector: number[], k = 5) {
    const vector = toVectorText(queryVector);
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT ${SUMMARY_COLUMNS}, embedding <=> ${vector}::vector AS distance
      FROM "Service"
      WHERE active AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vector}::vector
      LIMIT ${k}`;
    return z.array(SimilarService).parse(rows);
  }
}
