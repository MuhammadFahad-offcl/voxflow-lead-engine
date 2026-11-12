/**
 * Adapter tests of the checked GET on local stub servers; no request leaves the machine.
 *
 * Serves: FR-9, ADR-0003, ADR-0004; issue #11 (redirect and DNS checks, timeout, size limit).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { once } from 'node:events';
import { createServer, type OutgoingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { allowedOnlyLookup, isPublicAddress, ReadRefusedError } from './public-address.js';
import { safeGet } from './safe-get.js';

const HTML = '<html><body><h1>Fictional Smile Clinic</h1></body></html>';
// "دكتر" (doctor) in windows-1256, the code page of many older Urdu and Arabic sites.
const DOCTOR_1256 = Buffer.from([0xcf, 0xdf, 0xca, 0xd1]);
const page1256 = (head: string) =>
  Buffer.concat([
    Buffer.from(`<html><head>${head}</head><body>`),
    DOCTOR_1256,
    Buffer.from('</body></html>'),
  ]);
const MAX_BYTES = 1000;
const BIG = 'x'.repeat(MAX_BYTES + 1);
// {local} becomes the port of the local service the redirects try to reach.
const ROUTES: Record<string, [number, OutgoingHttpHeaders, (string | Buffer)?]> = {
  '/home': [200, {}, HTML],
  '/gzip': [200, { 'content-encoding': 'gzip' }, gzipSync(HTML)],
  '/forbidden': [403, {}, '<title>Just a moment...</title>'],
  '/big': [200, {}, BIG],
  '/big-declared': [200, { 'content-length': BIG.length }, BIG],
  '/redirect-relative': [301, { location: '/home' }],
  '/redirect-local': [302, { location: 'http://127.0.0.1:{local}/' }],
  '/redirect-private-name': [302, { location: 'http://intranet.example:{local}/' }],
  '/redirect-file': [302, { location: 'file:///etc/passwd' }],
  '/loop': [302, { location: '/loop' }],
  '/cp1256-header': [200, { 'content-type': 'text/html; charset=windows-1256' }, page1256('')],
  '/cp1256-meta': [200, { 'content-type': 'text/html' }, page1256('<meta charset="windows-1256">')],
  '/unknown-charset': [200, { 'content-type': 'text/html; charset=x-fictional' }, HTML],
  '/unknown-header-cp1256-meta': [
    200,
    { 'content-type': 'text/html; charset=x-fictional' },
    page1256('<meta charset="windows-1256">'),
  ],
  '/utf16-meta': [200, { 'content-type': 'text/html' }, `<meta charset="utf-16">${HTML}`],
};

// The "public" site listens on ::1, which only this spec's rule lets through; 127.0.0.1 stays
// refused, as in production, so a redirect there proves the real rule.
const isAllowedAddress = (ip: string): boolean => ip === '::1' || isPublicAddress(ip);
const DNS: Record<string, string> = { 'clinic.example': '::1', 'intranet.example': '127.0.0.2' };
const lookup = allowedOnlyLookup((hostname) => {
  const address = DNS[hostname];
  if (address === undefined) return Promise.reject(new Error('ENOTFOUND'));
  return Promise.resolve([{ address, family: address.includes(':') ? 6 : 4 }]);
}, isAllowedAddress);

let site: Server;
let local: Server;
let sitePort = '';
let localPort = '';
let localHits = 0;

const listen = async (server: Server, host: string): Promise<string> => {
  server.listen(0, host);
  await once(server, 'listening');
  return String((server.address() as AddressInfo).port);
};

beforeAll(async () => {
  site = createServer((request, response) => {
    if (request.url === '/drip') {
      // Sends the headers, then a little body now and then, never ending it.
      response.writeHead(200);
      const drip = setInterval(() => response.write('<p>'), 20);
      response.on('close', () => {
        clearInterval(drip);
      });
      return;
    }
    // An unknown path never answers, so only the timeout ends that request.
    const [status, headers, body] = ROUTES[request.url ?? ''] ?? [0, {}];
    if (status === 0) return;
    const location = headers.location?.toString().replace('{local}', localPort);
    response.writeHead(status, location === undefined ? headers : { ...headers, location });
    response.end(body);
  });
  local = createServer((_request, response) => {
    localHits += 1;
    response.end('local service');
  });
  sitePort = await listen(site, '::1');
  localPort = await listen(local, '127.0.0.1');
});

afterAll(async () => {
  site.closeAllConnections();
  site.close();
  local.close();
  await Promise.all([once(site, 'close'), once(local, 'close')]);
});

const options = (timeoutMs = 2000) => ({
  userAgent: 'VoxFlowLeadEngine/1.0 (+https://voxflow.agency)',
  timeoutMs,
  maxBytes: MAX_BYTES,
  lookup,
  isAllowedAddress,
});
const siteUrl = (path: string): string => `http://clinic.example:${sitePort}${path}`;
const get = (path: string, timeoutMs?: number) => safeGet(siteUrl(path), options(timeoutMs));

// Proves a page is read only from allowed addresses, redirects included, within time and size.
describe('safeGet', () => {
  it('reads a page and says which URL answered', async () => {
    expect(await get('/home')).toEqual({ url: siteUrl('/home'), status: 200, body: HTML });
  });

  // T-1 audit: a page in another code page must not come back garbled (FR-9, FR-10 read its text).
  it('decodes a page in the charset its header or meta names, else as UTF-8', async () => {
    expect((await get('/cp1256-header')).body).toContain('دكتر');
    expect((await get('/cp1256-meta')).body).toContain('دكتر');
    expect((await get('/unknown-charset')).body).toBe(HTML);
  });

  it('falls back to the meta after an unknown header label, and reads a utf-16 meta as UTF-8', async () => {
    expect((await get('/unknown-header-cp1256-meta')).body).toContain('دكتر');
    expect((await get('/utf16-meta')).body).toBe(`<meta charset="utf-16">${HTML}`);
  });

  it('returns a 403 with its body, so the caller can see a challenge page', async () => {
    expect(await get('/forbidden')).toMatchObject({ status: 403, body: /Just a moment/ });
  });

  it('follows a relative redirect and reports the final URL', async () => {
    expect((await get('/redirect-relative')).url).toBe(siteUrl('/home'));
  });

  it.each([
    ['/redirect-local', 'to 127.0.0.1'],
    ['/redirect-private-name', 'to a name that resolves to a private address'],
  ])('refuses %s, a redirect from a public site %s, without connecting', async (path) => {
    await expect(get(path)).rejects.toThrow('private or reserved address');
    expect(localHits).toBe(0);
  });

  it.each([
    ['/redirect-file', 'only http and https'],
    ['/loop', 'too many redirects'],
    ['/gzip', 'compressed page'],
    ['/big', 'page too large'],
    ['/big-declared', 'page too large'],
  ])('refuses %s: %s', async (path, reason) => {
    await expect(get(path)).rejects.toThrow(reason);
  });

  it.each(['127.0.0.1', '[::ffff:127.0.0.1]', '2130706433', '0x7f.1', 'intranet.example'])(
    'refuses the host %s before any connection',
    async (host) => {
      const url = `http://${host}:${localPort}/`;

      await expect(safeGet(url, options())).rejects.toThrow(ReadRefusedError);
      expect(localHits).toBe(0);
    },
  );

  it.each(['ftp://clinic.example/', 'not a url'])('refuses %s', async (url) => {
    await expect(safeGet(url, options())).rejects.toThrow('only http and https');
  });

  it('gives up after the timeout', async () => {
    await expect(get('/never-answers', 200)).rejects.toMatchObject({ name: 'AbortError' });
  });

  // A reset would be retried with a fresh time limit; a timeout must not be.
  it('reports a body still arriving at the timeout as a timeout, not a reset', async () => {
    await expect(get('/drip', 200)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
