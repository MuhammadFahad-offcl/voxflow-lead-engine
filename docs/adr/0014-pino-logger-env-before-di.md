# 0014. pino for structured logs; validate the environment before HazelJS starts

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Muhammad Fahad
- **PRD links:** NFR-5, NFR-10; ADR-0001, ADR-0007, ADR-0013

## Context

NFR-10 needs one JSON object per log line, carrying `campaignId`, `leadId` and `attemptId`, with the level set by `LOG_LEVEL`. docs/architecture.md §13 left the choice between HazelJS's logger and pino to a Cycle 1 ADR (prompt C1-04).

HazelJS 2.0.13's logger (`@hazeljs/core/dist/logger.js`) is a winston instance that:

- prints coloured text, not JSON, and offers no way to switch format;
- calls `dotenv.config()` as soon as it is imported, which loads any `.env` in the working directory into `process.env`;
- creates a `logs/` folder and writes files there by default.

A second, related problem: HazelJS swallows errors thrown in `onModuleInit` and in synchronous provider factories, and a rejecting async factory that nothing depends on exits with code 0 (written down on `startServer` in `apps/api/src/server.ts`). So a configuration check placed inside HazelJS's startup cannot stop the process.

## Options considered

1. **pino for our logs** — JSON lines by default, child loggers for IDs, small, the de facto Node choice. One more dependency; HazelJS's own internal lines stay in winston's format.
2. **HazelJS's winston logger** — no new dependency. Not JSON, loads `.env` on import (against NFR-5's "read once, in one place"), writes log files we do not want, and is not exported as a stable API.
3. **winston directly, configured for JSON** — JSON is possible, but child loggers and level handling are clumsier than pino's, and it is a larger dependency for the same result.

## Decision

Option 1: `pino` 10.4.0 (published 2026-10-02), wrapped in `apps/api/src/logging/logger.ts` (`createLogger`, `childLogger`, `LOGGER` DI token) with a word level and ISO UTC time. Phone numbers go through `maskPhone` before they are logged.

The environment is parsed with Zod by `loadEnvOrExit` in each entry point (`main.ts`, `worker.ts`) **before** `HazelApp.create`; on failure it logs only the variable names and exits 1. The parsed `Env` is then registered in DI for providers to inject. No startup check lives in `onModuleInit` or a provider factory.

## Consequences

- Our lines are JSON; HazelJS's own startup and shutdown lines are still coloured text from winston on the same output. Accepted for v1; revisit if HazelJS lets us replace its logger.
- HazelJS's logger still calls `dotenv.config()` when it is imported. Tests therefore never read configuration from `process.env`: they build their `Env` with `apps/api/test/test-env.ts` (demo mode, no service keys).
- A bad `.env` stops the API and the worker with exit code 1 and a list of names, verified by running both.
- Revisit if HazelJS ships a pluggable logger or stops swallowing startup errors.
