---
name: testing-conventions
description: How tests are written in this repo — unit, adapter, integration, agent and eval tests, fixtures and coverage gates. Use whenever adding or changing tests.
---

# Testing conventions

## Kinds of tests
| Kind | Where | Uses | Gate |
|---|---|---|---|
| Unit | `*.spec.ts` next to the code | pure functions (scoring, policies, normalisers, slot maths) | ≥ 80% coverage for `scoring/`, `policies/` |
| Adapter | `adapters/**/*.spec.ts` | recorded JSON fixtures, no network | ≥ 80% for `adapters/` |
| Integration | `apps/api/test/*.int.spec.ts` | real Postgres from docker compose, fake adapters | runs in CI with a service container |
| Agent | `agents/*.spec.ts` | `@hazeljs/testing` (`describeAgent`), fake `LlmPort` | — |
| Eval | `evals/` | 10 fictional clinics, real LLM (manual / nightly) | solution must cite valid signals; script must contain no numbers or prices |

## Rules
- Arrange / Act / Assert, one behaviour per test, name it as a sentence: `it('gives 0 points for no-online-booking when the website is unreadable')`.
- Test the scoring table row by row: every signal has a "gets points" and a "no evidence, no points" test.
- Policies: test allow and deny, and the boundaries (13:00 exactly, Friday 12:30, attempt 2 vs 3).
- Use fixed clocks (`jest.useFakeTimers().setSystemTime(...)`) for anything with time; dates in PKT written as UTC.
- No network in unit or adapter tests. No snapshot tests of LLM text.
- Fixtures are fictional: invented clinic names, `+92300000xxxx` numbers, no real reviews.
- A bug fix starts with a failing test that reproduces it.
