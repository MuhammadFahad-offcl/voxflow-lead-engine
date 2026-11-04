/**
 * The process configuration: every variable in .env.example, validated once with Zod at startup.
 *
 * Serves: docs/architecture.md §12, ADR-0007 (DEMO_MODE), NFR-5 (no secret values in errors), FR-36.
 * Used by: apps/api/src/bootstrap.ts, apps/api/src/db/prisma.provider.ts, apps/api/src/server.ts,
 * apps/api/test/test-env.ts.
 */
import { z } from 'zod';

// .env.example leaves unused keys as `KEY=`, which arrives as an empty string; treat it as unset.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

// Environment values are always strings, so ports have to be coerced.
const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);

const EnvShape = z.object({
  DEMO_MODE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TZ_DISPLAY: z.string().min(1).default('Asia/Karachi'),

  DATABASE_URL: z.url(),
  LIGHTPANDA_CDP_URL: z.url().default('ws://127.0.0.1:9222'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: port(4000),
  WEB_PORT: port(3000),

  APIFY_TOKEN: optional(z.string()),
  APIFY_ACTOR_ID: optional(z.string()),
  PERPLEXITY_API_KEY: optional(z.string()),
  PERPLEXITY_EMBEDDING_MODEL: z.string().min(1).default('pplx-embed-v1-0.6b'),
  ANTHROPIC_API_KEY: optional(z.string()),
  OPENAI_API_KEY: optional(z.string()),

  VAPI_API_KEY: optional(z.string()),
  VAPI_PHONE_NUMBER_ID: optional(z.string()),
  VAPI_ASSISTANT_ID: optional(z.string()),
  VAPI_WEBHOOK_SECRET: optional(z.string()),
  PUBLIC_HOOKS_BASE_URL: optional(z.url()),

  GOOGLE_CLIENT_ID: optional(z.string()),
  GOOGLE_CLIENT_SECRET: optional(z.string()),
  GOOGLE_REFRESH_TOKEN: optional(z.string()),
  GOOGLE_CALENDAR_ID: z.string().min(1).default('primary'),

  FOUNDER_NAME: z.string().min(1).default('Fahad'),
  FOUNDER_WHATSAPP: optional(z.string().regex(/^\+\d{10,15}$/, 'E.164, e.g. +923000000000')),
  BACKUP_DIR: optional(z.string()),
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

// List the keys a real adapter needs in the issue that adds it, e.g. ['APIFY_TOKEN', 'APIFY_ACTOR_ID']
// in #10. Empty for now: no real adapter exists. With DEMO_MODE=true the fakes never read them.
const EnvSchema = EnvShape.superRefine(requireInLiveMode([]));

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
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;
  // Only the name and a fixed word: Zod messages may quote the rejected input.
  const variables = result.error.issues.map((issue) => {
    const name = String(issue.path[0] ?? '(root)');
    const state = source[name] === undefined || source[name] === '' ? 'missing' : 'invalid';
    return `${name} (${state})`;
  });
  throw new InvalidEnvError([...new Set(variables)]);
}
