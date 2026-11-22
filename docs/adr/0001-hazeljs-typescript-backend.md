# 0001. HazelJS + TypeScript for the backend and agents

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** Muhammad Fahad
- **PRD links:** G7, G8, NFR-8

## Context

The project must double as the HazelJS Campus Ambassador submission, which requires a public TypeScript repo using `@hazeljs/agent`; 30% of the evaluation is practical use of HazelJS. The dashboard is Next.js (TypeScript). The founder wants one language end to end and industry-standard practice.

## Options considered

1. **HazelJS (TypeScript)** — required for the submission; agents, durable approvals and policies built in. Young framework with gaps in docs.
2. **Python + FastAPI** — strong AI ecosystem; does not qualify for the submission; two languages.
3. **NestJS + LangGraph.js** — mature; does not qualify for the submission.

## Decision

Build the API, worker and agents on HazelJS in TypeScript, with strict mode.

## Consequences

- One language and one set of Zod schemas shared by API and dashboard.
- HazelJS versions are pinned exactly; the Meridian reference app is studied before Cycle 1 coding.
- If a HazelJS feature fails for a requirement, that part may use plain TypeScript, recorded in a new ADR.

## Update 2026-11-12: `@hazeljs/eval` 2.0.13 is installed, and the lead graph's run store (#15)

**Why `@hazeljs/eval` is a dependency.** `@hazeljs/agent` 2.0.13 lists `@hazeljs/eval` as an optional peer (`peerDependenciesMeta["@hazeljs/eval"].optional: true`), but it cannot be imported without it. `dist/index.js` re-exports `./evaluation/agent-eval`, and that file runs `require("@hazeljs/eval")` at the top level. So `import … from '@hazeljs/agent'` fails with `Cannot find module '@hazeljs/eval'`. We pin `@hazeljs/eval` at exactly 2.0.13, the same as `@hazeljs/agent`, and use none of its helpers. The founder files the upstream issue. Remove the dependency once a fixed `@hazeljs/agent` is pinned.

**How the lead graph is durable.** The lead pipeline (#15) is an `AgentGraph` of function nodes. In 2.0.13, `CompiledGraph.execute()` keeps its state in memory: it gives every call a new `graph_<uuid>` execution id and takes no run store, checkpoint or resume option (`GraphExecutionOptions`). Runs and checkpoints are therefore written through HazelJS's own SQL durable run store: `createSqlDurableRunStore(prisma)` gives `runRepository` (the `agent_runs` table) and `checkpointService` (`agent_run_checkpoints`). Both tables come from `@hazeljs/agent`'s `prisma-schema.example.prisma` (#5). `Lead.graphRunId` holds that `AgentRun` id. A resumed or retried lead starts a new `AgentGraph` run at its next step. Steps that are already done skip themselves, so a resume repeats a paid call only when a crash fell between that call and its save. Each node first renews the lead runner's claim on the lead, so no node starts without holding it.

## Update 2026-11-22: HazelJS 2.1.3

Every `@hazeljs/*` package is pinned at exactly 2.1.3 (`agent`, `core` and `eval` directly; `prompts`, `rag` and `resilience` come in as peers at the same version). Checked against the release notes from 2.0.14 to 2.1.3 and the published 2.1.3 code:

- **Both upstream bugs are fixed** in 2.0.14: `listen(port, host)` ([#35](https://github.com/hazel-js/hazeljs/issues/35), PR #37) and cleared health-check timers ([#36](https://github.com/hazel-js/hazeljs/issues/36), PR #38). Our `@hazeljs/core` patch is removed and ADR-0013 is superseded. `apps/api/test/server-binding.int.spec.ts` still proves the API binds to 127.0.0.1.
- **`@hazeljs/eval` stays.** `@hazeljs/agent` 2.1.3 still lists it as an optional peer, but `dist/evaluation/agent-eval.js` still runs `require("@hazeljs/eval")` at the top level and `dist/index.js` still re-exports it.
- **The lead graph is unchanged.** `GraphExecutionOptions` in 2.1.3 still has only `sessionId`, `userId`, `maxSteps`, `timeout` and `initialData`: no resume, checkpoint or run-store option. The durable run store described in the 2026-11-12 update still applies.
- **No schema change.** `prisma-schema.example.prisma` in `@hazeljs/agent` 2.1.3 is identical to 2.0.13, so the Agent OS tables need no migration.
- **Zod 4.** 2.0.16 moved the agent packages to Zod 4; we already pin `zod` 4.6.7.
- **Release age.** 2.1.3 was published on 2026-11-22, inside pnpm's minimum release age, so pnpm listed the six exact `@hazeljs/*@2.1.3` versions under `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`. Remove those entries once the versions are older than the minimum age.
