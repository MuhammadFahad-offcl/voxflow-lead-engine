---
name: hazeljs-conventions
description: How code is structured in apps/api with HazelJS — modules, DI, ports and adapters, agents, tools, graphs, policies. Use when writing or reviewing any backend code.
---

# HazelJS conventions for apps/api

Check the installed HazelJS version's docs/types before using an API you have not used in this repo yet; do not invent decorator options.

## Layout
- `modules/<feature>/` — controller (HTTP only: parse with Zod, call service, map errors), service (use-case logic), `<feature>.module.ts`.
- `pipeline/` — steps (`discover`, `enrich`, `score`) and `lead.graph.ts` (one `AgentGraph` per lead).
- `agents/` — one file per agent: `solution`, `script`, `approval`, `caller`, `outcome`.
- `scoring/` and `policies/` — pure functions only. No DI, no I/O.
- `adapters/<port>/{<real>.adapter.ts, fake.adapter.ts}` and `ports/<port>.port.ts` (interface + DI token).
- `scheduler/` — worker loops; each loop is a function taking its dependencies.
- `db/` — Prisma client provider and repositories.

## Rules
- Depend on ports, never on SDKs. Only adapters import `apify-client`, `@anthropic-ai/sdk`, Vapi, Google APIs, Perplexity, `puppeteer-core`.
- Bind real or fake adapters in one place (the adapters module) from `env.DEMO_MODE`.
- Agents get model ids from `Settings.llmModels[task]`; never hard-code a model name outside `config/`.
- Every LLM call goes through `LlmPort`, which records a `CostRecord` and enforces the monthly cap before calling.
- LLM output is parsed with a Zod schema; on failure retry once with the validation error, then mark `NEEDS_REVIEW`.
- Tools that cause real-world effects (`queueCampaignCalls`, `placeCall`) use `requiresApproval` or a Gatekeeper policy. Gatekeeper is default-deny: a new tool needs an explicit allow rule.
- Durable state lives in Postgres (HazelJS SQL run store). No in-memory state survives a restart except the calendar slot cache (ADR-0008).
- Worker loops claim rows with `UPDATE … WHERE status = X … RETURNING` (or `SELECT … FOR UPDATE SKIP LOCKED`) so two loops never take the same row.
- Errors: throw typed domain errors (`NotFoundError`, `PolicyDeniedError`, `ExternalServiceError`); controllers map them to HTTP codes. Never swallow an error; record `failedStep` + `error` on the lead.
- Logging: structured logger with `leadId`, `campaignId`, `runId`. Mask phones to last 4 digits.
