# 0002. PostgreSQL + Prisma + pgvector; no Redis in v1

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** Muhammad Fahad
- **PRD links:** FR-7, FR-16, FR-19, NFR-1, NFR-2

## Context

Lead data is relational (campaign → leads → signals, calls, meetings). The catalog needs vector search for RAG. HazelJS durable runs can be stored in any Prisma SQL database. Volume is ~2,000 leads and ~1,000 calls a month on one laptop.

## Options considered

1. **Postgres + Prisma + pgvector, database-as-queue** — one data store; migrations; vectors beside relational data.
2. **Postgres + Redis + BullMQ** — proper queues; one more service to run, back up and learn.
3. **Postgres + a hosted vector DB (Pinecone)** — extra account, extra cost, data split across systems.

## Decision

PostgreSQL 17 with pgvector (`pgvector/pgvector:pg17` image), Prisma 7 for schema and migrations, and status columns as the work queue polled by the worker. No Redis.

## Consequences

- One service to back up; vector search and joins in one query.
- Polling adds up to ~30 s latency to background work — acceptable for v1.
- Revisit (add Redis/BullMQ) when the product serves multiple agencies or volume exceeds one worker.
