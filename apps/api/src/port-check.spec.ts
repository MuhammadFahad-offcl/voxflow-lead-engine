/**
 * Unit tests of the startup port check, on real local sockets.
 *
 * Serves: NFR-10, ADR-0003; T-1 audit (a taken port was an uncaught EADDRINUSE).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { loadEnv } from './config/env.js';
import { exitIfPortTaken, isPortFree } from './port-check.js';

const HOST = '127.0.0.1';
let holder: Server | null = null;

// Holds a free port on 127.0.0.1 and returns its number.
const holdPort = async (): Promise<number> => {
  const server = createServer();
  holder = server;
  await new Promise<void>((done) => server.listen(0, HOST, done));
  return (server.address() as AddressInfo).port;
};

afterEach(async () => {
  jest.restoreAllMocks();
  const server = holder;
  holder = null;
  if (server !== null) await new Promise((done) => server.close(done));
});

// Proves a taken port stops startup with exit code 1 and a free one lets it go on.
describe('exitIfPortTaken', () => {
  it('tells a held port from a free one', async () => {
    const port = await holdPort();

    expect(await isPortFree(HOST, port)).toBe(false);
    expect(await isPortFree(HOST, 0)).toBe(true);
  });

  it('ends the process with exit code 1 when API_PORT is in use', async () => {
    const port = await holdPort();
    const env = loadEnv({
      DATABASE_URL: 'postgresql://fictional:fictional@localhost:5432/fictional',
      API_PORT: String(port),
      LOG_LEVEL: 'error',
    });
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    await expect(exitIfPortTaken(env)).rejects.toThrow('process.exit');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
