/**
 * Zod schemas for the Apify dataset items the lead source reads: Compass places (pass 1) and
 * Scraperlink reviews by place id (pass 2), as measured in the #9 spike.
 *
 * Serves: FR-5 (discovery), FR-8 (filter fields), FR-10/FR-14 (phone, website, booking links),
 * FR-11 (the 30 newest reviews), ADR-0015 (hybrid two-pass design), CLAUDE.md (validate Apify items).
 * Used by: apps/api/src/adapters/lead-source/apify-items.spec.ts,
 * apps/api/src/pipeline/ideal-client-filter.ts; the Apify adapter in #10.
 */
import { z } from 'zod';

// Apify returns dates as ISO strings; anything Date cannot read is refused here, not at scoring time.
const IsoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'not a date');

/**
 * One place from compass/crawler-google-places, with only the fields the pipeline reads.
 *
 * Does not keep the other ~100 fields (popular times, images, Q&A…): z.object drops unknown keys,
 * so a new or renamed field Compass adds never breaks discovery.
 * Optional fields were missing on some places in the spike (website on 8 of 20) or can be.
 */
export const CompassPlaceItem = z.object({
  placeId: z.string().min(1),
  title: z.string().min(1),
  categoryName: z.string().nullable(),
  categories: z.array(z.string()),
  // Null for a place with no ratings yet; the ideal-client filter treats it as below the minimum.
  totalScore: z.number().min(0).max(5).nullable(),
  reviewsCount: z.number().int().nonnegative(),
  address: z.string().nullable(),
  neighborhood: z.string().nullable().optional(),
  city: z.string().nullable(),
  countryCode: z.string().nullable(),
  location: z.object({ lat: z.number(), lng: z.number() }),
  phone: z.string().optional(),
  // E.164, e.g. "+923000000001": the input of phone normalization (FR-6) and the mobile signal.
  phoneUnformatted: z.string().optional(),
  website: z.string().optional(),
  url: z.url(),
  permanentlyClosed: z.boolean(),
  temporarilyClosed: z.boolean(),
  isAdvertisement: z.boolean(),
  // The listing side of no_online_booking (founder decision on #14): Google "Book" or a booking site.
  bookingLinks: z.array(z.object({ name: z.string(), url: z.url() })),
  reserveTableUrl: z.string().nullable(),
  tableReservationLinks: z.array(z.unknown()),
  openingHours: z.array(z.object({ day: z.string(), hours: z.string() })),
});
/** Parsed Compass place. Shares the schema's name so one import gives both. */
export type CompassPlaceItem = z.infer<typeof CompassPlaceItem>;

/**
 * One review from scraperlink/google-maps-scraper.
 *
 * Does not keep the author's name, id, profile, photo or counts (`author*`, `reviewer*`): CLAUDE.md
 * forbids storing review authors, and z.object drops those keys.
 */
const ScraperlinkReview = z.object({
  reviewId: z.string().min(1),
  // Null for a star-only review: it still counts as one of the 30 and for reviews_unreplied.
  text: z.string().nullable(),
  stars: z.number().int().min(1).max(5),
  publishedAtDate: IsoDate,
  responseFromOwnerText: z.string().nullable(),
  responseFromOwnerDate: IsoDate.nullable(),
  language: z.string(),
  originalLanguage: z.string(),
});

/**
 * One pass-2 item from scraperlink/google-maps-scraper run with `placeIds` and `reviews: true`.
 *
 * Does not repeat the place id on each review: reviews are nested in their place's item.
 */
export const ScraperlinkReviewsItem = z.object({
  placeId: z.string().min(1),
  reviews: z.array(ScraperlinkReview),
});
