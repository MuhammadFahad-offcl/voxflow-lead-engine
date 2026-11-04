/**
 * Root HazelJS module of the API.
 *
 * Serves: ADR-0001, ADR-0002, NFR-8 (issue #3, monorepo scaffold).
 * Used by: apps/api/src/server.ts.
 */
import { HazelModule } from '@hazeljs/core';
import { PrismaProvider } from './db/prisma.provider.js';

/**
 * Module that `HazelApp` boots from.
 *
 * Does not register controllers yet: `GET /health` and `GET /ready` are built into `HazelApp`, not
 * declared here.
 */
@HazelModule({ providers: [PrismaProvider] })
export class AppModule {}
