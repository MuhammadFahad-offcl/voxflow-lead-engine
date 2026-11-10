/**
 * Unit tests of the doctor and treatment extractors, on the fictional fixture sites.
 *
 * Serves: FR-10, PRD "Lead scoring model" (multiple_doctors_services, decision_maker_name); #11.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { FakeWebReaderAdapter } from '../../adapters/web-reader/fake.adapter.js';
import type { WebPage } from '../../ports/web-reader.port.js';
import { doctorNames, treatments } from './clinic-text.js';

const reader = new FakeWebReaderAdapter();
const pagesOf = async (name: string): Promise<WebPage[]> =>
  (await reader.read(`https://${name}.example.com`)).pages;
const text = (words: string): WebPage[] => [
  { url: 'https://clinic.example/', html: '', text: words },
];

// Proves doctors and treatments are found in English and Urdu, each once.
describe('clinic text extractors', () => {
  it('finds the three doctors on p06, in English and Urdu, each once', async () => {
    expect(doctorNames(await pagesOf('p06'))).toEqual([
      'Dr. Ayesha Inventa',
      'Dr. Bilal Makebelieve',
      'ڈاکٹر سارہ فرضی',
    ]);
  });

  it('finds the five treatments p06 lists', async () => {
    expect(treatments(await pagesOf('p06'))).toEqual([
      'braces',
      'aligners',
      'root canal',
      'whitening',
      'implants',
    ]);
  });

  it('finds the one doctor and four treatments of the rendered p07', async () => {
    const pages = await pagesOf('p07');

    expect(doctorNames(pages)).toEqual(['Dr. Imran Madeup']);
    expect(treatments(pages)).toEqual(['scaling', 'fillings', 'crowns', 'dentures']);
  });

  it('finds both doctors and the three treatments on the minified p11', async () => {
    const pages = await pagesOf('p11');

    expect(doctorNames(pages)).toEqual(['Dr. Nadia Pretend', 'Dr. Omar Fakename']);
    expect(treatments(pages)).toEqual(['braces', 'whitening', 'implants']);
  });

  // A clinic named "Dr. …" is not a doctor: the name ends at the first clinic word.
  it.each([
    ['Visit Dr. Ahmed Dental Clinic today', ['Dr. Ahmed']],
    ['Dr Smile Dental Care, Gulberg', []],
    ['ڈاکٹر احمد کلینک', ['ڈاکٹر احمد']],
    ['ڈاکٹر ڈینٹل کلینک', []],
  ])('ends a name at clinic words in %j', (words, names) => {
    expect(doctorNames(text(words))).toEqual(names);
  });

  it('lists doctors in the order the page names them, Urdu or English', () => {
    expect(doctorNames(text('ڈاکٹر سارہ فرضی، then Dr. Ayesha Inventa'))).toEqual([
      'ڈاکٹر سارہ فرضی',
      'Dr. Ayesha Inventa',
    ]);
  });

  it('stops a name at the first lower-case word or punctuation', () => {
    expect(doctorNames(text('Dr. Sana Ali sees patients; ask Dr Omar.'))).toEqual([
      'Dr. Sana Ali',
      'Dr. Omar',
    ]);
  });

  // The reader gives each block its own line; the next heading is not part of the name.
  it('stops a name at the end of its line', () => {
    expect(doctorNames(text('Dr. Omar Fakename\nOur Team'))).toEqual(['Dr. Omar Fakename']);
  });

  // Urdu often adds vowel marks (zabar, zer, pesh), which are marks, not letters.
  it('keeps an Urdu name whole when it carries vowel marks', () => {
    expect(doctorNames(text('ڈاکٹر عَلی رِضا سے ملیں'))).toEqual(['ڈاکٹر عَلی رِضا']);
  });

  it('finds nothing in text with no doctors or treatments', () => {
    const pages = text('Open Monday to Saturday in DHA. Drive safely.');

    expect([doctorNames(pages), treatments(pages)]).toEqual([[], []]);
  });
});
