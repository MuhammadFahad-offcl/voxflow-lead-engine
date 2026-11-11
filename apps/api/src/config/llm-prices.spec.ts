/**
 * Unit tests of the LLM price table: what a call cost, and the most a call can cost.
 *
 * Serves: FR-33, NFR-4, ADR-0006 (Haiku 5.5 prices); issue #13.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { llmCostUsd, llmMaxCostUsd } from './llm-prices.js';

const HAIKU = 'claude-haiku-5-5';

// Proves cost = tokens x the model's price, with the long-prompt price above 100,000 input tokens.
describe('llmCostUsd', () => {
  it('prices Haiku 5.5 at $0.10 in and $0.50 out per million tokens', () => {
    const cost = llmCostUsd(HAIKU, { inputTokens: 3_000, outputTokens: 600 });

    expect(cost.toString()).toBe('0.0006');
  });

  it('uses the long-prompt price for the whole call above 100,000 input tokens', () => {
    expect(llmCostUsd(HAIKU, { inputTokens: 100_000, outputTokens: 0 }).toString()).toBe('0.01');
    expect(llmCostUsd(HAIKU, { inputTokens: 100_001, outputTokens: 1_000 }).toString()).toBe(
      '0.0525005',
    );
  });

  it('refuses a model with no price, so no call is made that cannot be counted', () => {
    expect(() => llmCostUsd('fictional-model', { inputTokens: 1, outputTokens: 1 })).toThrow(
      'No LLM price for model fictional-model',
    );
  });
});

// Proves the worst-case estimate is built from bounds the real call cannot pass.
describe('llmMaxCostUsd', () => {
  const schema = z.object({ ok: z.boolean() });

  it('counts every prompt byte as a token, plus the schema, an allowance and the full answer', () => {
    const request = { model: HAIKU, system: 'ab', user: 'ü', schema, maxTokens: 1_000 };
    const schemaBytes = Buffer.byteLength(JSON.stringify(z.toJSONSchema(schema)));

    const cost = llmMaxCostUsd(request);

    // 2 + 2 bytes of prompt, the schema, 1,000 tokens of allowance; 1,000 answer tokens.
    const input = 4 + schemaBytes + 1_000;
    expect(cost.toString()).toBe(
      llmCostUsd(HAIKU, { inputTokens: input, outputTokens: 1_000 }).toString(),
    );
  });

  it('uses the long-prompt price once the bound passes 100,000 tokens', () => {
    const request = { model: HAIKU, system: '', user: 'x'.repeat(100_000), schema, maxTokens: 0 };

    // $0.50 per million input tokens, not $0.10: over 100,000 the whole call is priced long.
    expect(llmMaxCostUsd(request).toNumber()).toBeGreaterThan(0.05);
  });

  it('refuses a model with no price', () => {
    const request = { model: 'fictional-model', system: '', user: '', schema, maxTokens: 1 };

    expect(() => llmMaxCostUsd(request)).toThrow('No LLM price for model fictional-model');
  });

  it('stays above the real cost of a typical labelling call', () => {
    const user = 'x'.repeat(6_000);
    const request = { model: HAIKU, system: 'y'.repeat(2_000), user, schema, maxTokens: 2_000 };

    expect(llmMaxCostUsd(request).toNumber()).toBeGreaterThan(
      llmCostUsd(HAIKU, { inputTokens: 3_000, outputTokens: 2_000 }).toNumber(),
    );
  });
});
