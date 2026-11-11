/**
 * The port every LLM call goes through: one request in, the model's raw JSON text and its token
 * usage out. Parsing, the monthly cap and cost records sit above it, so the fake adapter is held to
 * the same rules as the real one.
 *
 * Serves: FR-13, FR-33, NFR-4, ADR-0006 (model per task), ADR-0007; issue #13.
 * Used by: apps/api/src/adapters/llm/, apps/api/src/llm/llm.service.ts,
 * apps/api/src/db/llm-spend.repository.ts, apps/api/src/config/llm-prices.ts,
 * apps/api/src/bootstrap.ts.
 */
import type { LlmModels } from '@voxflow/shared';
import type { z } from 'zod';

/** DI token of {@link LlmPort}. */
export const LLM = 'LlmPort';

/** What an LLM call is for; `Settings.llmModels` maps each to a model (ADR-0006). */
export type LlmTask = keyof z.infer<typeof LlmModels>;

/**
 * A failed call. The message is a fixed phrase, optionally with an HTTP status or a fixture path,
 * never a prompt, an answer or a key, so it is safe to log.
 */
export class LlmError extends Error {
  /**
   * Builds the error.
   * @param message - A fixed phrase.
   * @param maybeBilled - False only when the provider is known not to have billed the request (it
   * was never sent, was refused, or was rate limited or failed upstream); true when it may have
   * been, as after a timeout or a dropped connection.
   */
  constructor(
    message: string,
    readonly maybeBilled: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** One request to a model. */
export interface LlmRequest {
  task: LlmTask;
  /** The model id from `Settings.llmModels[task]`, e.g. `claude-haiku-5-5`. */
  model: string;
  /** Instructions; the same for every call of a task. */
  system: string;
  /** The data to work on. */
  user: string;
  /** The shape the answer must have; sent to the model as a JSON schema. */
  schema: z.ZodType;
  /** The most tokens the answer may use, thinking included. */
  maxTokens: number;
}

/** Tokens one call was billed for. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/** What the model answered, unparsed. */
export interface LlmReply {
  /** The answer's text: JSON when the model kept to the schema. */
  text: string;
  usage: LlmUsage;
  /** The model that answered. */
  model: string;
  /** Why it stopped, e.g. `end_turn`, `max_tokens` (answer cut short) or `refusal`. */
  stopReason: string;
}

/** Talks to a language model. Implemented by the Anthropic adapter and a fake. */
export interface LlmPort {
  /**
   * Sends one request and returns the answer as text, with what it was billed for.
   *
   * Does not parse or validate the answer, and does not check a spend cap: the caller does both.
   * Does not retry a request that may already have been billed.
   * @param request - The model, prompts, answer schema and token limit.
   * @returns The raw answer and its usage, also when the model stopped early or refused.
   * @throws LlmError when the call failed; its `maybeBilled` says whether it may have cost money.
   */
  complete(request: LlmRequest): Promise<LlmReply>;
}
