/**
 * Use cases behind the niche routes: the niches a new campaign can use.
 *
 * Serves: FR-1 (new-campaign form: niche select, area quick picks, grid size); issue #16.
 * Used by: apps/api/src/modules/niches/niches.controller.ts, apps/api/src/modules/niches/niches.module.ts.
 */
import { Injectable } from '@hazeljs/core';
import type { NicheSummary } from '@voxflow/shared';
import { NichesRepository } from './niches.repository.js';

/** Niche use cases. */
@Injectable()
export class NichesService {
  /**
   * Wires the use cases to the database.
   * @param niches - Niche rows.
   */
  constructor(private readonly niches: NichesRepository) {}

  /**
   * Lists every niche a new campaign can use, at its newest version.
   *
   * Does not return the search terms themselves, only how many: the form needs the grid size.
   * @returns The summaries; empty when the database is not seeded.
   * @throws Prisma errors when the database cannot be read.
   */
  async list(): Promise<NicheSummary[]> {
    const rows = await this.niches.latestVersions();
    return rows.map(({ searchTerms, ...row }) => ({ ...row, searchTermCount: searchTerms.length }));
  }
}
