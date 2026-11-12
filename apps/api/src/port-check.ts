/**
 * Startup check that the API's port is free, so a second `pnpm dev` stops with one clear line.
 *
 * Serves: NFR-10 (clear startup failures), ADR-0003 (the API on 127.0.0.1:API_PORT); T-1 audit.
 * Used by: apps/api/src/main.ts, before the HazelJS app is built.
 */
import { createServer } from 'node:net';
import type { Env } from './config/env.js';
import { createLogger } from './logging/logger.js';

/**
 * Tells whether a TCP port can be listened on, by opening and closing it once.
 * @param host - The address the API will bind, normally 127.0.0.1.
 * @param port - The TCP port number.
 * @returns True when the port is free; false when another process holds it (EADDRINUSE).
 * @throws Any other listen error, such as EACCES for a port the user may not open.
 * Does not hold the port: another process can still take it before the API listens.
 */
export const isPortFree = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    probe.listen(port, host, () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });

/**
 * Logs one fatal line and ends the process with exit code 1 when `API_PORT` is taken.
 *
 * Why before HazelJS: version 2.0.13 has no `error` listener on its server, so EADDRINUSE from its
 * `listen` is an uncaught exception with a stack trace and no hint of the cause.
 * Does not stop the other process or pick another port.
 * @param env - Parsed configuration; uses `API_HOST`, `API_PORT` and `LOG_LEVEL`.
 * @returns Once the port is free; does not return when it is taken.
 * @throws Listen errors other than EADDRINUSE, from {@link isPortFree}.
 */
export async function exitIfPortTaken(env: Env): Promise<void> {
  if (await isPortFree(env.API_HOST, env.API_PORT)) return;
  createLogger(env.LOG_LEVEL).fatal(
    { port: env.API_PORT },
    'The API port is in use, most likely by an API that is still running. Stop it, or set API_PORT in .env, and restart.',
  );
  process.exit(1);
}
