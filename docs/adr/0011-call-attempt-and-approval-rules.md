# 0011. Max 2 calls per business; one approval per campaign

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Muhammad Fahad
- **PRD links:** FR-19, FR-20, FR-23, FR-24, NFR-7

## Context

Calls must be respectful and low-risk for the calling number, while the founder spends at most ~30 minutes a day operating the engine.

## Decision

- A business (matched by place ID and phone) is dialled at most 2 times, ever, across all campaigns. Enforced in code (Gatekeeper `attempt-limit`) and in the database (`attemptNumber` ∈ {1, 2}, unique per lead).
- Attempt 2 is in the opposite calling window on the next allowed day, or at the time the person asked for.
- No attempt 2 after `BOOKED`, `NOT_INTERESTED`, `WRONG_NUMBER` or `DO_NOT_CALL`. `FAILED` (never rang) retries up to 3 times without using an attempt.
- The founder approves each campaign once (template + ≥ 5 sample scripts), not each call.
- Every call opens with AI disclosure and recording notice; "don't call again" adds the number to `DoNotCall` permanently.

## Consequences

- Raising the limit or adding per-call approval requires a new ADR and PRD change.
