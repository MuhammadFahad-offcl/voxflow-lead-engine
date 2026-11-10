/**
 * Unit tests of the link and widget extractors, on the fictional fixture sites and small pages.
 *
 * Serves: FR-10; issue #11 acceptance (emails, wa.me links, social links, booking and chat widgets).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { FakeWebReaderAdapter } from '../../adapters/web-reader/fake.adapter.js';
import type { WebPage } from '../../ports/web-reader.port.js';
import { chatWidgets, emails, onlineBooking, socialLinks, whatsappLinks } from './site-links.js';

const reader = new FakeWebReaderAdapter();
const pagesOf = async (name: string): Promise<WebPage[]> =>
  (await reader.read(`https://${name}.example.com`)).pages;
const page = (html: string, text = ''): WebPage[] => [
  { url: 'https://clinic.example/', html, text },
];

// Proves each fixture site yields the evidence its scoring signals need.
describe('site link extractors on the fixture sites', () => {
  it('finds the booking widget, booking site and booking form on p01, and its profiles', async () => {
    const pages = await pagesOf('p01');

    expect(onlineBooking(pages)).toEqual([
      'https://oladoc.com/pakistan/lahore/fictional-bright-smile',
      'https://calendly.com/fictional-bright-smile/check-up',
      'form: Book Appointment',
    ]);
    expect(socialLinks(pages)).toEqual([
      'https://www.facebook.com/fictionalbrightsmile',
      'https://instagram.com/fictionalbrightsmile/',
    ]);
    expect(chatWidgets(pages)).toEqual([]);
  });

  it('finds both WhatsApp links and the floating WhatsApp button on p03', async () => {
    const pages = await pagesOf('p03');

    expect(whatsappLinks(pages)).toEqual([
      'https://api.whatsapp.com/send?phone=923000000003',
      'https://wa.me/923000000003?text=Hello',
    ]);
    expect(chatWidgets(pages)).toEqual(['WhatsApp widget: whatsapp-float']);
    expect(onlineBooking(pages)).toEqual([]);
  });

  it('finds the tawk.to chat and setmore booking only in the rendered p07', async () => {
    const pages = await pagesOf('p07');

    expect(chatWidgets(pages)).toEqual(['https://embed.tawk.to/000000000000000000000000/default']);
    expect(onlineBooking(pages)).toEqual(['https://www.setmore.com/fictional-gentle-care']);
  });

  it('finds the emails and profiles on the p10 contact page', async () => {
    const pages = await pagesOf('p10');

    expect(emails(pages)).toEqual(['info@p10.example.com', 'appointments@p10.example.com']);
    expect(socialLinks(pages)).toHaveLength(3);
  });

  // Minified HTML has no whitespace between blocks; the address must not take in its neighbours.
  it('finds the one email on the minified p11, with nothing glued to it', async () => {
    expect(emails(await pagesOf('p11'))).toEqual(['info@p11.example.com']);
  });
});

// Proves the extractors skip what only looks like a match.
describe('site link extractors on edge cases', () => {
  it('skips image names that look like emails', () => {
    expect(emails(page('', 'logo@2x.png, a@b and Ali@Clinic.example.'))).toEqual([
      'ali@clinic.example',
    ]);
  });

  // A scraped page can carry a broken percent escape; it must not end the whole enrich step.
  it('skips a mailto link that cannot be decoded and keeps the others', () => {
    const html = '<a href="mailto:%E0%A4">Broken</a><a href="mailto:ali@clinic.example">Mail</a>';

    expect(emails(page(html))).toEqual(['ali@clinic.example']);
  });

  it('skips share buttons and bare network homepages', () => {
    const html =
      '<a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a><a href="https://youtube.com/">YT</a>';

    expect(socialLinks(page(html))).toEqual([]);
  });

  it('finds an inline Intercom script, and skips a form that does not book', () => {
    const html =
      '<script>window.intercomSettings = {}</script><form><button>Subscribe</button></form>';

    expect(chatWidgets(page(html))).toEqual(['inline script: intercom']);
  });

  it('makes a chat script URL absolute against its page', () => {
    const html = '<script src="//embed.tawk.to/0/default"></script>';

    expect(chatWidgets(page(html))).toEqual(['https://embed.tawk.to/0/default']);
    expect(onlineBooking(page(html))).toEqual([]);
  });

  it('reads a booking form by its submit value', () => {
    const html = '<form><input type="submit" value="Request an appointment"></form>';

    expect(onlineBooking(page(html))).toEqual(['form: Request an appointment']);
  });
});
