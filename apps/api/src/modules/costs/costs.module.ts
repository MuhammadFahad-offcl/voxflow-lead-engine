/**
 * HazelJS module for spend status: controller, service and the repositories it reads.
 *
 * Serves: FR-33; issue #13.
 * Used by: apps/api/src/app.module.ts.
 */
import { HazelModule } from '@hazeljs/core';
import { LlmSpendRepository } from '../../db/llm-spend.repository.js';
import { CampaignsRepository } from '../campaigns/campaigns.repository.js';
import { CostsController } from './costs.controller.js';
import { CostsService } from './costs.service.js';

/** The spend status route and its use case. */
@HazelModule({
  controllers: [CostsController],
  providers: [LlmSpendRepository, CampaignsRepository, CostsService],
})
export class CostsModule {}
