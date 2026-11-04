/**
 * Root HazelJS module of the API.
 *
 * Serves: ADR-0001, NFR-8 (issue #3, monorepo scaffold).
 * Used by: apps/api/src/server.ts.
 */
import { HazelModule } from '@hazeljs/core';

/**
 * Module that `HazelApp` boots from.
 *
 * Does not register controllers or providers yet: `GET /health` and `GET /ready` are built into
 * `HazelApp`, not declared here.
 */
@HazelModule({})
export class AppModule {}
