/**
 * The reading rules both web reader adapters share: robots.txt, tiers, challenge pages and the
 * one contact page. Each adapter brings its own way of getting a page.
 *
 * Serves: FR-9, ADR-0004; issue #11.
 * Used by: only its spec so far, apps/api/src/adapters/web-reader/read-site.spec.ts.
 */
import { load } from 'cheerio';
import robotsTypes from 'robots-parser';
import type { WebPage, WebsiteRead } from '../../ports/web-reader.port.js';
import { ReadRefusedError } from './public-address.js';
import type { SafeResponse } from './safe-get.js';

/** How an adapter gets pages: a plain GET, and a JavaScript render by Lightpanda. */
export interface SiteTransport {
  /**
   * A plain GET, redirects followed; a 403 or 404 is a response, not an error.
   * @param url - Absolute URL.
   * @returns The final URL, status and body.
   */
  get(url: string): Promise<SafeResponse>;
  /**
   * Renders a URL that `get` already reached.
   * @param url - Absolute URL.
   * @returns The URL the render ended on and the HTML after scripts ran.
   */
  render(url: string): Promise<{ url: string; html: string }>;
}

/** Sent on every request, and the name robots.txt rules are matched against. */
const USER_AGENT = 'VoxFlowLeadEngine/1.0 (+https://voxflow.agency)';
// ADR-0004: below this much visible text the page probably needs JavaScript.
const MIN_TEXT_CHARS = 200;
const CONTACT_LINK = /contact|رابطہ|appointment/i;
// Bot walls (Cloudflare, Incapsula, DDoS-Guard, Sucuri). Not "captcha": contact forms carry one.
// Not Cloudflare's "challenge-platform" script either: it also sits on ordinary pages.
const CHALLENGE =
  /cf-chl|<title>\s*(?:just a moment|attention required)|checking your browser before accessing|_incapsula_resource|ddos-guard|sucuri_cloudproxy/i;
// The statuses bot walls answer with; on a 200 only a near-empty page can be one.
const CHALLENGE_STATUSES = new Set([403, 429, 503]);

// The package is CommonJS and exports the function itself, but its types declare a default export.
const robotsParser = robotsTypes as unknown as typeof robotsTypes.default;
type Robots = ReturnType<typeof robotsParser>;

/** Thrown inside a read to end it as UNREADABLE with this reason. */
class Unreadable extends Error {}

/** Tells whether robots.txt lets the reader request a URL. */
type MayRead = (url: string) => Promise<boolean>;

// Elements a browser sets on their own line. Minified HTML has no whitespace between them, and a
// name must not run into the next block, so each gets its own line; inline ones (a, b) stay joined.
const BLOCKS =
  'address,article,aside,blockquote,br,button,dd,div,dl,dt,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,option,p,section,table,td,th,tr,ul';
// U+2029, the paragraph separator, marks a block's edge; one written in the page ends a line too.
const EDGE = '\u2029';

// What a visitor sees, one line per block: body text without scripts, styles or templates.
function visibleText(html: string): string {
  const $ = load(html);
  $('script, style, noscript, template, svg').remove();
  $(BLOCKS).before(EDGE).after(EDGE);
  return $('body')
    .text()
    .split(EDGE)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const siteOf = (url: URL): string => url.hostname.replace(/^www\./, '');

const checkPage = (status: number, page: WebPage): void => {
  const mayBeChallenge = CHALLENGE_STATUSES.has(status) || page.text.length < MIN_TEXT_CHARS;
  if (mayBeChallenge && CHALLENGE.test(page.html)) {
    throw new Unreadable('blocked by a bot challenge');
  }
  if (status === 403 || status === 429) throw new Unreadable(`blocked (HTTP ${String(status)})`);
  if (status < 200 || status > 299) throw new Unreadable(`HTTP ${String(status)}`);
};

// RFC 9309: a missing robots.txt allows everything; an unreachable one disallows everything.
const robotsRules = async (origin: string, transport: SiteTransport): Promise<Robots> => {
  const robotsUrl = `${origin}/robots.txt`;
  const { status, body } = await transport.get(robotsUrl);
  if (status >= 500) throw new Unreadable('robots.txt is unavailable');
  return robotsParser(robotsUrl, status >= 200 && status < 300 ? body : '');
};

// Each origin has its own robots.txt, loaded once per read. robots-parser answers undefined for a
// URL outside the file's origin, so only a clear yes allows.
const robotsByOrigin = (transport: SiteTransport): MayRead => {
  const loaded = new Map<string, Promise<Robots>>();
  return async (url) => {
    const { origin } = new URL(url);
    const robots = loaded.get(origin) ?? robotsRules(origin, transport);
    loaded.set(origin, robots);
    return (await robots).isAllowed(url, USER_AGENT) === true;
  };
};

const findContactUrl = (home: WebPage): string | null => {
  const $ = load(home.html);
  const homeUrl = new URL(home.url);
  for (const link of $('a[href]').toArray()) {
    const href = $(link).attr('href') ?? '';
    if (!CONTACT_LINK.test(href) && !CONTACT_LINK.test($(link).text())) continue;
    const url = URL.parse(href, homeUrl);
    if (url === null || !url.protocol.startsWith('http') || siteOf(url) !== siteOf(homeUrl)) {
      continue;
    }
    url.hash = '';
    if (url.href !== homeUrl.href) return url.href;
  }
  return null;
};

// robots.txt is checked for the URL asked for and again for the URL that answered: a redirect can
// move to another origin, with its own robots.txt.
const fetched = async (
  url: string,
  transport: SiteTransport,
  mayRead: MayRead,
  what: string,
): Promise<WebPage> => {
  if (!(await mayRead(url))) throw new Unreadable(`robots.txt disallows the ${what}`);
  const response = await transport.get(url);
  if (!(await mayRead(response.url))) throw new Unreadable(`robots.txt disallows the ${what}`);
  const page = { url: response.url, html: response.body, text: visibleText(response.body) };
  checkPage(response.status, page);
  return page;
};

const rendered = async (url: string, transport: SiteTransport): Promise<WebPage> => {
  let page;
  try {
    page = await transport.render(url);
  } catch (error) {
    if (error instanceof ReadRefusedError) throw error;
    // Lightpanda is beta (ADR-0004): any failure of its own just means unreadable.
    throw new Unreadable('Lightpanda could not render the page');
  }
  const read = { ...page, text: visibleText(page.html) };
  checkPage(200, read);
  return read;
};

const readContactPage = async (
  home: WebPage,
  read: (url: string) => Promise<WebPage>,
): Promise<WebPage[]> => {
  const url = findContactUrl(home);
  if (url === null) return [];
  try {
    return [await read(url)];
  } catch {
    // The homepage was read; a contact page that fails or robots.txt disallows only means less to
    // extract.
    return [];
  }
};

const readTiers = async (url: string, transport: SiteTransport): Promise<WebsiteRead> => {
  const mayRead = robotsByOrigin(transport);
  const fetchedHome = await fetched(url, transport, mayRead, 'homepage');
  const lightpanda = fetchedHome.text.length < MIN_TEXT_CHARS;
  // Lightpanda only ever loads a URL the checked GET has already reached: the one that answered.
  const home = lightpanda ? await rendered(fetchedHome.url, transport) : fetchedHome;
  if (home.text.length < MIN_TEXT_CHARS) {
    throw new Unreadable('too little text, even with JavaScript');
  }
  const contact = await readContactPage(home, async (next) => {
    const page = await fetched(next, transport, mayRead, 'contact page');
    return lightpanda ? rendered(page.url, transport) : page;
  });
  return { status: lightpanda ? 'READ_LIGHTPANDA' : 'READ_FETCH', pages: [home, ...contact] };
};

// Fixed words only: the error itself may quote the page or the address.
const reasonOf = (error: unknown): string => {
  if (error instanceof Unreadable || error instanceof ReadRefusedError) return error.message;
  // By name: Node's own errors can come from another realm, as under Jest.
  if ((error as { name?: unknown } | null)?.name === 'AbortError') return 'the site timed out';
  return 'the site could not be read';
};

/**
 * Reads a site in tiers: robots.txt, plain GET, Lightpanda when the page shows under 200
 * characters of text, then the one contact page with the tier that worked; in the Lightpanda tier
 * the contact page gets a checked GET first and Lightpanda renders the URL that answered.
 * robots.txt is loaded for each origin the read reaches and checked for every URL asked for and
 * every URL a GET ended on; a page is only taken for a bot wall when its status is 403, 429 or 503
 * or it shows under 200 characters of text.
 *
 * Does not throw: a refusal, a bot challenge, a 403, a timeout or any other error ends the read
 * as UNREADABLE with a fixed reason that is safe to log.
 * Does not limit requests per domain: the real adapter does that around the whole read.
 * Does not check robots.txt for the redirect hops inside one GET, or where a render ended.
 * @param url - The homepage URL.
 * @param transport - The adapter's way of getting pages.
 * @returns The pages and the tier, or UNREADABLE with a reason.
 */
export async function readSite(url: string, transport: SiteTransport): Promise<WebsiteRead> {
  try {
    return await readTiers(url, transport);
  } catch (error) {
    return { status: 'UNREADABLE', pages: [], reason: reasonOf(error) };
  }
}
