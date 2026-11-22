/**
 * `/services` route: the service catalog, read-only. Bound to 127.0.0.1 like every non-Vapi route
 * (ADR-0003).
 *
 * Serves: FR-16; issue #17.
 * Used by: apps/api/src/modules/catalog/catalog.module.ts; docs/http/services.http.
 */
import { Controller, Get } from '@hazeljs/core';
import type { ServiceSummary } from '@voxflow/shared';
import { CatalogService } from './catalog.service.js';

/** `/services` routes. */
@Controller('/services')
export class CatalogController {
  /**
   * Wires the route to the catalog use cases.
   * @param catalog - Catalog use cases.
   */
  constructor(private readonly catalog: CatalogService) {}

  /**
   * Lists every service, without its vector.
   * @returns 200 with the services by slug; an empty list before `pnpm db:seed`.
   */
  @Get()
  list(): Promise<ServiceSummary[]> {
    return this.catalog.list();
  }
}
