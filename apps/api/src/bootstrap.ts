/**
 * Startup steps shared by the API and the worker: validate env, build DI, close Prisma on shutdown.
 *
 * Serves: docs/architecture.md §2 and §12, ADR-0007, NFR-5, NFR-10.
 * Used by: apps/api/src/main.ts, apps/api/src/worker.ts, apps/api/src/seed.ts, apps/api/src/server.ts.
 */
import { Container, HazelApp } from '@hazeljs/core';
import { AppModule } from './app.module.js';
import { ENV, InvalidEnvError, loadEnv, type Env } from './config/env.js';
import { PrismaProvider } from './db/prisma.provider.js';
import { createLogger, LOGGER } from './logging/logger.js';

/**
 * Validates the environment, or logs the bad variable names and ends the process with exit code 1.
 *
 * Call it before `createApp`: HazelJS swallows errors thrown while it builds providers or runs
 * `onModuleInit`, so a check there would not stop startup.
 * Does not log any value, only names (NFR-5).
 * @param source - Variables to validate, normally `process.env`.
 * @returns The parsed configuration; does not return when it is invalid.
 * @throws Any error from `loadEnv` other than {@link InvalidEnvError}.
 */
export function loadEnvOrExit(source: Readonly<Record<string, string | undefined>>): Env {
  try {
    return loadEnv(source);
  } catch (error) {
    if (!(error instanceof InvalidEnvError)) throw error;
    // LOG_LEVEL may be the bad variable, so this line uses a fixed level.
    createLogger('fatal').fatal(
      { variables: error.variables },
      'Invalid environment. Fix these variables in .env (see .env.example) and restart.',
    );
    process.exit(1);
  }
}

/**
 * Registers the env and the root logger in DI, then creates the HazelJS app with every provider.
 *
 * Does not listen on a port and does not install signal handlers: the API's `listen` does both;
 * the worker installs signal handlers itself.
 * Does not run `onModuleInit`, `onApplicationBootstrap` or the `module-destroy` shutdown step, and
 * does not await async provider factories: in HazelJS 2.0.13 only `listen()` does those, so the
 * worker gets none of them.
 * @param env - Parsed configuration from {@link loadEnvOrExit} (or a test's fixed values).
 * @returns The app; its container holds `ENV`, `LOGGER` and `PrismaProvider`.
 * @throws When a class provider's constructor throws.
 */
export async function createApp(env: Env): Promise<HazelApp> {
  // HazelApp uses this same singleton container; providers built during create() can inject these.
  const container = Container.getInstance();
  container.registerProvider<Env>({ token: ENV, useValue: env });
  container.registerProvider({ token: LOGGER, useValue: createLogger(env.LOG_LEVEL) });
  return HazelApp.create(AppModule);
}

/**
 * Adds a shutdown handler that disconnects Prisma within 5 seconds.
 *
 * Does not run on `app.close()`: HazelJS runs shutdown handlers only on a signal or an uncaught
 * error. Handlers run in the order they were registered.
 * @param app - The app whose Prisma client to disconnect.
 */
export function registerPrismaShutdown(app: HazelApp): void {
  const prisma = app.getContainer().resolve(PrismaProvider);
  app.registerShutdownHandler({
    name: 'prisma',
    handler: () => prisma.$disconnect(),
    timeout: 5000,
  });
}
