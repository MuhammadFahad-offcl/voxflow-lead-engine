/**
 * Integration test of the real API server on a random local port.
 *
 * Serves: ADR-0003, ADR-0013, NFR-10, and the tests asked for in prompts C1-01 item 5 and C1-04
 * item 4 (docs/prompts/cycle-1-scored-leads.md): bound address, GET /health, GET /ready and its
 * `db` check.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { HazelApp } from '@hazeljs/core';
import { HealthResponse } from '@voxflow/shared';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { startServer } from '../src/server.js';
import { testEnv } from './test-env.js';

const baseUrlOf = (app: HazelApp): string => {
  const address = app.getServer()?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('API server is not listening on a TCP port');
  }
  return `http://127.0.0.1:${String(address.port)}`;
};

// Proves 127.0.0.1-only binding (ADR-0003, ADR-0013) and the probes in docs/architecture.md §13.
describe('API server', () => {
  let app: HazelApp;

  beforeAll(async () => {
    // Port 0 lets the OS pick a free port, so the test never clashes with a running API.
    app = await startServer(testEnv(), 0);
  });

  afterAll(async () => {
    await app.close();
    // close() runs no shutdown handlers, and the db check left a pooled connection open.
    await app.getContainer().resolve(PrismaProvider).$disconnect();
  });

  it('binds to 127.0.0.1 only', () => {
    expect(app.getServer()?.address()).toMatchObject({ address: '127.0.0.1' });
  });

  it('answers GET /health with the HazelJS liveness body', async () => {
    const response = await fetch(`${baseUrlOf(app)}/health`);

    expect(response.status).toBe(200);
    expect(HealthResponse.parse(await response.json()).status).toBe('alive');
  });

  // Overall status depends on machine load (memory, event-loop lag), so only the checks are asserted.
  it('answers GET /ready with the built-in checks and a healthy db check', async () => {
    const response = await fetch(`${baseUrlOf(app)}/ready`);
    const status = expect.stringMatching(/^(healthy|degraded|unhealthy)$/);

    expect(await response.json()).toMatchObject({
      status,
      timestamp: expect.any(String),
      uptime: expect.any(Number),
      checks: {
        memory: expect.objectContaining({ status }),
        eventLoop: expect.objectContaining({ status }),
        db: expect.objectContaining({ status: 'healthy' }),
      },
    });
  });
});
