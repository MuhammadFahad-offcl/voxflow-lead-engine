/**
 * Pure extractors that read a clinic website's visible text: the doctors it names and the
 * treatments it lists. Each returns its evidence: the matched words.
 *
 * Serves: FR-10, PRD "Lead scoring model" (multiple_doctors_services, decision_maker_name); #11.
 * Used by: only its spec so far, apps/api/src/pipeline/extract/clinic-text.spec.ts.
 */
import type { WebPage } from '../../ports/web-reader.port.js';

// "Dr. Ayesha Khan", "Dr Bilal Ahmed": up to three capitalised words after the title. Spaces, not
// \s: the reader gives each block its own line, and a name never runs into the next one.
const ENGLISH_DOCTOR = /\bDr\.? +([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})/g;
// "ڈاکٹر سارہ احمد": one or two words after the Urdu title; punctuation ends the name. Words take
// marks too (\p{M}): Urdu vowel signs such as zabar are marks, not letters.
const URDU_DOCTOR = /ڈاکٹر +([\p{L}\p{M}]+(?: [\p{L}\p{M}]+)?)/gu;
// Words that name a clinic, not a person: "Dr. Ahmed Dental Clinic" is Dr. Ahmed's clinic.
const CLINIC_WORDS = new Set([
  ...'Dental Dentistry Dentist Dentists Clinic Clinics Care Centre Center Hospital'.split(' '),
  ...'Surgery Studio Smile Smiles Medical Health کلینک ڈینٹل ہسپتال اسپتال'.split(' '),
]);
// The dental niche's treatments (v1 has one niche), each with the words that name it on a site.
const TREATMENTS: Record<string, RegExp> = {
  braces: /\bbraces\b/i,
  aligners: /\baligners?\b/i,
  'root canal': /\broot canals?\b|\brct\b/i,
  whitening: /\bwhitening\b/i,
  implants: /\bimplants?\b/i,
  scaling: /\bscaling\b/i,
  polishing: /\bpolishing\b/i,
  fillings: /\bfillings?\b/i,
  extractions: /\bextractions?\b/i,
  crowns: /\bcrowns?\b/i,
  bridges: /\bbridges?\b/i,
  veneers: /\bveneers?\b/i,
  dentures: /\bdentures?\b/i,
};

// The words before the first clinic word; none when the match is a clinic ("Dr Smile Dental Care").
const personName = (match: string): string[] => {
  const words = match.split(' ');
  const end = words.findIndex((word) => CLINIC_WORDS.has(word));
  if (end === 0) return [];
  return [(end === -1 ? words : words.slice(0, end)).join(' ')];
};

/**
 * Finds doctors named on the site, in English ("Dr." or "Dr") or Urdu ("ڈاکٹر").
 *
 * Does not tell the owner from the staff: the first name found is only the likeliest lead doctor.
 * Does not count a clinic named after a doctor: a name ends at its first clinic word ("Dental",
 * "Clinic", "کلینک"), and a match that starts with one is dropped.
 * @param pages - The pages read, homepage first.
 * @returns Each doctor once, as "Dr. <name>" or "ڈاکٹر <name>", in the order the pages name them.
 */
export function doctorNames(pages: WebPage[]): string[] {
  const names = pages.flatMap(({ text }) =>
    [
      ...[...text.matchAll(ENGLISH_DOCTOR)].map((match) => ({ match, title: 'Dr.' })),
      ...[...text.matchAll(URDU_DOCTOR)].map((match) => ({ match, title: 'ڈاکٹر' })),
    ]
      // Page order, so "first doctor found" does not mean "first English one".
      .sort((a, b) => a.match.index - b.match.index)
      .flatMap(({ match, title }) => personName(match[1] ?? '').map((name) => `${title} ${name}`)),
  );
  return [...new Set(names)];
}

/**
 * Finds the dental treatments the site lists.
 * @param pages - The pages read.
 * @returns The treatments found, each once, by their canonical name; its length is the count.
 */
export function treatments(pages: WebPage[]): string[] {
  const text = pages.map((page) => page.text).join(' ');
  return Object.entries(TREATMENTS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}
