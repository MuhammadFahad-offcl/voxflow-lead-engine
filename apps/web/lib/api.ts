/**
 * The dashboard's only way to the API: server-side fetches to 127.0.0.1, every answer checked with
 * the shared Zod schema. Server Components and Server Actions call it; the browser never does, so
 * the API stays bound to localhost with no CORS (ADR-0003).
 *
 * Serves: FR-30 (dashboard pages), NFR-3 (2-second timeout); issue #16.
 * Used by: apps/web/app/**, apps/web/lib/api.spec.ts.
 */
import { z } from 'zod';

// Same names and defaults as apps/api/src/config/env.ts.
const ApiAddressEnv = z.object({
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
});
const env = ApiAddressEnv.parse(process.env);

const API_BASE_URL = `http://${env.API_HOST}:${String(env.API_PORT)}`;
// A hung API must show as an error, not stall the page past NFR-3's 2 seconds.
const TIMEOUT_MS = 2000;

/** The API answered with an error status, could not be reached, or sent something unreadable. */
export class ApiError extends Error {
  /**
   * Builds the error.
   * @param status - The HTTP status; 0 when the API could not be reached or answered too slowly.
   * @param body - The parsed JSON body, when there was one.
   * @param options - The underlying error, as `cause`.
   */
  constructor(
    readonly status: number,
    readonly body: unknown,
    options?: ErrorOptions,
  ) {
    super(
      status === 0 ? 'The API is not reachable' : `The API answered ${String(status)}`,
      options,
    );
    this.name = 'ApiError';
  }
}

/**
 * Sends one request to the API and reads its JSON body.
 * @param path - Path and query, e.g. "/campaigns".
 * @param init - Method and body.
 * @returns The status and the parsed body (null when there was none).
 * @throws ApiError: status 0 when the API is down or slower than 2 seconds (body included); the
 * answer's status when its body is not JSON.
 */
async function send(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    throw new ApiError(0, null, { cause: error });
  }
  if (text === '') return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch (error) {
    // An HTML or plain-text error page: keep the status, drop the body.
    throw new ApiError(response.status, null, { cause: error });
  }
}

/**
 * Reads a resource and checks its shape.
 * @param path - Path and query, e.g. "/campaigns".
 * @param schema - The shared schema the answer must match.
 * @returns The parsed answer.
 * @throws ApiError for an error status, an unreachable or slow API, or a body that is not JSON;
 * ZodError for an answer of the wrong shape (the API and dashboard are out of step).
 */
export async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const { status, body } = await send(path, { method: 'GET' });
  if (status >= 400) throw new ApiError(status, body);
  return schema.parse(body);
}
