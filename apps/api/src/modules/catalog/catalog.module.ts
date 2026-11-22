/**
 * Wires the catalog route to its use cases and repository.
 *
 * Serves: FR-16; issue #17.
 * Used by: apps/api/src/app.module.ts.
 */
import { HazelModule } from '@hazeljs/core';
import { CatalogRepository } from '../../db/catalog.repository.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

/** The read-only `/services` route and the repository the seed also uses. */
@HazelModule({
  controllers: [CatalogController],
  providers: [CatalogRepository, CatalogService],
})
export class CatalogModule {}
