/**
 * Pure normalizers for the two contact fields of a scraped place: phone and website.
 *
 * Serves: FR-6, PRD "Lead scoring model" (mobile_number), ADR-0015 (Compass supplies both fields).
 * Used by: apps/api/src/pipeline/normalize.spec.ts; the discover step in #10.
 */
// The /max build: the default one has no number-type metadata, so getType() would always be undefined.
import { parsePhoneNumberFromString, type PhoneNumberType } from 'libphonenumber-js/max';
import type { PhoneType } from '../generated/prisma/client.js';

/** A phone in the form `Lead.phone` and `Lead.phoneType` store. */
interface NormalizedPhone {
  /** E.164, always +92…; null when the input holds no valid Pakistani number. */
  e164: string | null;
  type: PhoneType;
}

const NO_PHONE: NormalizedPhone = { e164: null, type: 'UNKNOWN' };

// Only clear answers count: FIXED_LINE_OR_MOBILE, UAN, toll-free and the like must not earn the
// mobile_number signal, and they stay dialable as UNKNOWN.
const toPhoneType = (type: PhoneNumberType | undefined): PhoneType => {
  if (type === 'MOBILE') return 'MOBILE';
  if (type === 'FIXED_LINE') return 'LANDLINE';
  return 'UNKNOWN';
};

// Listings join several numbers with these, e.g. "0300-1234567 / 0321-7654321".
const NUMBER_SEPARATOR = /[/,;|]/;

/**
 * Reads a phone number as written on a listing, assuming Pakistan when it has no country code.
 *
 * Does not keep valid foreign numbers: every stored phone is +92 (FR-6), and v1 only calls Pakistan.
 * Does not keep more than one number: a listing with several gives its first valid Pakistani one.
 * @param raw - The number as scraped, e.g. "0300-1234567" or "042 35123456".
 * @returns The E.164 number and its type; `e164` is null when there is no valid Pakistani number.
 */
export function normalizePhone(raw: string): NormalizedPhone {
  for (const part of raw.split(NUMBER_SEPARATOR)) {
    const phone = parsePhoneNumberFromString(part, 'PK');
    if (phone?.country === 'PK' && phone.isValid()) {
      return { e164: phone.number, type: toPhoneType(phone.getType()) };
    }
  }
  return NO_PHONE;
}

// Ad-click and campaign ids. A list, not "every parameter": a real site can need its own query.
const TRACKING_PARAM =
  /^(?:utm_.*|gclid|gbraid|wbraid|dclid|fbclid|msclkid|yclid|igshid|mc_[ce]id)$/i;
// Ends in a letters-only or punycode TLD, which rules out localhost, IP addresses and "N/A".
const PUBLIC_HOST = /\.(?:[a-z]{2,}|xn--[a-z0-9-]+)$/;
// These pass the check above but name a local machine; nip.io names resolve to any IP they spell.
const LOCAL_HOST = /\.(?:localhost|local|internal|lan|nip\.io)$/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

// A loop, not a /+$ regex: that one backtracks badly on a long scraped path.
const dropTrailingSlashes = (path: string): string => {
  let end = path.length;
  while (path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
};

/**
 * Turns a listing's website into one canonical https address.
 *
 * Does not check that the site exists or answers: the enrich step reads it (FR-9).
 * Does not keep the fragment: browsers never send it, so it cannot change what the site returns.
 * Refuses other schemes and hosts whose name alone shows they are not public, because the enrich
 * step fetches this address from the founder's laptop; a scraped `http://127.0.0.1:4000` must never
 * reach it.
 * Does not prove a host is public: any ordinary name can still resolve to a private address, so
 * #11 must check the resolved address before it fetches.
 * @param raw - The website as scraped, with or without a scheme.
 * @returns The https URL with no tracking parameters and no trailing slash, or null.
 */
export function normalizeUrl(raw: string): string | null {
  const text = raw.trim();
  const url = URL.parse(HAS_SCHEME.test(text) ? text : `https://${text.replace(/^\/\//, '')}`);
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  // "mailto:a@b.com" parses as user "mailto" at host b.com once https:// is added in front.
  if (url.username !== '' || url.password !== '') return null;
  if (!PUBLIC_HOST.test(url.hostname) || LOCAL_HOST.test(url.hostname)) return null;
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  return `https://${url.host}${dropTrailingSlashes(url.pathname)}${url.search}`;
}
