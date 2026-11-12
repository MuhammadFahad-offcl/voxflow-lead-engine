/**
 * HazelJS module for lead routes: controller, service and repository.
 *
 * Serves: FR-32 (retry), issue #15; FR-30 (lead table), issue #16.
 * Used by: apps/api/src/app.module.ts.
 */
import { HazelModule } from '@hazeljs/core';
import { LeadTableController } from './lead-table.controller.js';
import { LeadTableRepository } from './lead-table.repository.js';
import { LeadTableService } from './lead-table.service.js';
import { LeadsController } from './leads.controller.js';
import { LeadsRepository } from './leads.repository.js';
import { LeadsService } from './leads.service.js';

/** Lead routes (retry and the lead table) and their use cases. */
@HazelModule({
  controllers: [LeadsController, LeadTableController],
  providers: [LeadsRepository, LeadsService, LeadTableRepository, LeadTableService],
})
export class LeadsModule {}
