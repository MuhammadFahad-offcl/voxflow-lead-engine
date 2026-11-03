import { HazelApp } from '@hazeljs/core';
import { AppModule } from './app.module.js';

export async function startServer(host: string, port: number): Promise<HazelApp> {
  const app = await HazelApp.create(AppModule);
  await app.listen(port, host);
  return app;
}
