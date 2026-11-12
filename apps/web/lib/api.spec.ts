/**
 * Unit tests of the dashboard's API client with a stubbed `fetch` (no network): every way the API
 * can fail becomes an ApiError, and answers are checked against the shared schema.
 *
 * Serves: FR-30, NFR-3 (a slow API is an error, not a stalled page); issue #16.
 * Used by: `pnpm test`, through the `web` project in jest.config.mjs.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { ApiError, apiGet } from './api';

const realFetch = globalThis.fetch;
const answer = (status: number, body: string) => {
  globalThis.fetch = jest.fn(() => Promise.resolve(new Response(body, { status })));
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

// Proves pages get either a checked answer or an ApiError they can show, never a raw failure.
describe('apiGet', () => {
  it('returns the answer when it matches the schema', async () => {
    answer(200, '{"ok":true}');

    await expect(apiGet('/x', z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true });
  });

  it('throws ApiError with the status and body for a 404', async () => {
    answer(404, '{"message":"not found"}');

    await expect(apiGet('/x', z.unknown())).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      body: { message: 'not found' },
    });
  });

  it('throws ApiError with status 0 when the API cannot be reached or is too slow', async () => {
    globalThis.fetch = jest.fn(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));

    const error = await apiGet('/x', z.unknown()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, message: 'The API is not reachable' });
  });

  it('throws ApiError, not a SyntaxError, for an error page that is not JSON', async () => {
    answer(502, '<html>Bad gateway</html>');

    await expect(apiGet('/x', z.unknown())).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
    });
  });

  it('throws a ZodError for an answer of the wrong shape', async () => {
    answer(200, '{"ok":"yes"}');

    await expect(apiGet('/x', z.object({ ok: z.boolean() }))).rejects.toMatchObject({
      name: 'ZodError',
    });
  });
});
