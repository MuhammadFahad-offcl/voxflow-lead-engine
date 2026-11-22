/**
 * Use cases behind the catalog routes: the read-only service list.
 *
 * Serves: FR-16; issue #17 (v1 slim: read-only list, no create, edit or retire).
 * Used by: apps/api/src/modules/catalog/catalog.controller.ts, apps/api/src/modules/catalog/catalog.module.ts.
 */
import { Injectable } from '@hazeljs/core';
import type { ServiceSummary } from '@voxflow/shared';
import { CatalogRepository } from '../../db/catalog.repository.js';

/** Catalog use cases. */
@Injectable()
export class CatalogService {
  /**
   * Wires the use cases to the database.
   * @param catalog - Service rows.
   */
  constructor(private readonly catalog: CatalogRepository) {}

  /**
   * Lists every service, active or retired.
   * @returns The services by slug, each saying whether it is active and embedded.
   * @throws Prisma errors when the database cannot be read.
   */
  list(): Promise<ServiceSummary[]> {
    return this.catalog.list();
  }
}
