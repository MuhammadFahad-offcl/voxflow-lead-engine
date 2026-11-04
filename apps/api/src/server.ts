/**
 * Creates the HazelJS app and binds it to one network address.
 *
 * Serves: ADR-0001, ADR-0003, ADR-0013, NFR-5.
 * Used by: apps/api/src/main.ts, apps/api/test/server.int.spec.ts.
 */
import { HazelApp } from '@hazeljs/core';
import { AppModule } from './app.module.js';

/**
 * Starts the API server and resolves once it is listening.
 *
 * Does not reject when the port is taken: HazelJS 2.0.13 has no `error` listener on its server, so
 * EADDRINUSE arrives as an uncaught exception and this promise never settles.
 * @param host - IP address to bind to. Pass 127.0.0.1 so only this laptop can reach the API.
 * @param port - TCP port number. 0 lets the operating system pick a free port.
 * @returns The running app, so the caller can read its address and close it.
 * @throws When a HazelJS module init hook fails.
 */
export async function startServer(host: string, port: number): Promise<HazelApp> {
  const app = await HazelApp.create(AppModule);
  // The host argument exists only through our @hazeljs/core patch (ADR-0013); unpatched, Node
  // would listen on every interface.
  await app.listen(port, host);
  return app;
}
