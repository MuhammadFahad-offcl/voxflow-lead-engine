# 0004. Tiered website reading with Lightpanda fallback

- **Status:** Accepted
- **Date:** 2026-11-02
- **Deciders:** Muhammad Fahad
- **PRD links:** FR-9, FR-10

## Context

Most Lahore clinic sites are simple WordPress or HTML pages. Some render content only with JavaScript. Some block automated readers with anti-bot challenges, which no free headless browser reliably passes.

## Options considered

1. **Plain fetch → Lightpanda → mark unreadable** — fast and cheap for most sites; JS sites covered; blocked sites skipped.
2. **Full Chromium (Playwright) for every site** — heavy on RAM and slow on a laptop.
3. **Plain fetch only** — misses JS-only sites.

## Decision

Tier 1 plain HTTP fetch + Cheerio. Tier 2 Lightpanda (Docker, CDP via `puppeteer-core`) when visible text is under 200 characters. Tier 3 `UNREADABLE` on 403, challenge page or error. Telemetry disabled (`LIGHTPANDA_DISABLE_TELEMETRY=true`). Homepage + one contact page; robots.txt respected; one request per domain at a time.

## Consequences

- Lightpanda is beta: crashes are caught and the lead falls back to `UNREADABLE`.
- The dashboard shows counts per tier so we can see whether Lightpanda earns its place.
