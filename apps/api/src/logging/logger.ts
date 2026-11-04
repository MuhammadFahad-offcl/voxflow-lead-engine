/**
 * The structured logger of the API and worker: pino, one JSON object per line.
 *
 * Serves: NFR-10 (logs carry campaign, lead and attempt IDs), ADR-0014 (pino over HazelJS's logger).
 * Used by: apps/api/src/bootstrap.ts, apps/api/src/worker.ts.
 */
import {
  pino,
  stdTimeFunctions,
  type DestinationStream,
  type LevelWithSilent,
  type Logger,
} from 'pino';

/** The logger type every module receives. Re-exported so callers do not import pino directly. */
export type { Logger } from 'pino';

/** DI token under which the process's root {@link Logger} is registered. */
export const LOGGER = 'Logger';

/**
 * Creates the root logger.
 *
 * Does not mask anything by itself: pass phone numbers through `maskPhone` and never pass secrets,
 * transcripts or review authors.
 * @param level - Lowest level written, from `LOG_LEVEL`; `silent` writes nothing.
 * @param destination - Where lines go. Defaults to standard output: buffered, and flushed
 * synchronously when the process exits, so a line logged just before `process.exit` is not lost.
 * @returns A logger that writes `{"level":"info","time":"<ISO UTC>",...,"msg":"..."}` lines.
 */
export function createLogger(level: LevelWithSilent, destination?: DestinationStream): Logger {
  const options = {
    level,
    // Level as a word and time as ISO UTC, so a person can read the line without a tool.
    formatters: { level: (label: string) => ({ level: label }) },
    timestamp: stdTimeFunctions.isoTime,
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

/** The IDs that tie a log line to one campaign, lead or call attempt (NFR-10). */
export interface LogContext {
  /** `Campaign.id`. */
  campaignId?: string;
  /** `Lead.id`. */
  leadId?: string;
  /** `CallAttempt.id`. */
  attemptId?: string;
}

/**
 * Returns a logger that adds the given IDs to every line it writes.
 *
 * Does not change the parent logger.
 * @param logger - Parent logger, usually the root one from DI.
 * @param context - IDs to attach; omitted ones are left out of the line.
 * @returns The child logger.
 */
export function childLogger(logger: Logger, context: LogContext): Logger {
  return logger.child(context);
}
