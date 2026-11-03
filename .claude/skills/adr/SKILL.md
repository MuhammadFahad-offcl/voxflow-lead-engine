---
name: adr
description: Write an Architecture Decision Record when a technical decision is made or changed. Use when choosing between libraries, services or designs, or when a fixed decision in CLAUDE.md needs to change.
---

# Write an ADR

1. Find the next number in `docs/adr/README.md`.
2. Copy `docs/adr/template.md` to `docs/adr/NNNN-short-title.md`.
3. Fill: Context (the forces, with numbers — cost, latency, limits), Options considered (at least 2, with pros/cons), Decision, Consequences (good and bad), Status `Proposed`.
4. If it replaces an ADR: set the old one's status to `Superseded by NNNN` and link both ways.
5. Add the row to the index in `docs/adr/README.md`.
6. If the decision is listed under "Fixed decisions" in `CLAUDE.md` or in `docs/architecture.md`, update those in the same PR.
7. Fahad changes the status to `Accepted` when he merges.

Keep it under one page. Facts (prices, limits) need a source link and the date checked.
