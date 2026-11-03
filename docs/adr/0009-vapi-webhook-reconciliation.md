# 0009. Recover missed Vapi webhooks by polling, not a cloud relay

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Muhammad Fahad
- **PRD links:** FR-22, FR-28, NFR-2

## Context

If the laptop drops offline as a call ends, Vapi's end-of-call webhook can be missed. Calls start only from the laptop, and in-call booking tools need the laptop online anyway.

## Options considered

1. **Reconciliation job polling Vapi's API** — fully local; recovers any missed result.
2. **Serverless relay (Vercel/Supabase) + queue** — catches webhooks while offline; new service; does not help in-call tools.

## Decision

On worker start and every 15 minutes, attempts in `DIALING` with no result after 20 minutes are fetched with `VoicePort.getCall` and processed by the same handler as the webhook. Calls are placed only while the health check passes.

## Consequences

- Results can arrive up to ~15 minutes late after an outage.
- The webhook handler must be idempotent on `vapiCallId` (it is).
