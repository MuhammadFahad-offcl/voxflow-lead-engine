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
- **Accepted risk (added 2026-11-10, #11): Lightpanda can reach private addresses.** Every request Lightpanda makes over CDP is checked on the host, but Lightpanda then resolves the name again itself, so the check is not pinned to the address it connects to (DNS rebinding). On Docker Desktop, `host.docker.internal` from the container reaches the laptop's 127.0.0.1 services (API :4000, dashboard :3000); a local test confirmed this. Lightpanda's own CDP port on the container's loopback is exposed the same way. The risk applies only to the Lightpanda path, that is pages with under 200 characters of visible text; the plain GET connects only to the address it checked. Fahad accepted it for v1. It is to be closed after v1 with a proxy or a Docker network rule, under a follow-up issue (#94).
