/**
 * The Prisma client of this process, registered in HazelJS DI.
 *
 * Serves: ADR-0002 (issue #5, database setup).
 * Used by: apps/api/src/app.module.ts, apps/api/src/server.ts, apps/api/test/db.int.spec.ts.
 */
import { Injectable } from '@hazeljs/core';
import { PrismaPg } from '@prisma/adapter-pg';
import { z } from 'zod';
import { PrismaClient } from '../generated/prisma/client.js';

// Moves into src/config/ with the full env schema in #6.
const DatabaseEnv = z.object({ DATABASE_URL: z.url() });

/**
 * Database client; HazelJS creates one instance per process.
 *
 * Does not open a connection when created: the pool connects on the first query, so a database that
 * is down shows up at that query, not at startup.
 * Does not disconnect itself: `startServer` registers that as a shutdown handler.
 * @throws ZodError when DATABASE_URL is missing or is not a URL. The message names the variable
 * and never contains its value.
 */
@Injectable()
export class PrismaProvider extends PrismaClient {
  constructor() {
    const { DATABASE_URL } = DatabaseEnv.parse(process.env);
    super({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
  }
}
