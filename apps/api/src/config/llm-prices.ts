/**
 * The LLM price table and the two sums the monthly cap needs: what a call cost, and the most a call
 * can cost before it is sent.
 *
 * Serves: FR-33, NFR-4, ADR-0006 (Haiku 5.5: $0.10 / $0.50 per million tokens, $0.50 / $2.50 for
 * prompts over 100,000 tokens; checked 12 Nov 2026); issue #13.
 * Used by: apps/api/src/llm/llm.service.ts, apps/api/src/config/llm-prices.spec.ts.
 */
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import type { LlmRequest, LlmUsage } from '../ports/llm.port.js';

/** US dollars per million tokens, as decimal strings (money is never a float). */
interface ModelPrice {
  input: string;
  output: string;
  /** Rates for the whole call once the prompt passes {@link LONG_PROMPT_TOKENS}. */
  longInput: string;
  longOutput: string;
}

// Only models a task may use: a model missing here is refused before any call (ADR-0006).
const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-5-5': { input: '0.10', output: '0.50', longInput: '0.50', longOutput: '2.50' },
};

const LONG_PROMPT_TOKENS = 100_000;
const PER_MILLION = 1_000_000;
// Room for what the API adds to a prompt: message framing and the structured-output instructions.
const OVERHEAD_TOKENS = 1_000;

const priceOf = (model: string): ModelPrice => {
  const price = PRICES[model];
  if (price === undefined) throw new Error(`No LLM price for model ${model}`);
  return price;
};

/**
 * Works out what one call cost from the tokens it was billed for.
 * @param model - The model id the call ran on.
 * @param usage - Input and output tokens from the provider's answer.
 * @returns US dollars.
 * @throws Error when the model has no price in the table.
 */
export function llmCostUsd(model: string, usage: LlmUsage): Prisma.Decimal {
  const price = priceOf(model);
  const long = usage.inputTokens > LONG_PROMPT_TOKENS;
  const input = new Prisma.Decimal(long ? price.longInput : price.input).times(usage.inputTokens);
  const output = new Prisma.Decimal(long ? price.longOutput : price.output).times(
    usage.outputTokens,
  );
  return input.plus(output).dividedBy(PER_MILLION);
}

/**
 * Works out the most a call can cost, before it is sent, so the cap can refuse it.
 *
 * Counts every UTF-8 byte of the prompts and the answer schema as a token (a token is never shorter
 * than one byte), adds an allowance for what the API adds, and assumes the answer uses all of
 * `maxTokens`, which caps thinking and text together.
 * Does not call the provider to count tokens: the bound is cheap and always at least the real
 * count, so the cap can only err on the safe side.
 * @param request - The call about to be sent.
 * @returns US dollars.
 * @throws Error when the model has no price in the table, or when the schema cannot be written as
 * JSON Schema (e.g. it holds a transform or a date), which the provider could not be sent either.
 */
export function llmMaxCostUsd(
  request: Pick<LlmRequest, 'model' | 'system' | 'user' | 'schema' | 'maxTokens'>,
): Prisma.Decimal {
  const schemaText = JSON.stringify(z.toJSONSchema(request.schema));
  const inputTokens =
    Buffer.byteLength(request.system) +
    Buffer.byteLength(request.user) +
    Buffer.byteLength(schemaText) +
    OVERHEAD_TOKENS;
  return llmCostUsd(request.model, { inputTokens, outputTokens: request.maxTokens });
}
