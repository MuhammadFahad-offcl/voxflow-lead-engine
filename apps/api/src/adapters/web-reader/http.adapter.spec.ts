/**
 * Adapter tests of the real web reader against a local stub server playing several fictional
 * sites; no request leaves the machine and no Lightpanda is needed.
 *
 * Serves: FR-9, ADR-0004, ADR-0003; issue #11 (robots.txt, one request per domain, retries).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { HttpWebReaderAdapter } from './http.adapter.js';
import { isPublicAddress, type ResolveHost } from './public-address.js';

const TEXT = 'Fictional clinic text for the reader. '.repeat(8);
const HOME = `<html><body><p>${TEXT}</p><a href="/contact">Contact</a></body></html>`;

// Requests per host, how many ran at once at most, and how many resets are left to send.
const seen: { host: string; path: string; agent: string }[] = [];
let running = 0;
let mostAtOnce = 0;
let resetsLeft = 0;
let server: Server;
let port = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    const host = (request.headers.host ?? '').split(':')[0] ?? '';
    const path = request.url ?? '';
    seen.push({ host, path, agent: request.headers['user-agent'] ?? '' });
    if (host === 'flaky.example' && resetsLeft > 0) {
      resetsLeft -= 1;
      request.socket.destroy();
      return;
    }
    running += 1;
    mostAtOnce = Math.max(mostAtOnce, running);
    void sleep(20).then(() => {
      running -= 1;
      if (path === '/robots.txt' && host === 'closed.example')
        response.end('User-agent: *\nDisallow: /');
      else if (path === '/robots.txt') response.writeHead(404).end();
      else if (host === 'js.example')
        response.end('<html><body><div id="root"></div></body></html>');
      else response.end(path === '/' ? HOME : `<p>${TEXT}</p>`);
    });
  });
  server.listen(0, '::1');
  await once(server, 'listening');
  port = String((server.address() as AddressInfo).port);
});

// Each test starts with a clean record, so none depends on what ran before it.
beforeEach(() => {
  seen.length = 0;
  mostAtOnce = 0;
  resetsLeft = 0;
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
});

/** The real adapter, with every name resolving to the stub server and ::1 allowed. */
class StubbedReader extends HttpWebReaderAdapter {
  protected override readonly resolveHost: ResolveHost = (hostname) =>
    Promise.resolve([
      hostname === 'private.example'
        ? { address: '127.0.0.3', family: 4 }
        : { address: '::1', family: 6 },
    ]);
  protected override readonly isAllowedAddress = (ip: string): boolean =>
    ip === '::1' || isPublicAddress(ip);
  protected override readonly retryDelayMs = 0;
  // Exposes the check Lightpanda's requests go through.
  allows(url: string): Promise<boolean> {
    return this.isAllowedUrl(url);
  }
}

// Nothing listens there, so a Lightpanda render fails fast.
const reader = new StubbedReader({ LIGHTPANDA_CDP_URL: 'ws://127.0.0.1:9' });
const site = (host: string): string => `http://${host}:${port}/`;
const pathsOf = (host: string): string[] =>
  seen.filter((request) => request.host === host).map(({ path }) => path);

// Proves the real reader reads robots.txt, homepage and contact page, one request per domain.
describe('HttpWebReaderAdapter', () => {
  it('reads robots.txt, the homepage and the contact page, with its user agent', async () => {
    const read = await reader.read(site('clinic.example'));

    expect(read.status).toBe('READ_FETCH');
    expect(pathsOf('clinic.example')).toEqual(['/robots.txt', '/', '/contact']);
    const agent = 'VoxFlowLeadEngine/1.0 (+https://voxflow.agency)';
    expect(seen.map((request) => request.agent)).toEqual([agent, agent, agent]);
  });

  it('stops at robots.txt when it disallows the site', async () => {
    const read = await reader.read(site('closed.example'));

    expect(read).toMatchObject({ reason: 'robots.txt disallows the homepage' });
    expect(pathsOf('closed.example')).toEqual(['/robots.txt']);
  });

  it('runs one request at a time for one domain, while other domains run alongside', async () => {
    await Promise.all([reader.read(site('one.example')), reader.read(site('www.one.example'))]);
    expect(mostAtOnce).toBe(1);

    await Promise.all([reader.read(site('one.example')), reader.read(site('two.example'))]);
    expect(mostAtOnce).toBe(2);
  });

  it('retries a reset connection 3 times, then gives up', async () => {
    resetsLeft = 3;
    expect((await reader.read(site('flaky.example'))).status).toBe('READ_FETCH');

    resetsLeft = 4;
    const read = await reader.read(site('flaky.example'));
    expect(read).toMatchObject({ reason: 'the site could not be read' });
  });

  it('marks a JavaScript page unreadable when Lightpanda cannot be reached', async () => {
    const read = await reader.read(site('js.example'));

    expect(read).toMatchObject({ reason: 'Lightpanda could not render the page' });
  });

  it.each([
    ['http://127.0.0.1/', false],
    ['https://private.example/app.js', false],
    ['data:text/html,hi', false],
    ['https://clinic.example/app.js', true],
  ])('lets Lightpanda request %s: %s', async (url, allowed) => {
    expect(await reader.allows(url)).toBe(allowed);
  });
});
