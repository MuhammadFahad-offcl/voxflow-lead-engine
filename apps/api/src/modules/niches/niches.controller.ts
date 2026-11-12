/**
 * `/niches` routes for the dashboard's new-campaign form. Bound to 127.0.0.1 like every non-Vapi
 * route (ADR-0003).
 *
 * Serves: FR-1; issue #16.
 * Used by: apps/api/src/modules/niches/niches.module.ts; docs/http/niches.http.
 */
import { Controller, Get } from '@hazeljs/core';
import type { NicheSummary } from '@voxflow/shared';
import { NichesService } from './niches.service.js';

/** `/niches` routes. */
@Controller('/niches')
export class NichesController {
  /**
   * Wires the routes to the niche use cases.
   * @param niches - Niche use cases.
   */
  constructor(private readonly niches: NichesService) {}

  /**
   * Lists the niches a new campaign can use, newest version each.
   * @returns 200 with the summaries, in slug order; an empty list before `pnpm db:seed`.
   */
  @Get()
  list(): Promise<NicheSummary[]> {
    return this.niches.list();
  }
}
