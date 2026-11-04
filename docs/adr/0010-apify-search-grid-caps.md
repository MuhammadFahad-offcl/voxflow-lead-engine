# 0010. Cap Apify results per search; actor chosen in Cycle 1

- **Status:** Accepted; actor choice superseded by [0015](./0015-apify-hybrid-two-pass.md)
- **Date:** 2026-11-03
- **Deciders:** Muhammad Fahad
- **PRD links:** FR-2, FR-5, FR-7

## Context

The search grid is search terms × areas. Neighbouring areas overlap, and Apify bills every result returned, before our database removes duplicates. At about $3 per 1,000 results the money at risk is small (~$2/month at 30% overlap), but it should be measured.

## Options considered

1. **Grid with a per-search cap + duplicate-rate tracking** — simple; measurable.
2. **One city-wide or polygon search per term** — least overlap; depends on actor support and coverage.
3. **No cap** — unbounded spend.

## Decision

Default cap 100 results per search; each campaign shows its duplicate rate. In Cycle 1, compare 2 actors on one real Lahore dental search for coverage, email enrichment, price and polygon support. If an actor's city-wide/polygon search matches the grid's coverage, use it. Record the chosen actor in this ADR's update (a superseding ADR).

## Consequences

- Duplicate rate above 30% triggers a review of area boundaries.
- The actor is swappable behind `LeadSourcePort`.
