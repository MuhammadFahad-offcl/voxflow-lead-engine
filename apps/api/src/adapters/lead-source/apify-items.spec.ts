/**
 * Unit tests of the Apify item schemas against the fictional fixtures.
 *
 * Serves: FR-5, FR-7, FR-8, FR-11, ADR-0015; issue #9 ("a Zod schema … with a fictional fixture").
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CompassPlaceItem, ScraperlinkReviewsItem } from './apify-items.js';

const fixture = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../fixtures', path), 'utf8'));

const places = z.array(CompassPlaceItem).parse(fixture('places/dental-lahore.json'));
const reviewItems = z.array(ScraperlinkReviewsItem).parse(fixture('reviews/dental-lahore.json'));
const reviews = reviewItems.flatMap((item) => item.reviews);
const texts = reviews.map((review) => review.text ?? '');

// Proves the place fixture has the Compass item shape and the cases the pipeline must handle.
describe('CompassPlaceItem fixture', () => {
  it('holds 12 places with one duplicate place id, for dedupe (FR-7)', () => {
    expect(places).toHaveLength(12);
    expect(new Set(places.map((place) => place.placeId)).size).toBe(11);
  });

  it('holds a hospital and a 3.6-rated clinic that the ideal-client filter must drop (FR-8)', () => {
    expect(places.some((place) => /hospital|teaching/i.test(place.title))).toBe(true);
    // Below the niche's 4.0 minimum, by a range rather than float equality.
    expect(
      places.some((place) => (place.totalScore ?? 0) > 3.5 && (place.totalScore ?? 0) < 3.7),
    ).toBe(true);
  });

  it('holds places with and without a website and a listing booking link (#14 rule)', () => {
    expect(places.some((place) => place.website === undefined)).toBe(true);
    expect(places.some((place) => place.bookingLinks.length > 0)).toBe(true);
    expect(places.some((place) => place.bookingLinks.length === 0)).toBe(true);
  });

  it('uses only invented phone numbers and example.com sites', () => {
    for (const place of places) {
      expect(place.phoneUnformatted).toMatch(/^\+92300000\d{4}$/);
      for (const url of [place.website, ...place.bookingLinks.map((link) => link.url)]) {
        if (url !== undefined) expect(new URL(url).hostname).toMatch(/(^|\.)example\.com$/);
      }
    }
  });
});

// Proves the review fixture has the Scraperlink shape and covers each review signal's topics.
describe('ScraperlinkReviewsItem fixture', () => {
  it('belongs to places in the place fixture', () => {
    const ids = new Set(places.map((place) => place.placeId));

    expect(reviewItems.every((item) => ids.has(item.placeId))).toBe(true);
  });

  it.each([
    [
      'an unanswered phone',
      /picked up the phone|phone koi nahi|answers the phone|reach on the phone/i,
    ],
    ['a long wait', /waited|intezar/i],
    ['no online booking', /no online booking|online booking ka koi option nahi/i],
    ['a positive visit', /gentle|painless|bohat achay|excellent/i],
  ])('includes a review about %s', (_topic, pattern) => {
    expect(texts.some((text) => pattern.test(text))).toBe(true);
  });

  it('includes Roman Urdu reviews, star-only reviews and owner replies', () => {
    expect(reviews.some((review) => review.language === 'ur')).toBe(true);
    expect(reviews.some((review) => review.text === null)).toBe(true);
    expect(reviews.some((review) => review.responseFromOwnerText !== null)).toBe(true);
  });
});

// Proves review authors never get past the schema (CLAUDE.md), and a bad date is refused.
describe('ScraperlinkReviewsItem', () => {
  const review = {
    reviewId: 'fictional-review-1',
    text: 'Fictional',
    stars: 5,
    publishedAtDate: '2026-10-01T10:00:00.000Z',
    responseFromOwnerText: null,
    responseFromOwnerDate: null,
    language: 'en',
    originalLanguage: 'en',
  };

  it('drops the author fields that Scraperlink returns', () => {
    const parsed = ScraperlinkReviewsItem.parse({
      placeId: 'fictional-place',
      reviews: [
        { ...review, author: 'Fictional Person', reviewerUrl: 'https://maps.example.com/u/1' },
      ],
    });

    expect(parsed.reviews[0]).not.toHaveProperty('author');
    expect(parsed.reviews[0]).not.toHaveProperty('reviewerUrl');
  });

  it('refuses a review whose date cannot be read', () => {
    const result = ScraperlinkReviewsItem.safeParse({
      placeId: 'fictional-place',
      reviews: [{ ...review, publishedAtDate: 'a month ago' }],
    });

    expect(result.success).toBe(false);
  });
});
