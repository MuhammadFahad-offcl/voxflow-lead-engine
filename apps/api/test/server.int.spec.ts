import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { HazelApp } from '@hazeljs/core';
import { HealthResponse } from '@voxflow/shared';
import { startServer } from '../src/server.js';

describe('API server', () => {
  let app: HazelApp;
  let baseUrl: string;

  beforeAll(async () => {
    app = await startServer('127.0.0.1', 0);
    const address = app.getServer()?.address();
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('API server is not listening on a TCP port');
    }
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('binds to 127.0.0.1 only', () => {
    expect(app.getServer()?.address()).toMatchObject({ address: '127.0.0.1' });
  });

  it('answers GET /health with the HazelJS liveness body', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(HealthResponse.parse(await response.json()).status).toBe('alive');
  });

  // Overall status depends on machine load (memory, event-loop lag); from #6 on, assert our own checks.
  it('answers GET /ready with a HealthStatus body that includes the built-in checks', async () => {
    const response = await fetch(`${baseUrl}/ready`);
    const status = expect.stringMatching(/^(healthy|degraded|unhealthy)$/);

    expect(await response.json()).toMatchObject({
      status,
      timestamp: expect.any(String),
      uptime: expect.any(Number),
      checks: {
        memory: expect.objectContaining({ status }),
        eventLoop: expect.objectContaining({ status }),
      },
    });
  });
});
