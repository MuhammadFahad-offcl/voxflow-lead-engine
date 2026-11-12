/**
 * Database access for the niche routes: the newest version of each niche.
 *
 * Serves: FR-1 (new-campaign form), FR-4; issue #16.
 * Used by: apps/api/src/modules/niches/niches.service.ts, apps/api/src/modules/niches/niches.module.ts.
 */
import { Injectable } from '@hazeljs/core';
import { PrismaProvider } from '../../db/prisma.provider.js';

/** The fields of a niche version the form needs. */
export interface NicheRow {
  slug: string;
  name: string;
  version: number;
  searchTerms: string[];
  defaultAreas: string[];
}

/** Reads `NicheProfile` rows. */
@Injectable()
export class NichesRepository {
  /**
   * Wires the repository to the process's database client.
   * @param prisma - The process's Prisma client.
   */
  constructor(private readonly prisma: PrismaProvider) {}

  /**
   * Lists the newest version of every niche, by slug.
   *
   * Does not list older versions: a new campaign always takes the newest (FR-4).
   * @returns One row per slug, in slug order; empty when nothing is seeded.
   * @throws Prisma errors when the database cannot be read.
   */
  latestVersions(): Promise<NicheRow[]> {
    return this.prisma.nicheProfile.findMany({
      // DISTINCT ON keeps the first row per slug, which the order makes the highest version.
      distinct: ['slug'],
      orderBy: [{ slug: 'asc' }, { version: 'desc' }],
      select: { slug: true, name: true, version: true, searchTerms: true, defaultAreas: true },
    });
  }
}
