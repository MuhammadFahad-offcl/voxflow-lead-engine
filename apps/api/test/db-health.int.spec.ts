/**
 * Integration test of the `db` readiness check against a database that is down or hangs.
 *
 * Serves: NFR-10, ADR-0013 (cleared health-check timers), prompt C1-04 item 4.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createServer, type Server, type Socket } from 'node:net';
import { HealthCheckManager } from '@hazeljs/core';
import { createDbHealthCheck } from '../src/db/db-health.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { testEnv } from './test-env.js';

// Same check, same HazelJS runner that GET /ready uses, pointed at the given database URL.
// `release` runs before disconnecting: a connection stuck on a silent server would block it.
const runDbCheck = async (databaseUrl: string, release: () => void = () => undefined) => {
  const prisma = new PrismaProvider(testEnv({ DATABASE_URL: databaseUrl }));
  const manager = new HealthCheckManager();
  manager.registerCheck(createDbHealthCheck(prisma));
  try {
    const started = Date.now();
    const { checks } = await manager.runChecks();
    return { db: checks['db'], elapsed: Date.now() - started };
  } finally {
    release();
    await prisma.$disconnect();
  }
};

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });

// Proves /ready reports the database as unhealthy, without its error text, when it is down or hangs.
describe('db health check', () => {
  // Accepts connections and never answers, like a database that is up but stuck.
  const sockets = new Set<Socket>();
  const silent = createServer((socket) => sockets.add(socket));
  let silentPort: number;
  // A port that was free a moment ago: nothing listens, so connecting is refused.
  const closed = createServer();
  let closedPort: number;

  beforeAll(async () => {
    silentPort = await listen(silent);
    closedPort = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
  });

  afterAll(async () => {
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => silent.close(resolve));
  });

  it('is healthy when SELECT 1 succeeds', async () => {
    const { db } = await runDbCheck(testEnv().DATABASE_URL);

    expect(db).toMatchObject({ status: 'healthy' });
  });

  it('is unhealthy with a fixed message when the database refuses connections', async () => {
    const { db } = await runDbCheck(
      `postgresql://fictional:fictional-secret@127.0.0.1:${String(closedPort)}/fictional`,
    );

    expect(db).toEqual(
      expect.objectContaining({ status: 'unhealthy', message: 'database query failed' }),
    );
    expect(JSON.stringify(db)).not.toContain('fictional-secret');
  });

  it('is unhealthy after about 1 second when the database does not answer', async () => {
    const { db, elapsed } = await runDbCheck(
      `postgresql://fictional:fictional@127.0.0.1:${String(silentPort)}/fictional`,
      () => {
        sockets.forEach((socket) => socket.destroy());
      },
    );

    expect(db).toMatchObject({ status: 'unhealthy', message: 'Health check db timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(3000);
  });
});
