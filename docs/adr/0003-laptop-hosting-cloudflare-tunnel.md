# 0003. Run on the founder's laptop; Cloudflare Tunnel for 3 public paths

- **Status:** Accepted
- **Date:** 2026-11-02
- **Deciders:** Muhammad Fahad
- **PRD links:** NFR-5, NFR-11, NFR-12

## Context

A VPS costs about Rs 6,000 a month. v1 volume fits a laptop. Vapi must reach the system for in-call tools and end-of-call webhooks.

## Options considered

1. **Laptop + Cloudflare Tunnel** — no hosting cost; laptop must be on in calling hours.
2. **Hostinger VPS** — always on; ~Rs 6,000/month; deployment work.
3. **Laptop + serverless webhook relay** — catches webhooks while offline; does not help in-call tools, which need the laptop anyway.

## Decision

Run everything on the laptop. A Cloudflare Tunnel on `hooks.voxflow.agency` exposes only `/vapi/tools/get-slots`, `/vapi/tools/book-slot` and `/webhooks/vapi`; all other paths return 404.

## Consequences

- Calls are placed only while the health check passes (database, worker, tunnel).
- Power cuts and sleep pause work; durable runs and reconciliation (ADR-0009) catch up afterwards.
- Nightly `pg_dump` to a Google Drive–synced folder; monthly restore test.
- Revisit when selling to agencies or when uptime costs meetings.
