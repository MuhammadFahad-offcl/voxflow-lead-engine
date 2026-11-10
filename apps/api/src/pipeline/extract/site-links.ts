/**
 * Pure extractors that read a website's links and embeds: emails, WhatsApp links, social
 * profiles, booking widgets and chat widgets. Each returns its evidence: what matched, as found.
 *
 * Serves: FR-10, PRD "Lead scoring model" (no_online_booking, whatsapp_link, active_marketing);
 * issue #11.
 * Used by: apps/api/src/pipeline/enrich.step.ts, apps/api/src/read-website.ts.
 */
import { load, type CheerioAPI } from 'cheerio';
import type { WebPage } from '../../ports/web-reader.port.js';

const BOOKING_HOSTS = ['calendly.com', 'setmore.com', 'oladoc.com', 'marham.pk', 'sehat.com.pk'];
const BOOKING_FORM = /book(?:ing)?\s+(?:an\s+)?appointment|request\s+(?:an\s+)?appointment/i;
const CHAT_SCRIPTS = /tawk\.to|crisp\.chat|intercom/i;
// Class or id names that WhatsApp chat plugins give their floating button.
const WHATSAPP_WIDGET =
  /whatsapp[-_]?(?:float|widget|chat|button)|joinchat|ht-ctc|wa-(?:float|widget)/i;
const SOCIAL_HOSTS = [
  'facebook.com',
  'fb.com',
  'instagram.com',
  'tiktok.com',
  'youtube.com',
  'youtu.be',
  'linkedin.com',
];
// Share buttons link to the network, not to the clinic's profile.
const SHARE_PATH = /^\/(?:sharer|share|sharing|intent|shareArticle)/i;
// Text is split into words and each word checked whole, so no pattern scans a long run twice.
const WORD_BREAK = /[\s,;:<>()"'[\]]+/;
const LOCAL_PART = /^[\w.%+-]+$/;
const DOMAIN = /^[a-z\d.-]+$/i;
const ENDS_IN_TLD = /\.[a-z]{2,}$/i;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|svg|webp)$/i;

const unique = (values: string[]): string[] => [...new Set(values)];

const isEmail = (word: string): boolean => {
  const [local = '', domain = '', ...rest] = word.split('@');
  // "logo@2x.png" looks like an address but is an image name.
  return (
    rest.length === 0 &&
    LOCAL_PART.test(local) &&
    DOMAIN.test(domain) &&
    ENDS_IN_TLD.test(domain) &&
    !IMAGE_FILE.test(domain)
  );
};

const isOn = (url: URL, hosts: readonly string[]): boolean =>
  hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));

// Every URL in these attributes, made absolute against the page it was found on.
const urlsIn = (pages: WebPage[], attributes: [selector: string, attribute: string][]): URL[] =>
  pages.flatMap((page) => {
    const $ = load(page.html);
    return attributes.flatMap(([selector, attribute]) =>
      $(selector)
        .toArray()
        .flatMap((element) => URL.parse($(element).attr(attribute) ?? '', page.url) ?? []),
    );
  });

// A broken percent escape ("%E0%A4") makes decodeURIComponent throw; that link is skipped.
const decoded = (text: string): string[] => {
  try {
    return [decodeURIComponent(text)];
  } catch {
    return [];
  }
};

const eachPage = <T>(pages: WebPage[], read: ($: CheerioAPI, page: WebPage) => T[]): T[] =>
  pages.flatMap((page) => read(load(page.html), page));

/**
 * Finds email addresses in mailto links and in the visible text.
 *
 * Does not find obfuscated addresses ("info [at] …") or addresses built by scripts.
 * Does not throw for a mailto link it cannot decode: it skips that link.
 * @param pages - The pages read.
 * @returns Each address once, in lower case, in the order found.
 */
export function emails(pages: WebPage[]): string[] {
  const linked = urlsIn(pages, [['a[href^="mailto:" i]', 'href']]).flatMap((url) =>
    decoded(url.pathname),
  );
  const written = pages.flatMap((page) => page.text.split(WORD_BREAK));
  // A sentence can end right after an address.
  const found = [...linked, ...written].map((word) =>
    (word.endsWith('.') ? word.slice(0, -1) : word).toLowerCase(),
  );
  return unique(found.filter(isEmail));
}

/**
 * Finds links that open a WhatsApp chat: wa.me and api.whatsapp.com.
 * @param pages - The pages read.
 * @returns Each link once, as the page wrote it, made absolute.
 */
export function whatsappLinks(pages: WebPage[]): string[] {
  const links = urlsIn(pages, [['a[href]', 'href']]);
  return unique(links.filter((url) => isOn(url, ['wa.me', 'api.whatsapp.com'])).map(String));
}

/**
 * Finds links to the clinic's own Facebook, Instagram, TikTok, YouTube or LinkedIn profiles.
 *
 * Does not keep share buttons or a bare network homepage: neither is the clinic's profile.
 * Does not check that a profile is active.
 * @param pages - The pages read.
 * @returns Each profile link once, made absolute.
 */
export function socialLinks(pages: WebPage[]): string[] {
  const links = urlsIn(pages, [['a[href]', 'href']]).filter(
    (url) => isOn(url, SOCIAL_HOSTS) && url.pathname.length > 1 && !SHARE_PATH.test(url.pathname),
  );
  return unique(links.map(String));
}

/**
 * Finds ways to book online: links, embeds or scripts of known booking sites, and forms that
 * offer to book an appointment.
 * @param pages - The pages read.
 * @returns Evidence: each booking URL, and "form: <its text>" for each booking form.
 */
export function onlineBooking(pages: WebPage[]): string[] {
  const widgets = urlsIn(pages, [
    ['a[href]', 'href'],
    ['iframe[src]', 'src'],
    ['script[src]', 'src'],
  ]).filter((url) => isOn(url, BOOKING_HOSTS));
  const forms = eachPage(pages, ($) =>
    $('form')
      .toArray()
      .map((form) => {
        const values = $(form).find('[value]').toArray();
        return [$(form).text(), ...values.map((input) => $(input).attr('value'))].join(' ');
      })
      .flatMap((text) => BOOKING_FORM.exec(text) ?? [])
      .map((match) => `form: ${match}`),
  );
  return unique([...widgets.map(String), ...forms]);
}

/**
 * Finds live chat widgets: tawk.to, Crisp and Intercom scripts, and WhatsApp chat buttons.
 * @param pages - The pages read.
 * @returns Evidence: each chat script URL made absolute, "inline script: <name>", or
 * "WhatsApp widget: <class>".
 */
export function chatWidgets(pages: WebPage[]): string[] {
  const found = eachPage(pages, ($, page) => [
    ...$('script')
      .toArray()
      .flatMap((script) => {
        const source = $(script).attr('src');
        if (source !== undefined) {
          // Absolute, as urlsIn makes them: "//embed.tawk.to/…" names its host only that way.
          const url = URL.parse(source, page.url);
          return url !== null && CHAT_SCRIPTS.test(url.href) ? [url.href] : [];
        }
        const inline = CHAT_SCRIPTS.exec($(script).text());
        return inline === null ? [] : [`inline script: ${inline[0]}`];
      }),
    ...$('[class], [id]')
      .toArray()
      .flatMap((element) => {
        const names = `${$(element).attr('class') ?? ''} ${$(element).attr('id') ?? ''}`;
        const widget = WHATSAPP_WIDGET.exec(names);
        return widget === null ? [] : [`WhatsApp widget: ${widget[0]}`];
      }),
  ]);
  return unique(found);
}
