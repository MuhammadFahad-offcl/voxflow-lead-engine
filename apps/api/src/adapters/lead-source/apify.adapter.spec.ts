/**
 * Adapter tests of the real Apify client against a local stub: no network, no token, no charge.
 *
 * Serves: FR-5, FR-33, ADR-0015; issue #10 ("never a second paid run for one search").
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { Env } from '../../config/env.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { Logger } from '../../logging/logger.js';
import type { PlaceSearch } from '../../ports/lead-source.port.js';
import { ApifyLeadSourceAdapter } from './apify.adapter.js';

const places: unknown[] = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../../../fixtures/places/dental-lahore.json'),
    'utf8',
  ),
) as unknown[];

const RUN_ID = 'fictional-run-1';
const finishedRun = {
  id: RUN_ID,
  status: 'SUCCEEDED',
  defaultDatasetId: 'fictional-dataset-1',
  chargedEventCounts: { 'place-scraped': 12 },
  pricingInfo: {
    pricingPerEvent: { actorChargeEvents: { 'place-scraped': { eventPriceUsd: 0.006 } } },
  },
};

const search: PlaceSearch = {
  term: 'dental clinic',
  area: 'DHA',
  city: 'Lahore',
  polygon: {
    type: 'Polygon',
    coordinates: [
      [
        [74, 31],
        [75, 31],
        [75, 32],
        [74, 31],
      ],
    ],
  },
  maxResults: 30,
  chargeLimitUsd: new Prisma.Decimal('0.50'),
};

type Reply = (response: ServerResponse) => void;
const json =
  (status: number, body: unknown): Reply =>
  (response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
const dropConnection: Reply = (response) => {
  response.socket?.destroy();
};
const noAnswer: Reply = () => undefined;

let server: Server;
let stubUrl = '';
let requests: { method: string; url: string; body: string }[] = [];
// Each route answers from the front of its queue; the last answer repeats.
let replies: Record<'start' | 'run' | 'items', Reply[]>;

const answer = (queue: Reply[], response: ServerResponse): void => {
  const reply = queue.length > 1 ? queue.shift() : queue[0];
  reply?.(response);
};

const route = (request: IncomingMessage, response: ServerResponse, body: string): void => {
  const url = request.url ?? '';
  requests.push({ method: request.method ?? '', url, body });
  if (request.method === 'POST') answer(replies.start, response);
  else if (url.includes('/datasets/')) answer(replies.items, response);
  else answer(replies.run, response);
};

class StubbedAdapter extends ApifyLeadSourceAdapter {
  protected override readonly baseUrl = stubUrl;
  protected override readonly waitSecs = 1;
  protected override readonly startTimeoutSecs = 1;
}

// Reads the protected limits as shipped, with nothing overridden.
class LimitsOfTheRealAdapter extends ApifyLeadSourceAdapter {
  limits(): { startTimeoutSecs: number; waitSecs: number } {
    return { startTimeoutSecs: this.startTimeoutSecs, waitSecs: this.waitSecs };
  }
}

const warn = jest.fn();
const logger = { warn } as unknown as Logger;
const adapter = (): ApifyLeadSourceAdapter =>
  new StubbedAdapter({ APIFY_TOKEN: 'fictional-token' } as Env, logger);
const starts = (): number => requests.filter((request) => request.method === 'POST').length;

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      route(request, response, body);
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
  warn.mockClear();
  replies = {
    start: [json(201, { data: { id: RUN_ID } })],
    run: [json(200, { data: finishedRun })],
    items: [json(200, places)],
  };
});

// Proves the run carries Apify's own charge limit and the ADR-0015 input.
describe('ApifyLeadSourceAdapter.start', () => {
  it('starts Compass once and returns the run id', async () => {
    await expect(adapter().start(search)).resolves.toBe(RUN_ID);

    expect(starts()).toBe(1);
    expect(requests[0]?.url).toContain('/v2/actors/compass~crawler-google-places/runs');
  });

  it('sends the charge limit and run timeout with the request', async () => {
    await adapter().start(search);

    const query = new URL(requests[0]?.url ?? '', stubUrl).searchParams;
    expect(query.get('maxTotalChargeUsd')).toBe('0.5');
    expect(query.get('timeout')).toBe('600');
  });

  it('sends the polygon, never a text location', async () => {
    await adapter().start(search);

    const input = JSON.parse(requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(input['customGeolocation']).toEqual(search.polygon);
    expect(input).not.toHaveProperty('locationQuery');
  });

  it('refuses a limit below $0.50 without sending anything', async () => {
    const tooLow = { ...search, chargeLimitUsd: new Prisma.Decimal('0.49') };

    await expect(adapter().start(tooLow)).rejects.toThrow('at least $0.50');
    expect(requests).toHaveLength(0);
  });
});

// Proves the money rule: one search can never start a second paid run, whatever the failure.
describe('ApifyLeadSourceAdapter.start failures', () => {
  it.each([
    ['a 503', json(503, { error: { type: 'fictional', message: 'down' } })],
    ['a 429', json(429, { error: { type: 'fictional', message: 'slow down' } })],
    ['a dropped connection', dropConnection],
  ])('sends exactly one request after %s', async (_case, reply) => {
    replies.start = [reply];

    await expect(adapter().start(search)).rejects.toThrow();

    expect(starts()).toBe(1);
  });

  it('gives up on a start that gets no answer, sending one request, within its limit', async () => {
    replies.start = [noAnswer];
    const startedAt = Date.now();

    await expect(adapter().start(search)).rejects.toThrow();

    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(starts()).toBe(1);
  });

  it('keeps its limit short enough for one search to fit the 15-minute lease', () => {
    const { startTimeoutSecs, waitSecs } = new LimitsOfTheRealAdapter(
      { APIFY_TOKEN: 'fictional-token' } as Env,
      logger,
    ).limits();

    expect(startTimeoutSecs + waitSecs).toBeLessThan(15 * 60);
  });
});

// Proves reading is free and repeatable: results, the true charge, retries, and no new run.
describe('ApifyLeadSourceAdapter.collect', () => {
  it('returns the validated items, the true charge and how the run ended', async () => {
    const { items, costUsd, status, skippedCount } = await adapter().collect(RUN_ID);

    expect(items).toHaveLength(12);
    expect(costUsd?.toFixed(5)).toBe('0.07200');
    expect({ status, skippedCount }).toEqual({ status: 'SUCCEEDED', skippedCount: 0 });
  });

  it('reattaches after a restart: a new adapter reads the run and starts nothing', async () => {
    await adapter().start(search);
    requests = [];

    const { items } = await adapter().collect(RUN_ID);

    expect(items).toHaveLength(12);
    expect(starts()).toBe(0);
  });

  it('retries a failed read', async () => {
    replies.run = [json(503, { error: { type: 'fictional' } }), json(200, { data: finishedRun })];

    const { items } = await adapter().collect(RUN_ID);

    expect(items).toHaveLength(12);
    expect(starts()).toBe(0);
  });

  it('gives up on a read after its 3 retries', async () => {
    replies.items = [json(503, { error: { type: 'fictional' } })];

    await expect(adapter().collect(RUN_ID)).rejects.toThrow();

    expect(requests.filter((request) => request.url.includes('/datasets/'))).toHaveLength(4);
  }, 20_000);

  it('keeps what a failed run produced, because it was paid for', async () => {
    replies.run = [json(200, { data: { ...finishedRun, status: 'FAILED' } })];

    const { items, costUsd, status } = await adapter().collect(RUN_ID);

    expect(items).toHaveLength(12);
    expect(costUsd).not.toBeNull();
    expect(status).toBe('FAILED');
    expect(warn).toHaveBeenCalledWith({ runId: RUN_ID, status: 'FAILED' }, expect.any(String));
  });

  it('reports a timed-out run as timed out, with what it produced', async () => {
    replies.run = [json(200, { data: { ...finishedRun, status: 'TIMED-OUT' } })];

    await expect(adapter().collect(RUN_ID)).resolves.toMatchObject({ status: 'TIMED-OUT' });
  });

  it('refuses a run that is still going after the wait', async () => {
    replies.run = [json(200, { data: { ...finishedRun, status: 'RUNNING' } })];

    await expect(adapter().collect(RUN_ID)).rejects.toThrow('still RUNNING');
  });

  it('gives a null charge when the run has no price list', async () => {
    replies.run = [json(200, { data: { ...finishedRun, pricingInfo: undefined } })];

    await expect(adapter().collect(RUN_ID)).resolves.toMatchObject({ costUsd: null });
  });

  it('skips an invalid item, logging its place id and nothing else', async () => {
    const bad = { placeId: 'fictional-bad', title: '', phone: '+923000000099' };
    replies.items = [json(200, [bad, ...places])];

    const { items, skippedCount } = await adapter().collect(RUN_ID);

    expect(items).toHaveLength(12);
    expect(skippedCount).toBe(1);
    expect(warn).toHaveBeenCalledWith({ placeId: 'fictional-bad' }, expect.any(String));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('+923000000099');
  });

  it('startReviews sends Scraperlink input and returns run id', async () => {
    const runId = await adapter().startReviews(['place-1', 'place-2'], new Prisma.Decimal('0.02'));

    expect(runId).toBe(RUN_ID);
    const postReq = requests.find((r) => r.method === 'POST');
    const input = JSON.parse(postReq?.body ?? '{}') as Record<string, unknown>;
    expect(input['placeIds']).toEqual(['place-1', 'place-2']);
    expect(input['reviews']).toBe(true);
    expect(input['maxReviews']).toBe(30);
    expect(input['reviewsSort']).toBe('newest');
  });

  it('collectReviews collects and parses review items', async () => {
    const reviewData = [
      {
        placeId: 'place-1',
        reviews: [
          {
            reviewId: 'r1',
            text: 'Friendly staff',
            stars: 5,
            publishedAtDate: '2026-10-10T00:00:00.000Z',
            responseFromOwnerText: null,
            responseFromOwnerDate: null,
            language: 'en',
            originalLanguage: 'en',
          },
        ],
      },
    ];
    replies.items = [json(200, reviewData)];

    const result = await adapter().collectReviews(RUN_ID);

    expect(result.status).toBe('SUCCEEDED');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.placeId).toBe('place-1');
  });
});

// Proves pass 2 is bounded like pass 1: Apify's own limit goes on the run, and no start is retried.
describe('ApifyLeadSourceAdapter reviews run money rules', () => {
  it('sends the reserved charge limit with the request', async () => {
    await adapter().startReviews(['place-1'], new Prisma.Decimal('0.02'));

    expect(requests[0]?.url).toContain('maxTotalChargeUsd=0.02');
  });

  it('sends exactly one request after a 503, so a failed start never pays twice', async () => {
    replies.start = [json(503, { error: { type: 'fictional', message: 'down' } })];

    await expect(adapter().startReviews(['place-1'], new Prisma.Decimal('0.01'))).rejects.toThrow();

    expect(starts()).toBe(1);
  });

  it('limits one run to $0.01 per place, rounded up to the cent', () => {
    expect(adapter().chargeLimitReviewsUsd(1).toString()).toBe('0.01');
    expect(adapter().chargeLimitReviewsUsd(30).toString()).toBe('0.3');
  });
});
