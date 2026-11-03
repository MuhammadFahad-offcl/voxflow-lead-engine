# 0008. Cached calendar slots; live re-check only on booking

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Muhammad Fahad
- **PRD links:** FR-25, FR-26, NFR-3

## Context

During a live Urdu call, the agent asks for free slots. A Google Calendar lookup on top of speech-to-text and text-to-speech delay can cause an awkward pause.

## Options considered

1. **Live free/busy on every getSlots** — always fresh; adds latency during the call.
2. **In-memory cache refreshed every 5 minutes; live re-check in bookSlot** — instant answer; never double-books.
3. **Cache every 15 minutes** — fewer API calls; more stale offers.

## Decision

The API process keeps free slots (respecting booking settings) in memory, refreshed every 5 minutes and on startup. `getSlots` answers from the cache. `bookSlot` re-checks free/busy live before inserting the event; if taken, it returns the next free slot.

## Consequences

- Occasionally a cached slot turns out taken and the agent offers the next one.
- No new table; the cache rebuilds on restart.
