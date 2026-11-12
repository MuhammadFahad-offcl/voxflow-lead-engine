/**
 * Unit tests of the dashboard's API client with a stubbed `fetch` (no network): every way the API
 * can fail becomes an ApiError, and answers are checked against the shared schema.
 *
 * Serves: FR-30, NFR-3 (a slow API is an error, not a stalled page); issue #16.
 * Used by: `pnpm test`, through the `web` project in jest.config.mjs.
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { ApiError, apiDownload, apiGet } from './api';

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

// Proves the export route hands on the file, and only a short text when something fails.
describe('apiDownload', () => {
  it('passes the file through with only its type and file name', async () => {
    globalThis.fetch = jest.fn(() =>
      Promise.resolve(
        new Response('name,area\r\n', {
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="leads-abc.csv"',
            'x-powered-by': 'fictional',
          },
        }),
      ),
    );

    const response = await apiDownload('/campaigns/abc/leads.csv');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('name,area\r\n');
    expect([...response.headers.keys()].sort((a, b) => a.localeCompare(b))).toEqual([
      'content-disposition',
      'content-type',
    ]);
  });

  it('turns an API error into a one-line text, not its JSON', async () => {
    answer(400, '{"errors":[{"field":"tier","messages":["Invalid option"]}]}');

    const response = await apiDownload('/campaigns/abc/leads.csv?tier=X');

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('The export failed: the API answered 400.');
  });

  it('answers 502 with a text when the API cannot be reached', async () => {
    globalThis.fetch = jest.fn(() => Promise.reject(new TypeError('fetch failed')));

    const response = await apiDownload('/campaigns/abc/leads.csv');

    expect(response.status).toBe(502);
    expect(await response.text()).toBe('The export failed: the API is not reachable.');
  });
});
