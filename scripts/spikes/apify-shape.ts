/**
 * Spike for #9: prints the structure of a saved actor run (field names, value types and how often
 * each field is present), so the Zod schemas and fictional fixtures can match the real item shape.
 *
 * Serves: ADR-0015, issue #9 ("a Zod schema for its dataset items"). Not app code.
 * Used by: the founder, once, on the laptop:
 *   pnpm exec tsx scripts/spikes/apify-shape.ts <saved-run.json> [--reviews]
 * Prints no values at all, only keys and types, so the output is safe to paste.
 * With --reviews it describes the review objects nested in each item's `reviews` array.
 */
import { readFile } from 'node:fs/promises';
import process from 'node:process';

type Json = Record<string, unknown>;

// Key path → how many items have it, and which JSON types its values had.
const seen = new Map<string, { count: number; types: Set<string> }>();
const MAX_DEPTH = 3;

const typeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const walk = (value: unknown, path: string, depth: number): void => {
  const entry = seen.get(path) ?? { count: 0, types: new Set<string>() };
  entry.count += 1;
  entry.types.add(typeOf(value));
  seen.set(path, entry);
  if (depth >= MAX_DEPTH) return;
  if (Array.isArray(value)) {
    // One element is enough to show the shape; counting every element would skew "present in".
    if (value.length > 0) walk(value[0], `${path}[]`, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`, depth + 1);
  }
};

const [path] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (path === undefined) {
  process.stderr.write(
    'Usage: pnpm exec tsx scripts/spikes/apify-shape.ts <saved-run.json> [--reviews]\n',
  );
  process.exit(1);
}
const run = JSON.parse(await readFile(path, 'utf8')) as { items?: Json[] };
const items = process.argv.includes('--reviews')
  ? (run.items ?? []).flatMap((item) =>
      Array.isArray(item['reviews']) ? (item['reviews'] as Json[]) : [],
    )
  : (run.items ?? []);
for (const item of items) walk(item, '$', 0);

process.stdout.write(`${String(items.length)} objects\n`);
for (const [key, { count, types }] of [...seen.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (key === '$') continue;
  const typeList = [...types].sort((a, b) => a.localeCompare(b)).join('|');
  process.stdout.write(`${key}: ${typeList} (in ${String(count)})\n`);
}
