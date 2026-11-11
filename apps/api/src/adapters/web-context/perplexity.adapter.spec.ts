/**
 * Adapter tests of the real Perplexity adapter against a local stub: no network, no key, no charge.
 *
 * Serves: FR-12, FR-33, NFR-4; issue #12 (retry only what is not billed; no text in logs).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Env } from '../../config/env.js';
import type { Logger } from '../../logging/logger.js';
import { WebContextError } from '../../ports/web-context.port.js';
import { PerplexityWebContextAdapter } from './perplexity.adapter.js';
import { buildSearchQuery } from './search-results.js';

// Low-entropy on purpose: a random-looking value trips gitleaks' generic-api-key rule.
const KEY = 'fake-key-0000';
const business = {
  name: 'Fictional Bright Smile Dental',
  area: 'DHA Phase 5',
  city: 'Lahore',
  website: 'https://www.p01.example.com/',
};

type Reply = (response: ServerResponse) => void;
const json =
  (status: number, body: unknown): Reply =>
  (response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
const ok = json(200, {
  id: 'fictional-1',
  results: [
    { title: 'Page', url: 'https://d.example.com/a', snippet: 'Secret clinic text', date: null },
  ],
});

let server: Server;
let stubUrl = '';
let requests: { method: string; url: string; auth: string; body: string }[] = [];
// Answers come from the front of the queue; the last one repeats.
let replies: Reply[] = [];

class Stubbed extends PerplexityWebContextAdapter {
  protected override readonly baseUrl = stubUrl;
  protected override readonly timeoutMs = 200;
  protected override readonly retryDelayMs = 1;
}

const warn = jest.fn();
const logger = { warn } as unknown as Logger;
const adapter = (): PerplexityWebContextAdapter =>
  new Stubbed({ PERPLEXITY_API_KEY: KEY } as Env, logger);

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        auth: request.headers.authorization ?? '',
        body,
      });
      (replies.length > 1 ? replies.shift() : replies[0])?.(response);
    });
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  stubUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((done) => {
    server.close(done);
  });
});

beforeEach(() => {
  requests = [];
  replies = [ok];
  warn.mockClear();
});

// Proves the request matches the Search API docs and the answer becomes a priced context.
describe('PerplexityWebContextAdapter.getContext', () => {
  it('posts one web search with the key and returns the context at $0.005', async () => {
    const { context, costUsd } = await adapter().getContext(business);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/search', auth: `Bearer ${KEY}` });
    expect(JSON.parse(requests[0]?.body ?? '')).toEqual({
      query: 'Fictional Bright Smile Dental DHA Phase 5 Lahore p01.example.com',
      max_results: 5,
      search_type: 'web',
    });
    expect(context.sources).toEqual([
      { title: 'Page', url: 'https://d.example.com/a', snippet: 'Secret clinic text', date: null },
    ]);
    expect(costUsd.toString()).toBe('0.005');
    expect(adapter().maxCostUsd().equals(costUsd)).toBe(true);
  });

  it('accepts no results as an empty context', async () => {
    replies = [json(200, { id: 'x', results: [] })];

    expect((await adapter().getContext(business)).context).toEqual({ summary: '', sources: [] });
  });
});

// Proves only unbilled failures are retried, and that logs and errors hold no business text.
describe('PerplexityWebContextAdapter failures', () => {
  it('retries a 429, then succeeds, logging only the attempt and reason', async () => {
    replies = [json(429, {}), ok];

    await adapter().getContext(business);

    expect(requests).toHaveLength(2);
    expect(warn.mock.calls).toEqual([[{ attempt: 1, reason: 'HTTP 429' }, expect.any(String)]]);
  });

  it('gives up after two retries on 5xx', async () => {
    replies = [json(503, {})];

    await expect(adapter().getContext(business)).rejects.toMatchObject({
      message: expect.stringContaining('failed after retries: HTTP 503'),
      maybeBilled: false,
    });
    expect(requests).toHaveLength(3);
  });

  it('retries when the connection is refused, and never leaks the key or query', async () => {
    const closed = createServer();
    await new Promise<void>((done) => {
      closed.listen(0, '127.0.0.1', done);
    });
    const { port } = closed.address() as AddressInfo;
    await new Promise((done) => {
      closed.close(done);
    });
    class Down extends Stubbed {
      protected override readonly baseUrl = `http://127.0.0.1:${String(port)}`;
    }

    const error = await new Down({ PERPLEXITY_API_KEY: KEY } as Env, logger)
      .getContext(business)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WebContextError);
    expect(error).toMatchObject({ maybeBilled: false });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([error, warn.mock.calls])).not.toMatch(/Bright|fictional-key|Lahore/);
  });

  it.each([
    ['a 401', [json(401, { error: 'bad key fictional-key-123' })], 'HTTP 401', false],
    ['a 422', [json(422, { detail: [] })], 'HTTP 422', false],
    ['a wrong shape', [json(200, { results: [{ title: 'only' }] })], 'unexpected shape', true],
    ['text that is not JSON', [(r: ServerResponse) => r.end('<html>')], 'unreadable', true],
    [
      'a dropped connection',
      [(r: ServerResponse) => r.socket?.destroy()],
      'connection failed',
      true,
    ],
    ['no answer in time', [() => undefined], 'timed out', true],
  ])('throws at once on %s, with one request and no retry', async (_what, queue, text, billed) => {
    replies = queue;

    // A refused request is not billed; a lost, late or odd answer may have been, so it says so.
    await expect(adapter().getContext(business)).rejects.toMatchObject({
      message: expect.stringContaining(text),
      maybeBilled: billed,
    });
    expect(requests).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

// Proves the query words and omits a missing site.
describe('buildSearchQuery', () => {
  it('leaves out the site when the listing has none', () => {
    expect(buildSearchQuery({ ...business, website: null })).toBe(
      'Fictional Bright Smile Dental DHA Phase 5 Lahore',
    );
  });
});
