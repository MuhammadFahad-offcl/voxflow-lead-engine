/**
 * HazelJS module for niche routes: controller, service and repository.
 *
 * Serves: FR-1; issue #16.
 * Used by: apps/api/src/app.module.ts.
 */
import { HazelModule } from '@hazeljs/core';
import { NichesController } from './niches.controller.js';
import { NichesRepository } from './niches.repository.js';
import { NichesService } from './niches.service.js';

/** Niche routes and their use cases. */
@HazelModule({
  controllers: [NichesController],
  providers: [NichesRepository, NichesService],
})
export class NichesModule {}
