/**
 * The real web reader: checked plain GETs with retries, Lightpanda for JavaScript pages, and one
 * read at a time per domain.
 *
 * Serves: FR-9, ADR-0004, ADR-0007, ADR-0003; issue #11.
 * Used by: apps/api/src/bootstrap.ts, through `bindAdapter`, when DEMO_MODE=false;
 * apps/api/src/read-website.ts.
 */
import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable } from '@hazeljs/core';
import { ENV, type Env } from '../../config/env.js';
import type { WebReaderPort, WebsiteRead } from '../../ports/web-reader.port.js';
import { renderWithLightpanda } from './lightpanda.js';
import {
  allowedOnlyLookup,
  isPublicAddress,
  resolveWithSystem,
  type ResolveHost,
} from './public-address.js';
import { readSite, USER_AGENT, type SiteTransport } from './read-site.js';
import { safeGet, type SafeResponse } from './safe-get.js';

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
// The same budget for a rendered page, which Lightpanda hands over as a string: counted in
// characters, about one byte each on a mostly-ASCII page.
const MAX_HTML_CHARS = 2 * 1024 * 1024;
const RETRIES = 3;
// Errors where the network, not the site, failed; a timeout or a refusal is not retried.
const NETWORK_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ETIMEDOUT']);
// Not `instanceof Error`: Node's own errors can come from another realm, as under Jest.
const isNetworkError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  NETWORK_ERRORS.has(String(error.code));

/** Reads live websites. */
@Injectable()
export class HttpWebReaderAdapter implements WebReaderPort {
  /** Resolves names; a spec swaps in a fixed table so no test needs DNS. */
  protected readonly resolveHost: ResolveHost = resolveWithSystem;
  /** The address rule; a spec also allows its stub server's loopback address. */
  protected readonly isAllowedAddress: (ip: string) => boolean = isPublicAddress;
  /** First wait before a retry, in milliseconds; doubled each time. */
  protected readonly retryDelayMs: number = 500;
  private readonly cdpUrl: string;
  // The read in progress per domain; the next read of that domain waits for it.
  private readonly reading = new Map<string, Promise<WebsiteRead>>();

  /**
   * Wires the adapter to Lightpanda.
   * @param env - Parsed configuration; only LIGHTPANDA_CDP_URL is read.
   */
  constructor(@Inject(ENV) env: Pick<Env, 'LIGHTPANDA_CDP_URL'>) {
    this.cdpUrl = env.LIGHTPANDA_CDP_URL;
  }

  /**
   * Reads a site; a second read of the same domain starts when the first has ended, so one request
   * per domain is in flight at a time.
   * Does not hold the lock across processes, for a domain a redirect leads to, or over the scripts
   * Lightpanda loads in parallel while it renders.
   * @inheritDoc
   */
  async read(url: string): Promise<WebsiteRead> {
    const domain = (URL.parse(url)?.hostname ?? url).replace(/^www\./, '');
    const before = this.reading.get(domain) ?? Promise.resolve(null);
    // readSite never rejects, so the chain cannot break.
    const current = before.then(() => readSite(url, this.transport()));
    this.reading.set(domain, current);
    const result = await current;
    if (this.reading.get(domain) === current) this.reading.delete(domain);
    return result;
  }

  /**
   * Tells whether a URL may be requested: http or https, and every address of its host allowed.
   * @param raw - The URL Lightpanda wants to load.
   * @returns False for other schemes, refused addresses and names that do not resolve.
   */
  protected async isAllowedUrl(raw: string): Promise<boolean> {
    const url = URL.parse(raw);
    if (url?.protocol !== 'http:' && url?.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0) return this.isAllowedAddress(host);
    const addresses = await this.resolveHost(host).catch(() => []);
    return addresses.length > 0 && addresses.every(({ address }) => this.isAllowedAddress(address));
  }

  private transport(): SiteTransport {
    const options = {
      userAgent: USER_AGENT,
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      lookup: allowedOnlyLookup(this.resolveHost, this.isAllowedAddress),
      isAllowedAddress: this.isAllowedAddress,
    };
    return {
      get: (url) => this.withRetries(() => safeGet(url, options)),
      render: (url) =>
        renderWithLightpanda(url, {
          cdpUrl: this.cdpUrl,
          userAgent: USER_AGENT,
          timeoutMs: TIMEOUT_MS,
          maxChars: MAX_HTML_CHARS,
          isAllowedUrl: (next) => this.isAllowedUrl(next),
        }),
    };
  }

  private async withRetries(get: () => Promise<SafeResponse>): Promise<SafeResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await get();
      } catch (error) {
        if (attempt === RETRIES || !isNetworkError(error)) throw error;
        await sleep(this.retryDelayMs * 2 ** attempt);
      }
    }
  }
}
