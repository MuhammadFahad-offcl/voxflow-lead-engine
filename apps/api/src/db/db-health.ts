/**
 * The `db` readiness check that `GET /ready` reports.
 *
 * Serves: NFR-10 (health endpoint reports the database), docs/architecture.md §13.
 * Used by: apps/api/src/server.ts, apps/api/test/db-health.int.spec.ts.
 */
import type { HealthCheck, HealthCheckResult } from '@hazeljs/core';
import type { PrismaProvider } from './prisma.provider.js';

/**
 * Builds a critical health check that runs `SELECT 1` and gives up after 1 second.
 *
 * Does not set its own timer: HazelJS races the check against `timeout` and, with our patch
 * (ADR-0013), clears that timer when the check settles.
 * Does not cancel the query when the timeout fires; the pool's 5 s connection timeout
 * (`PrismaProvider`) ends a connection attempt to a database that never answers.
 * Does not put the database error in the result, because `/ready` is readable by anything on this
 * laptop and driver messages can name hosts and users.
 * @param prisma - The process's Prisma client.
 * @returns The check to pass to `app.registerHealthCheck`.
 */
export function createDbHealthCheck(prisma: PrismaProvider): HealthCheck {
  return {
    name: 'db',
    critical: true,
    timeout: 1000,
    check: async (): Promise<HealthCheckResult> => {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return { status: 'healthy' };
      } catch {
        return { status: 'unhealthy', message: 'database query failed' };
      }
    },
  };
}
