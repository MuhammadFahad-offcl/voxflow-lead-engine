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
