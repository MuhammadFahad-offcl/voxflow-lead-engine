/**
 * Creates the HazelJS app and binds it to one network address.
 *
 * Serves: ADR-0001, ADR-0002, ADR-0003, ADR-0013, NFR-5.
 * Used by: apps/api/src/main.ts, apps/api/test/server.int.spec.ts.
 */
import { HazelApp } from '@hazeljs/core';
import { AppModule } from './app.module.js';
import { PrismaProvider } from './db/prisma.provider.js';

/**
 * Starts the API server and resolves once it is listening.
 *
 * Does not reject when the port is taken: HazelJS 2.0.13 has no `error` listener on its server, so
 * EADDRINUSE is an uncaught exception that ends the process.
 * Does not stop on a throwing `onModuleInit` or synchronous provider factory: HazelJS swallows the
 * error and the server still starts.
 * Does not reject when an async provider factory rejects and no class provider depends on it: the
 * server binds, then HazelJS shuts it down on the unhandled rejection.
 * Does not check the database: a server with an unreachable database still starts.
 * Does not disconnect Prisma on `app.close()`: only the shutdown path does (a signal, or an uncaught
 * error), because `close()` runs no shutdown handlers.
 * @param host - IP address to bind to. Pass 127.0.0.1 so only this laptop can reach the API.
 * @param port - TCP port number. 0 lets the operating system pick a free port.
 * @returns The running app, so the caller can read its address and close it.
 * @throws When a class provider's constructor throws, or an async factory one depends on rejects.
 * `PrismaProvider` throws this way when DATABASE_URL is missing.
 */
export async function startServer(host: string, port: number): Promise<HazelApp> {
  const app = await HazelApp.create(AppModule);
  // The host argument exists only through our @hazeljs/core patch (ADR-0013); unpatched, Node
  // would listen on every interface.
  await app.listen(port, host);
  const prisma = app.getContainer().resolve(PrismaProvider);
  // Registered after listen() so it runs after HazelJS's `http-server` handler: requests still in
  // flight keep their database. `onModuleDestroy` would run before that handler and cut them off.
  app.registerShutdownHandler({
    name: 'prisma',
    handler: () => prisma.$disconnect(),
    timeout: 5000,
  });
  return app;
}
