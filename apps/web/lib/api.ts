/**
 * The dashboard's only way to the API: server-side fetches to 127.0.0.1, every answer checked with
 * the shared Zod schema. Server Components and Server Actions call it; the browser never does, so
 * the API stays bound to localhost with no CORS (ADR-0003).
 *
 * Serves: FR-30 (dashboard pages), NFR-3 (2-second timeout); issue #16.
 * Used by: apps/web/app/**.
 */
import type { z } from 'zod';
import { z as zod } from 'zod';

// Same names and defaults as apps/api/src/config/env.ts.
const ApiAddressEnv = zod.object({
  API_HOST: zod.string().min(1).default('127.0.0.1'),
  API_PORT: zod.coerce.number().int().min(1).max(65535).default(4000),
});
const env = ApiAddressEnv.parse(process.env);

/** Where the API listens, e.g. "http://127.0.0.1:4000". */
const API_BASE_URL = `http://${env.API_HOST}:${String(env.API_PORT)}`;
// A hung API must show as an error, not stall the page past NFR-3's 2 seconds.
const TIMEOUT_MS = 2000;

/** The API answered with an error status, or could not be reached. */
export class ApiError extends Error {
  /**
   * Builds the error.
   * @param status - The HTTP status; 0 when the API could not be reached.
   * @param body - The parsed JSON body, when there was one.
   */
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(status === 0 ? 'The API is not reachable' : `The API answered ${String(status)}`);
    this.name = 'ApiError';
  }
}

/**
 * Sends one request to the API and reads its JSON body.
 * @param path - Path and query, e.g. "/campaigns".
 * @param init - Method and body.
 * @returns The status and the parsed body (null when there was none).
 * @throws ApiError (status 0) when the API is down or slower than 2 seconds.
 */
async function send(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(0, null);
  }
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

/**
 * Reads a resource and checks its shape.
 * @param path - Path and query, e.g. "/campaigns".
 * @param schema - The shared schema the answer must match.
 * @returns The parsed answer.
 * @throws ApiError for an error status or an unreachable API; ZodError for an answer of the wrong
 * shape (the API and dashboard are out of step).
 */
export async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const { status, body } = await send(path, { method: 'GET' });
  if (status >= 400) throw new ApiError(status, body);
  return schema.parse(body);
}
