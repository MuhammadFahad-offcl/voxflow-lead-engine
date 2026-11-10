/**
 * Adapter tests of the fake web context on the fictional fixtures, and of the mapping it shares
 * with the real adapter.
 *
 * Serves: FR-12, ADR-0007, FR-36; issue #12.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { BusinessContext } from '@voxflow/shared';
import { FakeWebContextAdapter } from './fake.adapter.js';
import { toBusinessContext } from './search-results.js';

const adapter = new FakeWebContextAdapter();
const query = (name: string) => ({ name, area: 'DHA Phase 5', city: 'Lahore', website: null });

// Proves the fake answers in the stored shape, keeps every source, and prices one request.
describe('FakeWebContextAdapter', () => {
  it('maps a fixture to a valid context with its sources', async () => {
    const { context, costUsd } = await adapter.getContext(query('Fictional Bright Smile Dental'));

    expect(BusinessContext.parse(context)).toEqual(context);
    expect(context.sources.map(({ date }) => date)).toEqual(['2025-03-14', null]);
    expect(context.summary).toContain('braces, implants');
    expect(costUsd.toString()).toBe('0.005');
    expect(adapter.maxCostUsd().equals(costUsd)).toBe(true);
  });

  it('answers an empty context, still priced, for a business with no fixture', async () => {
    const { context, costUsd } = await adapter.getContext(query('../../etc/passwd'));

    expect(context).toEqual({ summary: '', sources: [] });
    expect(costUsd.toString()).toBe('0.005');
  });
});

// Proves the shared mapping bounds what is stored, so a long page cannot bloat the column.
describe('toBusinessContext', () => {
  const result = (n: number, snippet: string) => ({
    title: `T${String(n)}`,
    url: `https://e.example.com/${String(n)}`,
    snippet,
  });

  it('keeps the top 5 sources, trims snippets and caps the summary', () => {
    const long = `${'word '.repeat(200)}end`;
    const context = toBusinessContext({
      results: Array.from({ length: 8 }, (_unused, index) => result(index, long)),
    });

    expect(context.sources).toHaveLength(5);
    expect(context.sources[0]?.snippet).toHaveLength(300);
    expect(context.sources[0]?.date).toBeNull();
    expect(context.summary.length).toBeLessThanOrEqual(1000);
    expect(context.summary.endsWith('…')).toBe(true);
  });

  it('cuts by code points, so a surrogate pair is never split', () => {
    const context = toBusinessContext({ results: [result(1, '😀'.repeat(400))] });

    expect(context.sources[0]?.snippet.isWellFormed()).toBe(true);
    expect(context.summary.isWellFormed()).toBe(true);
  });
});
