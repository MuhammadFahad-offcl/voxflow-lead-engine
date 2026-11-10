/**
 * Unit tests of the shared reading rules, on in-memory transports.
 *
 * Serves: FR-9, ADR-0004; issue #11 (robots.txt, tiers, challenge pages, one contact page).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { ReadRefusedError } from './public-address.js';
import { readSite, type SiteTransport } from './read-site.js';

const HOME = 'https://clinic.example/';
const TEXT = 'Fictional clinic text. '.repeat(10);
const page = (body: string, links = ''): string =>
  `<html><head><style>p{}</style></head><body>${links}<p>${body}</p></body></html>`;

// Answers GETs from a table (404 otherwise), as if redirected when an entry names the URL that
// answered, and records what was fetched and rendered.
const transport = (
  pages: Record<string, [number, string, string?]>,
  render: SiteTransport['render'] = (url) => Promise.reject(new Error(url)),
): SiteTransport & { fetched: string[]; rendered: string[] } => {
  const fetched: string[] = [];
  const rendered: string[] = [];
  return {
    fetched,
    rendered,
    get: (url) => {
      fetched.push(url);
      const [status, body, answered = url] = pages[url] ?? [404, ''];
      return Promise.resolve({ url: answered, status, body });
    },
    render: (url) => {
      rendered.push(url);
      return render(url);
    },
  };
};
const failing = (error: Error): SiteTransport => ({
  get: () => Promise.reject(error),
  render: () => Promise.reject(error),
});

// Proves robots.txt, the tiers and the error reasons follow ADR-0004.
describe('readSite', () => {
  it.each([
    ['User-agent: *\nDisallow: /', 200, 'robots.txt disallows the homepage'],
    ['User-agent: VoxFlowLeadEngine\nDisallow: /', 200, 'robots.txt disallows the homepage'],
    ['', 503, 'robots.txt is unavailable'],
  ])('respects robots.txt %j (HTTP %i)', async (robots, status, reason) => {
    const sites = transport({ [`${HOME}robots.txt`]: [status, robots], [HOME]: [200, page(TEXT)] });

    expect(await readSite(HOME, sites)).toEqual({ status: 'UNREADABLE', pages: [], reason });
  });

  it.each([
    [403, page(TEXT), 'blocked (HTTP 403)'],
    [500, page(TEXT), 'HTTP 500'],
    [200, '<title>Attention Required! | Cloudflare</title>', 'blocked by a bot challenge'],
  ])('marks HTTP %i with %j unreadable', async (status, body, reason) => {
    expect(await readSite(HOME, transport({ [HOME]: [status, body] }))).toMatchObject({ reason });
  });

  // Cloudflare puts this script on ordinary pages too; near-empty, so checked, then rendered.
  it('renders a near-empty page that carries the Cloudflare challenge-platform script', async () => {
    const script = '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>';
    const sites = transport({ [HOME]: [200, `<div id="root"></div>${script}`] }, (url) =>
      Promise.resolve({ url, html: page(TEXT) }),
    );

    expect((await readSite(HOME, sites)).status).toBe('READ_LIGHTPANDA');
  });

  // Minified HTML has no whitespace between blocks; indented HTML has line breaks inside them.
  it('gives each block its own line, and joins inline elements and wrapped lines', async () => {
    const html = `<ul><li>Braces</li><li>Whitening</li></ul><p>info@clinic.pk</p><p>Call <b>us</b></p><h3>Dr. Ayesha\n  Khan</h3><p>${TEXT}</p>`;

    const [home] = (await readSite(HOME, transport({ [HOME]: [200, html] }))).pages;

    expect(home?.text).toMatch(/^Braces\nWhitening\ninfo@clinic\.pk\nCall us\nDr\. Ayesha Khan\nF/);
  });

  it.each([
    [Object.assign(new Error('x'), { name: 'AbortError' }), 'the site timed out'],
    [new ReadRefusedError('refused'), 'refused'],
    [new Error('ECONNRESET'), 'the site could not be read'],
  ])('turns %s into a fixed reason', async (error, reason) => {
    expect(await readSite(HOME, failing(error))).toMatchObject({ status: 'UNREADABLE', reason });
  });

  it('renders with Lightpanda only URLs a checked GET reached, contact page included', async () => {
    const contact = `${HOME}contact`;
    const sites = transport(
      { [HOME]: [200, page('Loading')], [contact]: [200, page('Loading')] },
      (url) => Promise.resolve({ url, html: page(TEXT, '<a href="/contact">Contact</a>') }),
    );

    const read = await readSite(HOME, sites);

    expect(read.status).toBe('READ_LIGHTPANDA');
    expect(sites.rendered).toEqual([HOME, contact]);
    expect(sites.fetched).toEqual([`${HOME}robots.txt`, HOME, contact]);
  });

  it.each([
    [() => Promise.reject(new Error('crash')), 'Lightpanda could not render the page'],
    [(url: string) => Promise.resolve({ url, html: page('Hi') }), 'too little text'],
  ])('marks the site unreadable when Lightpanda cannot help (%#)', async (render, reason) => {
    const sites = transport({ [HOME]: [200, page('Loading')] }, render);

    expect(await readSite(HOME, sites)).toMatchObject({ reason: expect.stringContaining(reason) });
  });

  it('reads the first same-site contact link, skipping other sites and mailto', async () => {
    const links =
      '<a href="https://calendly.com/x/appointment">Book</a><a href="mailto:a@clinic.example">Contact</a>' +
      '<a href="https://www.clinic.example/contact#form">Contact us</a><a href="/appointment">Book</a>';
    const contact = 'https://www.clinic.example/contact';
    const sites = transport({ [HOME]: [200, page(TEXT, links)], [contact]: [200, page('Email')] });

    const read = await readSite(HOME, sites);

    expect(read.pages.map(({ url }) => url)).toEqual([HOME, contact]);
    // The contact page is on another origin, so its own robots.txt decides, not the apex one.
    expect(sites.fetched).toContain('https://www.clinic.example/robots.txt');
  });

  it("skips a contact page on another origin that that origin's robots.txt disallows", async () => {
    const sites = transport({
      [HOME]: [200, page(TEXT, '<a href="https://www.clinic.example/contact">Contact</a>')],
      'https://www.clinic.example/robots.txt': [200, 'User-agent: *\nDisallow: /contact'],
      'https://www.clinic.example/contact': [200, page('Email')],
    });

    const read = await readSite(HOME, sites);

    expect(read.pages.map(({ url }) => url)).toEqual([HOME]);
    expect(sites.fetched).not.toContain('https://www.clinic.example/contact');
  });

  it('keeps a homepage only when the robots.txt of the origin it redirected to allows it', async () => {
    const start = 'http://clinic.example/';
    const sites = transport({
      [start]: [200, page(TEXT), HOME],
      [`${HOME}robots.txt`]: [200, 'User-agent: *\nDisallow: /'],
    });

    expect(await readSite(start, sites)).toMatchObject({
      status: 'UNREADABLE',
      reason: 'robots.txt disallows the homepage',
    });
  });

  it('skips a contact page robots.txt disallows', async () => {
    const sites = transport({
      [`${HOME}robots.txt`]: [200, 'User-agent: *\nDisallow: /contact'],
      [HOME]: [200, page(TEXT, '<a href="/contact">Contact</a>')],
      [`${HOME}contact`]: [200, page('Email')],
    });

    expect((await readSite(HOME, sites)).pages).toHaveLength(1);
  });
});
