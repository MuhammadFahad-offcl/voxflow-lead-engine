/**
 * Root HazelJS module of the API.
 *
 * Serves: ADR-0001, ADR-0002, NFR-8 (issue #3, monorepo scaffold); FR-1–FR-3 (campaigns module);
 * FR-33 (costs module, #13); FR-32 (leads module: retry, #15);
 * FR-1 (niches module: new-campaign form, #16).
 * Used by: apps/api/src/bootstrap.ts.
 */
import { HazelModule } from '@hazeljs/core';
import { DiscoveryRepository } from './db/discovery.repository.js';
import { PrismaProvider } from './db/prisma.provider.js';
import { ReviewRepository } from './db/review.repository.js';
import { CampaignsModule } from './modules/campaigns/campaigns.module.js';
import { CostsModule } from './modules/costs/costs.module.js';
import { LeadsModule } from './modules/leads/leads.module.js';
import { NichesModule } from './modules/niches/niches.module.js';

/**
 * Module that `HazelApp` boots from.
 *
 * Does not declare `GET /health` or `GET /ready`: they are built into `HazelApp`.
 */
@HazelModule({
  imports: [CampaignsModule, CostsModule, LeadsModule, NichesModule],
  providers: [PrismaProvider, DiscoveryRepository, ReviewRepository],
})
export class AppModule {}
