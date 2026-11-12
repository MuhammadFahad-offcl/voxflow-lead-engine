/**
 * HazelJS module for lead routes: controller, service and repository.
 *
 * Serves: FR-32; issue #15.
 * Used by: apps/api/src/app.module.ts.
 */
import { HazelModule } from '@hazeljs/core';
import { LeadsController } from './leads.controller.js';
import { LeadsRepository } from './leads.repository.js';
import { LeadsService } from './leads.service.js';

/** Lead routes and their use cases. */
@HazelModule({
  controllers: [LeadsController],
  providers: [LeadsRepository, LeadsService],
})
export class LeadsModule {}
