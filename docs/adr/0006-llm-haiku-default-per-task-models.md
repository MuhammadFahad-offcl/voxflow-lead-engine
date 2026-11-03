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
