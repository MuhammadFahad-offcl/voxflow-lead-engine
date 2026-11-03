# 0007. Ports and adapters with fake adapters and demo mode

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** Muhammad Fahad
- **PRD links:** FR-36, NFR-9, US-17

## Context

HazelJS evaluators must run the project without paid accounts. Tests must not call paid APIs. Providers (Apify actor, LLM, voice) may change.

## Options considered

1. **Port interface + real and fake adapter per service, selected in DI** — testable; demo mode for free.
2. **Mock HTTP in tests only** — no demo mode; brittle.
3. **Call real services in tests** — slow, costly, flaky.

## Decision

Seven ports: `LeadSourcePort`, `WebReaderPort`, `WebContextPort`, `LlmPort`, `EmbeddingPort`, `VoicePort`, `CalendarPort`. Each has a real and a fake adapter. `DEMO_MODE=true` binds every fake in one DI module. Business code never checks `DEMO_MODE`. Fixtures are fictional.

## Consequences

- Every new outside service needs a port, both adapters and fixture data.
- The demo run doubles as the end-of-cycle end-to-end test.
