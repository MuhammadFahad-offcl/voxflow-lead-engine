/**
 * Adapter tests of the real Perplexity embeddings adapter against a local stub: no network, no
 * key, no charge.
 *
 * Serves: FR-16, ADR-0006 (pplx-embed-v1-0.6b, 1024 dimensions); issue #17.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Env } from '../../config/env.js';
import { EMBEDDING_DIMENSIONS, EmbeddingError } from '../../ports/embedding.port.js';
import { PerplexityEmbeddingAdapter } from './perplexity.adapter.js';

// Low-entropy on purpose: a random-looking value trips gitleaks' generic-api-key rule.
const KEY = 'fake-key-0000';
const MODEL = 'pplx-embed-v1-0.6b';

// Perplexity's base64_int8 encoding: one signed byte per dimension.
const int8Base64 = (first: number, length = EMBEDDING_DIMENSIONS): string => {
  const values = new Int8Array(length);
  values[0] = first;
  values[1] = 1;
  return Buffer.from(values.buffer).toString('base64');
};

type Reply = (response: ServerResponse) => void;
const json =
  (status: number, body: unknown): Reply =>
  (response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
const answer = (data: { index: number; embedding: string }[]) =>
  json(200, {
    object: 'list',
    model: MODEL,
    data: data.map((item) => ({ object: 'embedding', ...item })),
    usage: {
      prompt_tokens: 12,
      total_tokens: 12,
      cost: { input_cost: 0.000000048, total_cost: 0.000000048, currency: 'USD' },
    },
  });

let server: Server;
let stubUrl = '';
let requests: { method: string; url: string; auth: string; body: string }[] = [];
let reply: Reply = answer([]);

class Stubbed extends PerplexityEmbeddingAdapter {
  protected override readonly baseUrl = stubUrl;
  protected override readonly timeoutMs = 200;
}

const adapter = (): PerplexityEmbeddingAdapter =>
  new Stubbed({ PERPLEXITY_API_KEY: KEY, PERPLEXITY_EMBEDDING_MODEL: MODEL } as Env);

const rejection = async (promise: Promise<unknown>): Promise<EmbeddingError> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof EmbeddingError)) throw new Error('expected an EmbeddingError');
  return error;
};

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
      reply(response);
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
  reply = answer([
    { index: 0, embedding: int8Base64(3) },
    { index: 1, embedding: int8Base64(-4) },
  ]);
});

// Proves the request matches Perplexity's embeddings API and the int8 answer becomes unit vectors.
describe('PerplexityEmbeddingAdapter', () => {
  it('posts the texts, model, 1024 dimensions and int8 encoding with the bearer key', async () => {
    await adapter().embed(['missed calls', 'google reviews']);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/embeddings',
      auth: `Bearer ${KEY}`,
    });
    expect(JSON.parse(requests[0]?.body ?? '')).toEqual({
      model: MODEL,
      input: ['missed calls', 'google reviews'],
      dimensions: EMBEDDING_DIMENSIONS,
      encoding_format: 'base64_int8',
    });
  });

  it('decodes each int8 embedding to a unit vector, in input order', async () => {
    reply = answer([
      { index: 1, embedding: int8Base64(-4) },
      { index: 0, embedding: int8Base64(3) },
    ]);

    const { vectors } = await adapter().embed(['first', 'second']);

    // (3, 1) and (-4, 1) scaled to length 1.
    expect(vectors[0]?.slice(0, 2)).toEqual([3 / Math.hypot(3, 1), 1 / Math.hypot(3, 1)]);
    expect(vectors[1]?.slice(0, 2)).toEqual([-4 / Math.hypot(4, 1), 1 / Math.hypot(4, 1)]);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it('reports the tokens and the cost Perplexity returned', async () => {
    const { tokens, costUsd } = await adapter().embed(['first', 'second']);

    expect(tokens).toBe(12);
    expect(costUsd.toString()).toBe('4.8e-8');
  });

  it('refuses no texts, or more than 512, without sending a request', async () => {
    expect((await rejection(adapter().embed([]))).maybeBilled).toBe(false);
    expect((await rejection(adapter().embed(new Array<string>(513).fill('x')))).maybeBilled).toBe(
      false,
    );
    expect(requests).toHaveLength(0);
  });

  it('throws a not-billed error for an HTTP error, without the body', async () => {
    reply = json(401, { error: 'Secret detail' });

    const error = await rejection(adapter().embed(['first', 'second']));

    expect(error.message).toBe('Embeddings API refused the request: HTTP 401');
    expect(error.maybeBilled).toBe(false);
  });

  it('throws a maybe-billed error for an answer that is not the embeddings shape', async () => {
    reply = json(200, { data: 'Secret text' });

    const error = await rejection(adapter().embed(['first', 'second']));

    expect(error.message).toBe('Embeddings API answer has an unexpected shape');
    expect(error.maybeBilled).toBe(true);
  });

  it('throws when a vector has the wrong length or a text got no vector', async () => {
    reply = answer([
      { index: 0, embedding: int8Base64(3, 512) },
      { index: 1, embedding: int8Base64(3) },
    ]);
    expect((await rejection(adapter().embed(['first', 'second']))).message).toBe(
      'Embeddings API answer has an unexpected shape',
    );

    reply = answer([{ index: 0, embedding: int8Base64(3) }]);
    expect((await rejection(adapter().embed(['first', 'second']))).message).toBe(
      'Embeddings API answer has an unexpected shape',
    );
  });

  it('throws a maybe-billed error when the API does not answer in time', async () => {
    reply = () => undefined;

    const error = await rejection(adapter().embed(['first', 'second']));

    expect(error.message).toBe('Embeddings API timed out');
    expect(error.maybeBilled).toBe(true);
  });
});
