/**
 * Creates the HazelJS app and binds it to one network address.
 *
 * Serves: ADR-0001, ADR-0002, ADR-0003, ADR-0013, NFR-5, NFR-10 (`db` readiness check).
 * Used by: apps/api/src/main.ts, apps/api/test/db.int.spec.ts, apps/api/test/server.int.spec.ts.
 */
import type { HazelApp } from '@hazeljs/core';
import { createApp, registerPrismaShutdown } from './bootstrap.js';
import type { Env } from './config/env.js';
import { createDbHealthCheck } from './db/db-health.js';
import { PrismaProvider } from './db/prisma.provider.js';

/**
 * Starts the API server on `env.API_HOST` and resolves once it is listening.
 *
 * Does not validate the environment: the caller passes an already parsed `Env`, because HazelJS
 * would swallow a validation error thrown inside it (see the next lines).
 * Does not reject when the port is taken: HazelJS 2.0.13 has no `error` listener on its server, so
 * EADDRINUSE is an uncaught exception that ends the process.
 * Does not stop on a throwing `onModuleInit` or synchronous provider factory: HazelJS swallows the
 * error and the server still starts.
 * Does not reject when an async provider factory rejects and no class provider depends on it: the
 * server binds, then HazelJS shuts it down on the unhandled rejection.
 * Does not check the database at startup: a server with an unreachable database still starts, and
 * `GET /ready` reports `db` as unhealthy.
 * Does not disconnect Prisma on `app.close()`: only the shutdown path does (a signal, or an uncaught
 * error), because `close()` runs no shutdown handlers.
 * @param env - Parsed configuration. `API_HOST` should be 127.0.0.1 so only this laptop can reach
 * the API.
 * @param port - TCP port number, normally `env.API_PORT`. 0 lets the operating system pick one.
 * @returns The running app, so the caller can read its address and close it.
 * @throws When a class provider's constructor throws, or an async factory one depends on rejects.
 */
export async function startServer(env: Env, port: number): Promise<HazelApp> {
  const app = await createApp(env);
  app.registerHealthCheck(createDbHealthCheck(app.getContainer().resolve(PrismaProvider)));
  // The host argument exists only through our @hazeljs/core patch (ADR-0013); unpatched, Node
  // would listen on every interface.
  await app.listen(port, env.API_HOST);
  // Registered after listen() so it runs after HazelJS's `http-server` handler: requests still in
  // flight keep their database. `onModuleDestroy` would run before that handler and cut them off.
  registerPrismaShutdown(app);
  return app;
}
