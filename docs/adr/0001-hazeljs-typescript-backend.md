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

**How the lead graph is durable.** The lead pipeline (#15) is an `AgentGraph` of function nodes. In 2.0.13, `CompiledGraph.execute()` keeps its state in memory: it gives every call a new `graph_<uuid>` execution id and takes no run store, checkpoint or resume option (`GraphExecutionOptions`). Runs and checkpoints are therefore written through HazelJS's own SQL durable run store: `createSqlDurableRunStore(prisma)` gives `runRepository` (the `agent_runs` table) and `checkpointService` (`agent_run_checkpoints`). Both tables come from `@hazeljs/agent`'s `prisma-schema.example.prisma` (#5). `Lead.graphRunId` holds that `AgentRun` id. A resumed or retried lead starts a new `AgentGraph` run at its next step. Steps that are already done skip themselves, so a resume never pays twice.
