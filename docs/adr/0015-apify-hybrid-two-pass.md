# 0015. Apify: Compass for places, Scraperlink for reviews, in two passes

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Muhammad Fahad
- **PRD links:** FR-2, FR-5, FR-7, FR-8, FR-11, FR-14; supersedes the pending actor choice in ADR-0010

## Context

ADR-0010 capped results per search and left the actor to a Cycle 1 spike (#9). The spike ran one "dental clinic" search in DHA Lahore on 2026-11-04, 20 places per actor, on the Apify free plan, with `scripts/spikes/apify-compare.ts`. Total spend was $0.60. Raw results stayed in the git-ignored `data/spikes/`.

Reviews, not places, are the main cost. So the spike also measured a two-pass design: places first, then the 30 newest reviews (FR-11) only for places that pass the ideal-client filter (FR-8).

| Measured (free plan)                 | Compass `crawler-google-places`      | Scraperlink `google-maps-scraper` |
| ------------------------------------ | ------------------------------------ | --------------------------------- |
| Places, cost per 100 (with details)  | $0.60                                | $0.025                            |
| Phone / Pakistani mobile / website   | 95% / 90% / 60%                      | 95% / 90% / 80%                   |
| Listing booking link                 | 20% (`bookingLinks`)                 | 0%                                |
| Reviews, cost per review (30 newest) | $0.0006 (crawler or Reviews Scraper) | $0.00026                          |
| Owner reply on the same 8 clinics    | 12% (Reviews Scraper)                | 12%                               |
| Run time, places / reviews           | 31 s / 25–34 s                       | 7 s / 39 s                        |

Found along the way:

- **Scraperlink misses listing booking links.** Of 8 clinics both actors found, Compass returned a booking link for 2 and Scraperlink for none, although its items carry a `bookingLinks` field. Alone, it would award `no_online_booking`'s 8 points to clinics that do book online through their listing.
- **Compass needs a polygon for Pakistani neighbourhoods.** It geocodes the location text with OpenStreetMap, which reads "DHA, Lahore, Pakistan" as one small residential patch, and the run found 0 places. A `customGeolocation` polygon over DHA phases 1–6 found 20.
- **Compass refuses a per-run charge limit below $0.50** (`max-total-charge-usd-below-minimum`).
- **Scraperlink's reviews are complete:** on the same clinics it returned the same owner-reply share as the Compass Reviews Scraper, newest first and dated, at half the price.

## Options considered

1. **All Scraperlink:** about $0.81 per 100 qualified leads. The booking check falls back to the website only, which the founder allowed on #14.
2. **All Compass:** about $2.36 per 100 qualified leads. One proven vendor (47,500 users a month).
3. **Hybrid:** Compass for places, Scraperlink for reviews by place id. About $1.42 per 100 qualified leads, with the full booking check.

## Decision

Option 3, chosen by the founder on 2026-11-04.

- **Pass 1, discovery:** `compass~crawler-google-places`. It takes one `customGeolocation` polygon per campaign area, `scrapePlaceDetailPage: true` (needed for booking links), and no reviews, images or contact add-ons. The cap stays `maxCrawledPlacesPerSearch` = 100 (ADR-0010). Items are validated with `CompassPlaceItem`.
- **Filter:** the ideal-client filter (FR-8) and dedupe (FR-7) run on pass-1 data.
- **Pass 2, reviews:** `scraperlink~google-maps-scraper` with `placeIds`, `reviews: true`, `maxReviews: 30` and `reviewsSort: "newest"`. It runs only for places that survived the filter and are not already stored from an earlier campaign. Items are validated with `ScraperlinkReviewsItem`, which drops review authors.
- **Booking:** `no_online_booking` reads the listing side from Compass's `bookingLinks` (and `reserveTableUrl`). If Compass ever stops returning them, the signal falls back to the website only and notes "Maps listing not checked" in its evidence (#14).

## Consequences

- **Cost:**
  - About **$1.42 per 100 qualified leads**: $0.63 for pass 1 (about 105 places at 5% filtered) and $0.79 for reviews.
  - About **$28 a month at 2,000 qualified leads**, against the PRD's earlier estimate of about $6 for Apify.
  - A full campaign of 8 searches × 100 places costs about $11.
- **Two-pass saves money in proportion to what pass 1 removes:**
  - places filtered out;
  - duplicates from overlapping areas;
  - places already stored from earlier campaigns.

  In the 20-place sample the filter removed only 0–5%, so the saving there was small. Campaign duplicate rates (FR-2) will show the real figure.

- **Two vendors behind one port:**
  - `LeadSourcePort` (#10) gets a real adapter that calls both actors, and one fake that reads `fixtures/places` and `fixtures/reviews`.
  - Scraperlink is a small actor (about 900 users a month). If it degrades, the Compass Reviews Scraper is a drop-in pass-2 replacement at about twice the review cost.
- **Polygons, not names:**
  - Campaign areas need a polygon each, from OpenStreetMap's boundary for the area where one exists.
  - Whether one city-wide polygon search is cheaper than per-area searches with overlap (FR-2) is unmeasured; it needs a full-size run.
- **Measurement limits:** one search, 20 places, and the free-plan tier prices of 2026-11-04. Revisit after the first real campaign, or if either actor's prices or fields change.
