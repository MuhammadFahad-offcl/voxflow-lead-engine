/**
 * Adapter tests of the fake web reader on the six fictional fixture sites.
 *
 * Serves: ADR-0004, ADR-0007, FR-9, FR-36; issue #11 acceptance ("all 6 fixture sites produce the
 * expected status").
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { FakeWebReaderAdapter } from './fake.adapter.js';

const reader = new FakeWebReaderAdapter();

// Proves each fixture site ends in the tier ADR-0004 gives it, with the pages it should have.
describe('FakeWebReaderAdapter', () => {
  it.each([
    ['p01', 'booking widget; no contact page', 'READ_FETCH', ['/']],
    ['p03', 'WhatsApp float button', 'READ_FETCH', ['/']],
    ['p06', 'three doctors', 'READ_FETCH', ['/']],
    ['p07', 'JavaScript-only page', 'READ_LIGHTPANDA', ['/']],
    ['p08', 'bot challenge', 'UNREADABLE', []],
    ['p10', 'contact page with email', 'READ_FETCH', ['/', '/contact-us/']],
    ['p99', 'no fixture, like a missing site', 'UNREADABLE', []],
  ])('reads %s (%s) as %s, with pages %j', async (name, _what, status, paths) => {
    const read = await reader.read(`https://${name}.example.com`);

    expect(read.status).toBe(status);
    expect(read.pages.map(({ url }) => new URL(url).pathname)).toEqual(paths);
  });

  it('says why a site is unreadable', async () => {
    expect(await reader.read('https://p08.example.com')).toMatchObject({
      reason: 'blocked by a bot challenge',
    });
  });
});
