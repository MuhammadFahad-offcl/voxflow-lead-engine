/**
 * The process configuration: every variable in .env.example, validated once with Zod at startup.
 *
 * Serves: docs/architecture.md §12, ADR-0007 (DEMO_MODE), NFR-5 (no secret values in errors), FR-36.
 * Used by: apps/api/src/bootstrap.ts, apps/api/src/db/prisma.provider.ts, apps/api/src/server.ts,
 * apps/api/src/adapters/bind.ts, apps/api/test/test-env.ts; apps/api/src/read-website.ts reads only
 * the LIGHTPANDA_CDP_URL rule.
 */
import { z } from 'zod';

// Environment values are always strings, so ports have to be coerced.
const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);

/**
 * The rule for LIGHTPANDA_CDP_URL, Lightpanda's CDP WebSocket: a URL, by default the local one.
 *
 * Exported for `pnpm read-website`, which reads this one variable and not the whole environment.
 */
export const LightpandaCdpUrl = z.url().default('ws://127.0.0.1:9222');

const EnvShape = z.object({
  DEMO_MODE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Only levels HazelJS's winston logger also knows: it reads LOG_LEVEL too, and writes nothing,
  // not even uncaught errors, for fatal, trace or silent (ADR-0014).
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  TZ_DISPLAY: z.string().min(1).default('Asia/Karachi'),

  DATABASE_URL: z.url(),
  // Read by docker compose, not by the app: the app connects with DATABASE_URL.
  POSTGRES_PASSWORD: z.string().optional(),
  LIGHTPANDA_CDP_URL: LightpandaCdpUrl,
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: port(4000),
  WEB_PORT: port(3000),
  // How many leads the worker's lead runner runs at once (FR-32, #15). Kept small: each lead's web
  // context and LLM calls check their spend caps before calling, and parallel calls can each fit.
  LEAD_RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),

  APIFY_TOKEN: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  PERPLEXITY_EMBEDDING_MODEL: z.string().min(1).default('pplx-embed-v1-0.6b'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  VAPI_API_KEY: z.string().optional(),
  VAPI_PHONE_NUMBER_ID: z.string().optional(),
  VAPI_ASSISTANT_ID: z.string().optional(),
  VAPI_WEBHOOK_SECRET: z.string().optional(),
  PUBLIC_HOOKS_BASE_URL: z.url().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().min(1).default('primary'),

  FOUNDER_NAME: z.string().min(1).default('Fahad'),
  FOUNDER_WHATSAPP: z
    .string()
    .regex(/^\+\d{10,15}$/, 'E.164, e.g. +923000000000')
    .optional(),
  BACKUP_DIR: z.string().optional(),
});

type EnvKey = keyof z.infer<typeof EnvShape>;

/**
 * Adds an issue for every key in `required` that is unset while DEMO_MODE=false.
 * @param required - Keys the built real adapters need.
 * @returns A refinement for `superRefine`.
 */
const requireInLiveMode =
  (required: readonly EnvKey[]) =>
  (env: z.infer<typeof EnvShape>, context: z.RefinementCtx): void => {
    if (env.DEMO_MODE) return;
    for (const key of required) {
      if (env[key] === undefined) {
        context.addIssue({ code: 'custom', path: [key], message: 'required when DEMO_MODE=false' });
      }
    }
  };

// List the keys a real adapter needs in the issue that adds it. With DEMO_MODE=true the fakes never
// read them.
const EnvSchema = EnvShape.superRefine(
  requireInLiveMode(['APIFY_TOKEN', 'PERPLEXITY_API_KEY', 'ANTHROPIC_API_KEY']),
);

/** Validated configuration of this process. Read it from DI with the {@link ENV} token. */
export type Env = z.infer<typeof EnvSchema>;

/** DI token under which the parsed {@link Env} is registered. */
export const ENV = 'Env';

/**
 * Thrown when the environment does not match the schema.
 *
 * Does not carry any value: only variable names and whether each is missing or invalid, so it is
 * safe to log (NFR-5).
 */
export class InvalidEnvError extends Error {
  /**
   * Builds the error from the bad variables' names.
   * @param variables - One entry per bad variable, e.g. `DATABASE_URL (missing)`.
   */
  constructor(readonly variables: readonly string[]) {
    super(`Invalid environment: ${variables.join(', ')}`);
    this.name = 'InvalidEnvError';
  }
}

/**
 * Parses and validates the environment.
 *
 * Does not read process.env itself and does not load any .env file: the caller passes the source,
 * so tests can pass fixed values.
 * @param source - Variables to validate, normally `process.env`.
 * @returns The typed configuration with defaults filled in.
 * @throws InvalidEnvError naming every missing or invalid variable, never its value.
 */
export function loadEnv(source: Readonly<Record<string, string | undefined>>): Env {
  // .env.example leaves keys as `KEY=`, which arrives as an empty string: treat it as unset, so an
  // optional key stays undefined and a key with a default takes it.
  const cleaned = Object.fromEntries(
    Object.entries(source).map(([name, value]) => [name, value === '' ? undefined : value]),
  );
  const result = EnvSchema.safeParse(cleaned);
  if (result.success) return result.data;
  // Only the name and a fixed word: Zod messages may quote the rejected input.
  const variables = result.error.issues.map((issue) => {
    const name = String(issue.path[0] ?? '(root)');
    const state = cleaned[name] === undefined ? 'missing' : 'invalid';
    return `${name} (${state})`;
  });
  throw new InvalidEnvError([...new Set(variables)]);
}
