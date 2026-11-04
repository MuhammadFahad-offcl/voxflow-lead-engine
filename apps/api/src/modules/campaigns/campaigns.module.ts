/**
 * HazelJS module for campaigns: controller, service and repository.
 *
 * Serves: FR-1, FR-2, FR-3.
 * Used by: apps/api/src/app.module.ts.
 */
import { HazelModule } from '@hazeljs/core';
import { CampaignsController } from './campaigns.controller.js';
import { CampaignsRepository } from './campaigns.repository.js';
import { CampaignsService } from './campaigns.service.js';

/** Campaign routes and their use cases. */
@HazelModule({
  controllers: [CampaignsController],
  providers: [CampaignsRepository, CampaignsService],
})
export class CampaignsModule {}
