/**
 * Entry point of `pnpm read-website <url>`: the founder's manual check of the real web reader on
 * one live site. Not part of the app.
 *
 * Serves: FR-9, FR-10, ADR-0004; issue #11 (CI only ever reads fictional fixtures).
 * Used by: the root package.json script `read-website`, which runs it through tsx.
 *
 * Safe to run: it reads only that site's robots.txt (one per origin it reaches, e.g. apex and
 * www), homepage and at most one contact page, with the same address checks as the app; it writes
 * nothing, not even to the database, and reads no .env, only LIGHTPANDA_CDP_URL from the shell.
 * Lightpanda is only needed for a JavaScript site: `docker compose up -d lightpanda`.
 * It prints the status, the pages read and what it found as counts or widget hosts, never page
 * text, emails, phone numbers or names, so its output is safe to paste into an issue.
 *
 * Before trusting a JavaScript site's result, and after every Lightpanda image update, confirm on
 * the real Lightpanda that its interception refuses a redirect. This renders a public redirect to
 * example.com with a check that refuses example.com:
 *
 *   pnpm exec tsx -e "import('./apps/api/src/adapters/web-reader/lightpanda.ts').then(({ renderWithLightpanda }) => renderWithLightpanda('https://httpbin.org/redirect-to?url=https://example.com/', { cdpUrl: 'ws://127.0.0.1:9222', userAgent: 'check', timeoutMs: 15000, maxChars: 5e6, isAllowedUrl: async (u) => new URL(u).hostname !== 'example.com' })).then((p) => console.log('NOT refused, ended on', p.url), (e) => console.log('refused:', e.message))"
 *
 * It must print "refused: net::ERR_FAILED at https://httpbin.org/…". "NOT refused" means the
 * interception does not work: report it on #11 and do not rely on the Lightpanda tier. Any other
 * error proves nothing: check that Lightpanda is up and httpbin.org answers, then run it again.
 */
import process from 'node:process';
import { LightpandaCdpUrl } from './config/env.js';
import { HttpWebReaderAdapter } from './adapters/web-reader/http.adapter.js';
import { doctorNames, treatments } from './pipeline/extract/clinic-text.js';
import {
  chatWidgets,
  emails,
  onlineBooking,
  socialLinks,
  whatsappLinks,
} from './pipeline/extract/site-links.js';
import { normalizeUrl } from './pipeline/normalize.js';

const url = normalizeUrl(process.argv[2] ?? '');
if (url === null) {
  process.stderr.write('Give one public website address, e.g. pnpm read-website clinic.pk\n');
  process.exit(2);
}

const rawCdpUrl = process.env['LIGHTPANDA_CDP_URL'];
// As loadEnv does: an empty value counts as unset, so the default applies.
const cdpUrl = LightpandaCdpUrl.safeParse(rawCdpUrl === '' ? undefined : rawCdpUrl);
if (!cdpUrl.success) {
  process.stderr.write('LIGHTPANDA_CDP_URL is not a URL, e.g. ws://127.0.0.1:9222\n');
  process.exit(2);
}

const reader = new HttpWebReaderAdapter({ LIGHTPANDA_CDP_URL: cdpUrl.data });
// A booking or chat URL can carry a doctor's name, so only its host is printed.
const kind = (evidence: string): string => {
  const host = URL.parse(evidence)?.hostname ?? '';
  // "form: Book Appointment" and "WhatsApp widget: …" have no host; their label says enough.
  return host === '' ? (evidence.split(':')[0] ?? evidence) : host;
};
const read = await reader.read(url);
const { pages } = read;
const report = {
  status: read.status,
  reason: read.status === 'UNREADABLE' ? read.reason : null,
  pages: pages.map((page) => ({ url: page.url, visibleTextChars: page.text.length })),
  emails: emails(pages).length,
  whatsappLinks: whatsappLinks(pages).length,
  socialLinks: socialLinks(pages).length,
  booking: onlineBooking(pages).map(kind),
  chat: chatWidgets(pages).map(kind),
  doctors: doctorNames(pages).length,
  treatments: treatments(pages),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
