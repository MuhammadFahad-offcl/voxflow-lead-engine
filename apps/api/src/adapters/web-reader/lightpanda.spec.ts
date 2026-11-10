/**
 * Adapter tests of the Lightpanda render with a stand-in browser, so CI needs no Docker.
 *
 * Serves: FR-9, ADR-0004, ADR-0003; issue #11 (Lightpanda only loads allowed addresses).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it, jest } from '@jest/globals';
import type { Browser, ConnectOptions, HTTPRequest } from 'puppeteer-core';
import { renderWithLightpanda } from './lightpanda.js';
import { ReadRefusedError } from './public-address.js';

const HOME = 'https://clinic.example/';
const USER_AGENT = 'VoxFlowLeadEngine/1.0 (+https://voxflow.agency)';
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

interface StandInOptions {
  /** What the page "loads": each URL is put to the interceptor in turn. */
  requests?: string[];
  html?: string;
  /** Where the page ends, after any redirect. */
  finalUrl?: string;
  /** A page whose HTML never arrives, as when Lightpanda hangs. */
  hangs?: boolean;
}

// A browser whose page "loads" by asking the interceptor about each URL in `requests`.
const standIn = ({ requests = [HOME], html = '<p>Hi</p>', finalUrl, hangs }: StandInOptions) => {
  const decisions: Record<string, string> = {};
  const userAgents: string[] = [];
  let onRequest: ((request: HTTPRequest) => void) | undefined;
  const decide = (url: string, decision: string) => () => {
    decisions[url] = decision;
    return Promise.resolve();
  };
  const request = (url: string) =>
    ({
      url: () => url,
      continue: decide(url, 'continue'),
      abort: decide(url, 'abort'),
    }) as unknown as HTTPRequest;
  const page = {
    setUserAgent: ({ userAgent }: { userAgent: string }) => {
      userAgents.push(userAgent);
      return Promise.resolve();
    },
    setRequestInterception: () => Promise.resolve(),
    on: (_event: string, handler: (request: HTTPRequest) => void) => {
      onRequest = handler;
    },
    goto: async () => {
      for (const url of requests) onRequest?.(request(url));
      await new Promise((done) => setImmediate(done));
    },
    content: () => (hangs === true ? never<string>() : Promise.resolve(html)),
    url: () => finalUrl ?? requests[0],
  };
  const disconnect = jest.fn(() => Promise.resolve());
  const browser = {
    createBrowserContext: () => Promise.resolve({ newPage: () => Promise.resolve(page) }),
    disconnect,
  } as unknown as Browser;
  const connected: ConnectOptions[] = [];
  const connect = (connectOptions: ConnectOptions) => {
    connected.push(connectOptions);
    return Promise.resolve(browser);
  };
  return { decisions, userAgents, connected, disconnect, connect };
};

const options = (maxChars = 1000, timeoutMs = 1000) => ({
  cdpUrl: 'ws://127.0.0.1:9222',
  userAgent: USER_AGENT,
  timeoutMs,
  maxChars,
  isAllowedUrl: (url: string) => Promise.resolve(url.startsWith(HOME)),
});

// Proves every request Lightpanda makes is checked, and the connection always ends.
describe('renderWithLightpanda', () => {
  it('lets allowed requests through, aborts the rest and returns the rendered page', async () => {
    const browser = standIn({ requests: [HOME, `${HOME}app.js`, 'https://intranet.example/'] });

    const page = await renderWithLightpanda(HOME, options(), browser.connect);

    expect(page).toEqual({ url: HOME, html: '<p>Hi</p>' });
    expect(Object.values(browser.decisions)).toEqual(['continue', 'continue', 'abort']);
    expect(browser.disconnect).toHaveBeenCalled();
  });

  it("sends the reader's user agent, as the plain GET does", async () => {
    const browser = standIn({});

    await renderWithLightpanda(HOME, options(), browser.connect);

    expect(browser.userAgents).toEqual([USER_AGENT]);
  });

  it('refuses a rendered page over the size limit and still disconnects', async () => {
    const browser = standIn({ html: 'x'.repeat(20) });

    const render = renderWithLightpanda(HOME, options(10), browser.connect);

    await expect(render).rejects.toThrow('page too large');
    expect(browser.disconnect).toHaveBeenCalled();
  });

  // The check runs again on the final URL in case a request slipped past interception.
  it('refuses a render that ended on a URL the check does not allow', async () => {
    const browser = standIn({ finalUrl: 'https://intranet.example/' });

    const render = renderWithLightpanda(HOME, options(), browser.connect);

    await expect(render).rejects.toThrow(ReadRefusedError);
    expect(browser.disconnect).toHaveBeenCalled();
  });

  it('gives every CDP call the time limit and gives up on the whole render after it', async () => {
    const browser = standIn({ hangs: true });

    const render = renderWithLightpanda(HOME, options(1000, 50), browser.connect);

    await expect(render).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(browser.connected[0]?.protocolTimeout).toBe(50);
    expect(browser.disconnect).toHaveBeenCalled();
  });

  it('gives up when Lightpanda never accepts the connection', async () => {
    const render = renderWithLightpanda(HOME, options(1000, 50), never);

    await expect(render).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
