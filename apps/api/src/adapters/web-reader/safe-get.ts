/**
 * One HTTP GET that only connects to allowed addresses, checks every redirect and stops at a size
 * limit.
 *
 * Serves: FR-9, ADR-0004, ADR-0003 (nothing scraped may reach the laptop's local services); #11.
 * Used by: apps/api/src/adapters/web-reader/http.adapter.ts; read-site.ts uses its response type.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { ReadRefusedError } from './public-address.js';

/** How {@link safeGet} connects and when it gives up. */
export interface SafeGetOptions {
  userAgent: string;
  /** For the whole GET, redirects and body included, in milliseconds. */
  timeoutMs: number;
  /** Largest body accepted, in bytes. */
  maxBytes: number;
  /** Resolves names and refuses private addresses: `allowedOnlyLookup`. */
  lookup: LookupFunction;
  /** The address rule for IP literals, which never reach `lookup`. */
  isAllowedAddress: (ip: string) => boolean;
}

/** The final response of a GET: the URL that answered after redirects, and its body as text. */
export interface SafeResponse {
  url: string;
  status: number;
  body: string;
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Names are checked when they are resolved, by the lookup; IP literals have to be checked here.
const checkUrl = (url: URL | null, isAllowedAddress: (ip: string) => boolean): URL => {
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') {
    throw new ReadRefusedError('only http and https URLs are read');
  }
  // The URL parser has already turned forms like 2130706433 or 0x7f.1 into dotted IPv4.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0 && !isAllowedAddress(host)) {
    throw new ReadRefusedError('the URL points to a private or reserved address');
  }
  return url;
};

const send = (url: URL, options: SafeGetOptions, signal: AbortSignal): Promise<IncomingMessage> =>
  new Promise((resolve, reject) => {
    // Uncompressed, so the size limit counts what is held in memory.
    const headers = { 'user-agent': options.userAgent, 'accept-encoding': 'identity' };
    // No pooled socket (agent: false): a kept-alive connection would outlive this read's checks.
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      { agent: false, lookup: options.lookup, signal, headers },
      resolve,
    );
    request.on('error', reject);
    request.end();
  });

const readBody = async (
  response: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> => {
  const refuse = (reason: string): ReadRefusedError => {
    response.destroy();
    return new ReadRefusedError(reason);
  };
  const encoding = response.headers['content-encoding'] ?? 'identity';
  if (encoding !== 'identity') throw refuse('the site sent a compressed page');
  if (Number(response.headers['content-length'] ?? 0) > maxBytes) throw refuse('page too large');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBytes) throw refuse('page too large');
      chunks.push(chunk);
    }
  } catch (error) {
    // A timeout mid-body surfaces as a reset ("aborted"), which a caller would retry with a fresh
    // time limit; say what it was instead.
    if (signal.aborted) throw new DOMException('the site timed out', 'AbortError');
    throw error;
  }
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * GETs a URL, following up to 5 redirects, each checked like the first URL.
 *
 * Every connection goes through `options.lookup`, so the address checked is the one connected to.
 * Does not judge the status: a 403 or 404 comes back like a 200, with its body, so the caller can
 * tell a challenge page from a missing page.
 * Does not use a proxy, cookies or a connection pool; reads UTF-8 and uncompressed bodies only.
 * Does not cover what a browser loading the same page would fetch: only this one GET.
 * @param rawUrl - Absolute http or https URL.
 * @param options - User agent, limits and the address checks.
 * @returns The final URL, status and body.
 * @throws ReadRefusedError for a refused URL, address, redirect, encoding or size; an AbortError
 * after `timeoutMs`, also when the body was still arriving; network errors such as ECONNRESET as
 * Node raises them.
 */
export async function safeGet(rawUrl: string, options: SafeGetOptions): Promise<SafeResponse> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  let url = checkUrl(URL.parse(rawUrl), options.isAllowedAddress);
  for (let hop = 0; ; hop += 1) {
    const response = await send(url, options, signal);
    const status = response.statusCode ?? 0;
    const { location } = response.headers;
    if (!REDIRECT_STATUSES.has(status) || location === undefined) {
      return { url: url.href, status, body: await readBody(response, options.maxBytes, signal) };
    }
    response.destroy();
    if (hop === MAX_REDIRECTS) throw new ReadRefusedError('too many redirects');
    url = checkUrl(URL.parse(location, url), options.isAllowedAddress);
  }
}
