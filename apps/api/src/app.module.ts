/**
 * Root HazelJS module of the API.
 *
 * Serves: ADR-0001, ADR-0002, NFR-8 (issue #3, monorepo scaffold); FR-1–FR-3 (campaigns module).
 * Used by: apps/api/src/bootstrap.ts.
 */
import { HazelModule } from '@hazeljs/core';
import { PrismaProvider } from './db/prisma.provider.js';
import { CampaignsModule } from './modules/campaigns/campaigns.module.js';

/**
 * Module that `HazelApp` boots from.
 *
 * Does not declare `GET /health` or `GET /ready`: they are built into `HazelApp`.
 */
@HazelModule({ imports: [CampaignsModule], providers: [PrismaProvider] })
export class AppModule {}
