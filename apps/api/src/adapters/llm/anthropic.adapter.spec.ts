/**
 * Adapter tests of the real Anthropic adapter against a local stub: no network, no key, no charge.
 *
 * Serves: FR-13, FR-33, NFR-4, ADR-0006; issue #13 (thinking off, JSON schema output, retry only
 * what is not billed, no prompt text in logs or errors).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import type { Logger } from '../../logging/logger.js';
import { LlmError, type LlmRequest } from '../../ports/llm.port.js';
import { AnthropicLlmAdapter } from './anthropic.adapter.js';

// Low-entropy on purpose: a random-looking value trips gitleaks' generic-api-key rule.
const KEY = 'fake-key-0000';
const request: LlmRequest = {
  task: 'REVIEW_LABELLING',
  model: 'claude-haiku-5-5',
  system: 'Label each review.',
  user: 'Fictional review: nobody picks up the phone',
  schema: z.object({ labels: z.array(z.string()).min(1) }),
  maxTokens: 2_000,
};

type Reply = (response: ServerResponse) => void;
const json =
  (status: number, body: unknown): Reply =>
  (response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
const message = (text: string, stopReason = 'end_turn') => ({
  id: 'msg_fictional',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text }],
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 812, output_tokens: 34 },
});
const ok = json(200, message('{"labels":["PHONE_UNANSWERED"]}'));

let server: Server;
let stubUrl = '';
let requests: { url: string; key: string; body: string }[] = [];
// Answers come from the front of the queue; the last one repeats.
let replies: Reply[] = [];

class Stubbed extends AnthropicLlmAdapter {
  protected override readonly baseUrl = stubUrl;
  // Long enough for a first request under the full suite's load; the no-answer case waits it once.
  protected override readonly timeoutMs = 1000;
  protected override readonly retryDelayMs = 1;
}

const warn = jest.fn();
const logger = { warn } as unknown as Logger;
const adapter = (): AnthropicLlmAdapter => new Stubbed({ ANTHROPIC_API_KEY: KEY } as Env, logger);

beforeAll(async () => {
  server = createServer((incoming, response) => {
    let body = '';
    incoming.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    incoming.on('end', () => {
      // SDK 1.x sends an API key as a bearer token.
      const key = (incoming.headers.authorization ?? '').replace(/^Bearer /, '');
      requests.push({ url: incoming.url ?? '', key, body });
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

// Proves the request turns thinking off, asks for the schema as JSON, and returns text and usage.
describe('AnthropicLlmAdapter.complete', () => {
  it('posts one message with thinking off and the schema as the output format', async () => {
    const reply = await adapter().complete(request);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: '/v1/messages', key: KEY });
    const body = JSON.parse(requests[0]?.body ?? '') as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 2_000,
      system: 'Label each review.',
      messages: [{ role: 'user', content: 'Fictional review: nobody picks up the phone' }],
      thinking: { type: 'disabled' },
      output_config: {
        format: { type: 'json_schema', schema: expect.objectContaining({ type: 'object' }) },
      },
    });
    expect(body).not.toHaveProperty('temperature');
    expect(reply).toEqual({
      text: '{"labels":["PHONE_UNANSWERED"]}',
      usage: { inputTokens: 812, outputTokens: 34 },
      model: 'claude-haiku-5-5',
      stopReason: 'end_turn',
    });
  });

  it('returns a cut-short or refused answer with its usage, so its cost is still counted', async () => {
    replies = [json(200, message('{"labels":["PHO', 'max_tokens'))];

    const reply = await adapter().complete(request);

    expect(reply).toMatchObject({ text: '{"labels":["PHO', stopReason: 'max_tokens' });
    expect(reply.usage).toEqual({ inputTokens: 812, outputTokens: 34 });
  });
});

// Proves only unbilled failures are retried, and that logs and errors hold no prompt or key.
describe('AnthropicLlmAdapter failures', () => {
  it('retries a 429 and an overloaded 529, logging only the attempt and reason', async () => {
    replies = [json(429, {}), json(529, {}), ok];

    await adapter().complete(request);

    expect(requests).toHaveLength(3);
    expect(warn.mock.calls).toEqual([
      [{ attempt: 1, reason: 'HTTP 429' }, expect.any(String)],
      [{ attempt: 2, reason: 'HTTP 529' }, expect.any(String)],
    ]);
  });

  it('gives up after two retries on 5xx', async () => {
    replies = [json(500, {})];

    await expect(adapter().complete(request)).rejects.toMatchObject({
      message: expect.stringContaining('failed after retries: HTTP 500'),
      maybeBilled: false,
    });
    expect(requests).toHaveLength(3);
  });

  it('retries when the connection is refused, and never leaks the key or prompt', async () => {
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

    const error = await new Down({ ANTHROPIC_API_KEY: KEY } as Env, logger)
      .complete(request)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ maybeBilled: false });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([error, warn.mock.calls])).not.toMatch(/phone|fake-key|Label each/);
  });

  it('writes no prompt to the console even with ANTHROPIC_LOG=debug', async () => {
    const before = process.env['ANTHROPIC_LOG'];
    process.env['ANTHROPIC_LOG'] = 'debug';
    const lines: unknown[] = [];
    const spies = (['debug', 'info', 'warn', 'error', 'log'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args);
      }),
    );
    try {
      replies = [json(400, { error: { message: 'Fictional review: nobody' } })];
      await adapter()
        .complete(request)
        .catch(() => undefined);
    } finally {
      spies.forEach((spy) => {
        spy.mockRestore();
      });
      if (before === undefined) delete process.env['ANTHROPIC_LOG'];
      else process.env['ANTHROPIC_LOG'] = before;
    }

    expect(JSON.stringify(lines)).not.toMatch(/Fictional review|Label each|fake-key/);
  });

  it('refuses a schema with no JSON type before sending anything', async () => {
    const error = await adapter()
      .complete({ ...request, schema: z.unknown() })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ maybeBilled: false, message: expect.stringContaining('schema') });
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['a 401', [json(401, { error: { message: 'bad key fake-key-0000' } })], 'HTTP 401', false],
    ['a 400', [json(400, { error: { message: 'Fictional review: nobody' } })], 'HTTP 400', false],
    ['a wrong shape', [json(200, { content: 'not a list' })], 'unexpected shape', true],
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
    const error = await adapter()
      .complete(request)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ message: expect.stringContaining(text), maybeBilled: billed });
    expect(JSON.stringify(error)).not.toMatch(/Fictional review|fake-key/);
    expect(requests).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
