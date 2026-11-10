/**
 * Renders one page in Lightpanda over CDP, letting through only requests to allowed addresses.
 *
 * Serves: FR-9, ADR-0004 (tier 2), ADR-0003; issue #11.
 * Used by: apps/api/src/adapters/web-reader/http.adapter.ts.
 */
import puppeteer, { type Browser, type ConnectOptions } from 'puppeteer-core';
import { ReadRefusedError } from './public-address.js';

/** What a render needs. */
export interface RenderOptions {
  /** Lightpanda's CDP WebSocket, from LIGHTPANDA_CDP_URL. */
  cdpUrl: string;
  /** Sent with every request the page makes, as the plain GET sends it. */
  userAgent: string;
  /** For the whole render, connecting included, and for each CDP call, in milliseconds. */
  timeoutMs: number;
  /** Largest rendered HTML accepted, in characters. */
  maxChars: number;
  /** Decides each request Lightpanda wants to make: the page, its redirects, scripts, XHR. */
  isAllowedUrl: (url: string) => Promise<boolean>;
}

// Rejects with the signal's TimeoutError once it fires. A race subscribes to it, so a rejection
// after the race has settled is still handled.
const timedOut = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

const renderPage = async (browser: Browser, url: string, options: RenderOptions) => {
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setUserAgent({ userAgent: options.userAgent });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    void options
      .isAllowedUrl(request.url())
      .then((allowed) => (allowed ? request.continue() : request.abort()))
      // The page may close while a check is still running; nothing is left to decide then.
      .catch(() => undefined);
  });
  await page.goto(url, { waitUntil: 'load', timeout: options.timeoutMs });
  const html = await page.content();
  if (html.length > options.maxChars) throw new ReadRefusedError('page too large');
  // A second look at where the page ended, in case a request got past the interception.
  if (!(await options.isAllowedUrl(page.url()))) {
    throw new ReadRefusedError('the page ended on a private or reserved address');
  }
  return { url: page.url(), html };
};

/**
 * Loads a URL in a fresh Lightpanda context and returns the HTML after scripts ran.
 *
 * Every request Lightpanda makes over CDP is intercepted and checked with `isAllowedUrl` when it
 * is requested, and aborted when refused; the URL the page ended on is checked again. The address
 * is checked, not pinned: Lightpanda resolves the name again itself, inside its Docker container,
 * so a name that changes its answer between the two (DNS rebinding) can still reach a private
 * address. On Docker Desktop that includes `host.docker.internal`, which reaches the laptop's
 * 127.0.0.1 services such as the API on :4000 and the dashboard on :3000, and Lightpanda's own CDP
 * port on the container's loopback. The interception has been shown to work against a stand-in
 * browser in the tests and in one local manual check on real Lightpanda, no more.
 * Does not see requests Lightpanda makes outside CDP interception, if any.
 * Does not retry: Lightpanda is beta (ADR-0004), and a failed render means unreadable.
 * @param url - A URL the checked GET already reached.
 * @param options - CDP address, user agent, limits and the request check.
 * @param connect - Puppeteer's connect; tests pass a stand-in.
 * @returns The URL Lightpanda ended on and the rendered HTML.
 * @throws ReadRefusedError when the HTML is too large or the page ended on a refused URL; a
 * TimeoutError after `timeoutMs`; puppeteer errors for a failed connection or navigation.
 */
export async function renderWithLightpanda(
  url: string,
  options: RenderOptions,
  connect: (connectOptions: ConnectOptions) => Promise<Browser> = (connectOptions) =>
    puppeteer.connect(connectOptions),
): Promise<{ url: string; html: string }> {
  // One time limit for everything; protocolTimeout also stops a single CDP call hanging longer.
  const timeout = timedOut(AbortSignal.timeout(options.timeoutMs));
  const connecting = connect({
    browserWSEndpoint: options.cdpUrl,
    protocolTimeout: options.timeoutMs,
  });
  const browser = await Promise.race([connecting, timeout]).catch((error: unknown) => {
    // A connection that only opens after the time limit is closed straight away.
    void connecting.then((late) => late.disconnect()).catch(() => undefined);
    throw error;
  });
  // Disconnecting ends the CDP session, and Lightpanda drops the context and page with it.
  try {
    return await Promise.race([renderPage(browser, url, options), timeout]);
  } finally {
    await browser.disconnect();
  }
}
