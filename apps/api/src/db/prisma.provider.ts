/**
 * The Prisma client of this process, registered in HazelJS DI.
 *
 * Serves: ADR-0002 (issue #5, database setup), docs/architecture.md §12 (URL from the parsed env).
 * Used by: apps/api/src/app.module.ts, apps/api/src/bootstrap.ts, apps/api/src/server.ts,
 * apps/api/test/db.int.spec.ts.
 */
import { Inject, Injectable } from '@hazeljs/core';
import { PrismaPg } from '@prisma/adapter-pg';
import { ENV, type Env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Database client; HazelJS creates one instance per process.
 *
 * Does not validate DATABASE_URL: `loadEnv` did that before the app was created.
 * Does not open a connection when created: the pool connects on the first query, so a database that
 * is down shows up at that query, not at startup.
 * Does not disconnect itself: `registerPrismaShutdown` adds that as a shutdown handler.
 */
@Injectable()
export class PrismaProvider extends PrismaClient {
  /**
   * Builds the client on the pg driver adapter.
   * @param env - Parsed configuration, injected from DI; only DATABASE_URL is read.
   */
  constructor(@Inject(ENV) env: Env) {
    super({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  }
}
