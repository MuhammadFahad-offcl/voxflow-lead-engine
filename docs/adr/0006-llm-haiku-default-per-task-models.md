# 0006. Claude Haiku 5.5 default; model is a per-task setting

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Muhammad Fahad
- **PRD links:** G5, FR-13, FR-17, FR-18, FR-28, FR-33, NFR-4

## Context

Pipeline LLM spend must stay under $10 a month at ~2,000 leads. Claude Haiku 5.5 costs $0.10 / $0.50 per million input/output tokens; estimated pipeline cost is $4–5 a month. Urdu script quality is unproven for any small model.

## Options considered

1. **Haiku 5.5 for all tasks, fixed** — cheapest; no way to test alternatives.
2. **Haiku 5.5 default, model chosen per task in Settings** — same cost; allows the Cycle 2 comparison.
3. **A larger model for scripts** — ~20× the price per token; unjustified before measuring.

## Decision

Every LLM call goes through `LlmPort` with a task key (`REVIEW_LABELLING`, `SOLUTION`, `SCRIPT`, `OUTCOME`). `Settings.llmModels` maps each key to a model; default `claude-haiku-5-5`. In Cycle 2, `SCRIPT` is compared with `gpt-6-luna` (same price) on 10 Urdu scripts; the founder keeps the more natural one. Embeddings use Perplexity `pplx-embed-v1-0.6b` (1024 dims). A hard monthly cap of $10 blocks LLM calls when reached.

## Consequences

- Switching a model is a settings change, not a code change.
- Two provider SDKs may be present; both behind `LlmPort`.
- The Vapi in-call model is configured in Vapi and is not counted in the $10 cap.

## Update 2026-11-12: the Anthropic adapter uses `@anthropic-ai/sdk`, not `@hazeljs/ai` (#13)

The C1-11 prompt asked for `@hazeljs/ai` unless it could not do the job. `@hazeljs/ai` 2.0.13 was installed in a scratch folder and its types and Anthropic provider read (12 Nov 2026):

- `AICompletionRequest` has no thinking setting, and the Anthropic provider sends only `model`, `max_tokens`, `temperature`, `system` and `messages`. Thinking cannot be turned off, and Claude Haiku 5.5 thinks by default (effort `medium`). Thinking tokens are billed as output, which breaks the "< $0.001 per lead" target for labelling.
- `responseFormat` (JSON schema output) is used only by its OpenAI provider; the Anthropic provider ignores it.
- It wraps every Anthropic error in a plain `Error`, so a 429 (not billed, safe to retry) cannot be told from a timeout (maybe billed). The cap needs that difference (FR-33).
- It pins `@anthropic-ai/sdk` 0.82 and Zod 3, and pulls in the OpenAI, Cohere and Gemini SDKs.

**Decision:** `AnthropicLlmAdapter` uses `@anthropic-ai/sdk` 1.8.0 (founder approved, #13) behind `LlmPort`. It sends `thinking: {type: "disabled"}` and `output_config.format` with the task's Zod schema, and turns off the SDK's own retries so it can retry only unbilled failures. The fake adapter and the cap are unchanged by this choice. HazelJS stays the framework for DI, modules and `@hazeljs/agent` (ADR-0001).

**Prices** (checked 12 Nov 2026) are in `apps/api/src/config/llm-prices.ts`: Haiku 5.5 is $0.10 / $0.50 per million input/output tokens up to 100,000 prompt tokens, and $0.50 / $2.50 for a call above that. A model with no price there is refused before any call.
