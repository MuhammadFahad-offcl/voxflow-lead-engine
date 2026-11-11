/**
 * HTTP route for spend status. Calls the service, nothing else.
 *
 * Serves: FR-33 (the dashboard banner when a cap is reached); ADR-0003 (binds to 127.0.0.1 with the
 * rest of the API); issue #13.
 * Used by: apps/api/src/modules/costs/costs.module.ts; docs/http/costs.http.
 */
import { Controller, Get } from '@hazeljs/core';
import type { CostsStatus } from '@voxflow/shared';
import { CostsService } from './costs.service.js';

/** `/costs` routes for the dashboard. */
@Controller('/costs')
export class CostsController {
  /**
   * Wires the route to the spend use case.
   * @param costs - Spend use cases.
   */
  constructor(private readonly costs: CostsService) {}

  /**
   * Reports this month's LLM spend against the monthly cap.
   * @returns 200 with `{ llm: { spentUsd, capUsd, blocked, monthStart } }`.
   * @throws HttpError (503) when the database is not seeded; a 500 when the settings row is missing
   * or its `spendCaps` are invalid.
   */
  @Get('/status')
  status(): Promise<CostsStatus> {
    return this.costs.status();
  }
}
