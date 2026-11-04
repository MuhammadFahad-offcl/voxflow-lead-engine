/**
 * Spike for #9: compares two Google Maps actors and a two-pass design (places first, reviews only for
 * the places that pass the ideal-client filter) on one real search, under a hard spend limit.
 *
 * Serves: FR-2, FR-5, FR-8, FR-11, ADR-0010 (issue #9). Not app code: excluded from Knip and the build.
 * Used by: the founder, once, on the laptop:
 *   pnpm exec tsx --env-file=.env scripts/spikes/apify-compare.ts
 * and by Claude with `--dry-run`, which uses invented data and needs no token.
 *
 * Raw results are written only to data/spikes/ (git-ignored). summary.md holds counts, rates, costs
 * and timings only: no names, phones, addresses or review text, so it is safe to paste.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

const SEARCH = 'dental clinic';
const LOCATION = 'DHA, Lahore, Pakistan';
// GeoJSON order is [longitude, latitude]; the ring ends where it starts.
const DHA_POLYGON = {
  type: 'Polygon',
  coordinates: [
    [
      [74.37, 31.43],
      [74.47, 31.43],
      [74.47, 31.51],
      [74.37, 31.51],
      [74.37, 31.43],
    ],
  ],
};
const PLACES = 20;
const REVIEWS = 30;
// Pass 2 fetches reviews for this many survivors per actor: enough to measure, cheap enough to repeat.
const PASS2_PLACES = 8;
// The script refuses a run whose worst case could take the total past this.
const SPEND_LIMIT_USD = 0.9;
const API = 'https://api.apify.com/v2';
const repoRoot = resolve(import.meta.dirname, '../..');

const ACTORS = {
  compass: 'compass~crawler-google-places',
  compassReviews: 'compass~Google-Maps-Reviews-Scraper',
  scraperlink: 'scraperlink~google-maps-scraper',
} as const;

// Apify's own per-run stop, only a backstop: Compass refuses anything below its $0.50 minimum.
const RUN_CHARGE_CAP_USD: Record<string, number> = {
  [ACTORS.compass]: 0.5,
  [ACTORS.compassReviews]: 0.5,
  [ACTORS.scraperlink]: 0.25,
};

const count = (value: unknown, fallback: number): number =>
  typeof value === 'number' ? value : fallback;

/**
 * The most a run can charge, from its input size and each actor's free-plan prices (checked in the
 * Apify Store on 2026-11-04), plus 20%. This, not the cap above, keeps the spike under $1.
 * @param actorId - Actor to run.
 * @param input - The run's input.
 * @returns Worst-case charge in US dollars.
 */
const worstCaseUsd = (actorId: string, input: Json): number => {
  const ids = Array.isArray(input['placeIds']) ? input['placeIds'].length : null;
  const places = ids ?? count(input['maxCrawledPlacesPerSearch'] ?? input['num'], PLACES);
  const reviews = places * count(input['maxReviews'], 0);
  const start = 0.00005;
  let usd = start;
  if (actorId === ACTORS.compass) {
    usd +=
      places * (0.004 + (input['scrapePlaceDetailPage'] === true ? 0.002 : 0)) + reviews * 0.0005;
  } else if (actorId === ACTORS.compassReviews) {
    usd += reviews * 0.0006;
  } else {
    usd += places * (0.0005 + (input['placeDetails'] === true ? 0.00025 : 0));
    usd += input['reviews'] === true ? reviews * 0.00025 : 0;
  }
  return usd * 1.2;
};

type Json = Record<string, unknown>;

interface RunResult {
  status: string;
  runTimeSecs: number;
  costUsd: number;
  // The part of costUsd charged for review events alone, so a pass-2 run that also charges each place
  // again (the crawler) does not inflate the one-pass estimate.
  reviewCostUsd: number;
  chargedEvents: Record<string, number>;
  items: Json[];
}

interface Place {
  placeId: string;
  name: string;
  rating: number | null;
  reviewsCount: number | null;
  categories: string[];
  phone: string;
  website: string;
  hasBookingLink: boolean;
}

interface Review {
  placeId: string;
  publishedAt: string;
  hasOwnerReply: boolean;
}

// ── Field access: the two actors name the same thing differently ────────────────────────────────
const text = (item: Json, keys: string[]): string => {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
};
const numberOf = (item: Json, keys: string[]): number | null => {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'number') return value;
  }
  return null;
};
const isFilled = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return value !== null && typeof value === 'object';
};

const toPlace = (item: Json): Place => {
  const categories = Array.isArray(item['categories'])
    ? item['categories'].filter((c): c is string => typeof c === 'string')
    : [text(item, ['categoryName', 'category', 'type'])].filter((c) => c !== '');
  return {
    placeId: text(item, ['placeId', 'place_id', 'googlePlaceId']),
    name: text(item, ['title', 'name']),
    rating: numberOf(item, ['totalScore', 'rating']),
    reviewsCount: numberOf(item, ['reviewsCount', 'ratingCount', 'reviews_count']),
    categories,
    phone: text(item, ['phoneUnformatted', 'phone', 'phoneNumber']),
    website: text(item, ['website', 'url_website']),
    hasBookingLink: [
      'bookingLinks',
      'reserveTableUrl',
      'tableReservationLinks',
      'reservationLinks',
    ].some((key) => isFilled(item[key])),
  };
};

const OWNER_REPLY_KEYS = ['responseFromOwnerText', 'ownerResponse', 'ownerAnswer', 'response'];
const toReview = (review: Json, placeId: string): Review => ({
  placeId: text(review, ['placeId']) || placeId,
  publishedAt: text(review, ['publishedAtDate', 'publishedAt', 'date', 'isoDate']),
  hasOwnerReply: OWNER_REPLY_KEYS.some((key) => isFilled(review[key])),
});

// Reviews come nested in place items (crawler, Scraperlink) or one item per review (Reviews Scraper).
const reviewsOf = (items: Json[]): Review[] =>
  items.flatMap((item) => {
    if (Array.isArray(item['reviews'])) {
      return (item['reviews'] as Json[]).map((r) => toReview(r, text(item, ['placeId'])));
    }
    const isReviewItem = 'reviewId' in item || 'text' in item || 'stars' in item;
    return isReviewItem ? [toReview(item, '')] : [];
  });

// ── Ideal-client filter: the niche file's rules (FR-8), minus the chain rule ────────────────────
interface IdealClient {
  minRating: number;
  minReviewCount: number;
  excludeNameKeywords: string[];
  categoryKeywords: string[];
}
const loadIdealClient = async (): Promise<IdealClient> => {
  const niche = JSON.parse(
    await readFile(join(repoRoot, 'config/niches/dental-clinic.json'), 'utf8'),
  ) as { idealClient: Omit<IdealClient, 'categoryKeywords'>; categoryKeywords: string[] };
  return { ...niche.idealClient, categoryKeywords: niche.categoryKeywords };
};
const passesFilter = (place: Place, rules: IdealClient): boolean => {
  const name = place.name.toLowerCase();
  const category = place.categories.join(' ').toLowerCase();
  return (
    (place.rating ?? 0) >= rules.minRating &&
    (place.reviewsCount ?? 0) >= rules.minReviewCount &&
    !rules.excludeNameKeywords.some((word) => name.includes(word)) &&
    rules.categoryKeywords.some((word) => category.includes(word))
  );
};

// ── Apify client (real) and an invented stand-in for --dry-run ──────────────────────────────────
type RunActor = (actorId: string, input: Json) => Promise<RunResult>;

const realRunner = (token: string): RunActor => {
  const call = async (path: string, init?: RequestInit): Promise<Json> => {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      // Apify explains a refusal in { error: { type, message } }; it never echoes the token.
      const body = (await response.json().catch(() => ({}))) as { error?: Json };
      const reason = [body.error?.['type'], body.error?.['message']].filter(Boolean).join(': ');
      const suffix = reason === '' ? '' : ' (' + reason + ')';
      throw new Error(
        `Apify ${path.split('?')[0] ?? ''}: HTTP ${String(response.status)}${suffix}`,
      );
    }
    return (await response.json()) as Json;
  };
  return async (actorId, input) => {
    const started = (
      await call(
        `/acts/${actorId}/runs?maxTotalChargeUsd=${String(RUN_CHARGE_CAP_USD[actorId] ?? 0.5)}&timeout=900`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      )
    )['data'] as Json;
    let run = started;
    while (['READY', 'RUNNING'].includes(String(run['status']))) {
      await new Promise((done) => setTimeout(done, 5000));
      run = (await call(`/actor-runs/${String(started['id'])}`))['data'] as Json;
    }
    const items = (await call(
      `/datasets/${String(run['defaultDatasetId'])}/items?clean=true&format=json`,
    )) as unknown as Json[];
    const stats = (run['stats'] ?? {}) as Json;
    // The run usually carries its price list; if not, the actor's public one is the same list.
    if (run['pricingInfo'] === undefined) {
      const actor = (await call(`/acts/${actorId}`))['data'] as Json;
      const infos = actor['pricingInfos'];
      run = { ...run, pricingInfo: Array.isArray(infos) ? infos.at(-1) : undefined };
    }
    return {
      status: String(run['status']),
      runTimeSecs: Number(stats['runTimeSecs'] ?? 0),
      costUsd: chargeOf(run),
      reviewCostUsd: chargeOf(run, (event) => event.includes('review')),
      chargedEvents: (run['chargedEventCounts'] ?? {}) as Record<string, number>,
      items,
    };
  };
};

/**
 * What the user pays for a pay-per-event run, at the plan tier in APIFY_PLAN_TIER (FREE when unset).
 * @param run - Finished run with chargedEventCounts and pricingInfo.
 * @param include - Which charge events to count; all of them by default.
 * @returns The charge in US dollars.
 */
const chargeOf = (run: Json, include: (event: string) => boolean = () => true): number => {
  const counts = (run['chargedEventCounts'] ?? {}) as Record<string, number>;
  const pricing = (run['pricingInfo'] ?? {}) as Json;
  const events = ((pricing['pricingPerEvent'] ?? {}) as Json)['actorChargeEvents'] as
    | Record<
        string,
        {
          eventPriceUsd?: number;
          eventTieredPricingUsd?: Record<string, { tieredEventPriceUsd: number }>;
        }
      >
    | undefined;
  const tier = process.env['APIFY_PLAN_TIER'] ?? 'FREE';
  return Object.entries(counts).reduce((sum, [event, count]) => {
    if (!include(event)) return sum;
    const price = events?.[event];
    const unit =
      price?.eventTieredPricingUsd?.[tier]?.tieredEventPriceUsd ?? price?.eventPriceUsd ?? 0;
    return sum + unit * count;
  }, 0);
};

const dryRunner: RunActor = (actorId, input) => {
  const ids = Array.isArray(input['placeIds']) ? (input['placeIds'] as string[]) : [];
  const fakeReviews = (placeId: string, n: number): Json[] =>
    Array.from({ length: n }, (_, i) => ({
      placeId,
      reviewId: `${placeId}-r${String(i)}`,
      text: 'Fictional review',
      publishedAtDate: new Date(Date.UTC(2026, 9, 30 - i)).toISOString(),
      responseFromOwnerText: i % 3 === 0 ? 'Fictional reply' : null,
    }));
  if (ids.length === 0) {
    const items = Array.from({ length: PLACES }, (_, i) => ({
      placeId: `fake-${actorId.slice(0, 4)}-${String(i % 18)}`,
      title: i === 3 ? 'Fictional Teaching Hospital' : `Fictional Dental Clinic ${String(i)}`,
      totalScore: i === 5 ? 3.6 : 4.5,
      reviewsCount: i === 7 ? 12 : 80,
      categories: ['Dental clinic'],
      phoneUnformatted: i % 4 === 0 ? '' : `+9230000000${String(i).padStart(2, '0')}`,
      website: i % 2 === 0 ? `https://clinic${String(i)}.example.com` : '',
      bookingLinks: i % 5 === 0 ? ['https://booking.example.com'] : [],
    }));
    return Promise.resolve({
      status: 'SUCCEEDED',
      runTimeSecs: 42,
      costUsd: PLACES * 0.004,
      reviewCostUsd: 0,
      chargedEvents: { 'place-scraped': PLACES },
      items,
    });
  }
  const perItem = actorId === ACTORS.compassReviews;
  const items = perItem
    ? ids.flatMap((id) => fakeReviews(id, REVIEWS))
    : ids.map((id) => ({ placeId: id, reviews: fakeReviews(id, REVIEWS) }));
  // Invented prices: the place-plus-review actors also charge each place again.
  const reviewCostUsd = ids.length * REVIEWS * 0.0005;
  return Promise.resolve({
    status: 'SUCCEEDED',
    runTimeSecs: 30,
    costUsd: reviewCostUsd + (perItem ? 0 : ids.length * 0.004),
    reviewCostUsd,
    chargedEvents: {
      'review-scraped': ids.length * REVIEWS,
      ...(perItem ? {} : { 'place-scraped': ids.length }),
    },
    items,
  });
};

// ── Measuring ──────────────────────────────────────────────────────────────────────────────────
const pct = (part: number, whole: number): string =>
  whole === 0 ? 'n/a' : `${String(Math.round((part / whole) * 100))}%`;
const usd = (value: number): string => `$${value.toFixed(4)}`;

interface Pass1 {
  label: string;
  run: RunResult;
  places: Place[];
  survivors: Place[];
}
interface Pass2 {
  label: string;
  pass1: string;
  requested: number;
  run: RunResult;
  reviews: Review[];
}

const reliability = (run: RunResult, returned: number, wanted: number): string => {
  if (run.status !== 'SUCCEEDED') return `**${run.status}**`;
  return returned < wanted ? `partial (${String(returned)}/${String(wanted)})` : 'ok';
};

// Checked place by place: the list restarts at each place's newest review.
const isNewestFirst = (reviews: Review[]): boolean => {
  const byPlace = Map.groupBy(reviews, (r) => r.placeId);
  return [...byPlace.values()].every((list) => {
    const dated = list.filter((r) => r.publishedAt !== '').map((r) => Date.parse(r.publishedAt));
    return dated.every((time, i) => i === 0 || time <= (dated[i - 1] ?? time));
  });
};

const summarize = (pass1: Pass1[], pass2: Pass2[], spent: number): string => {
  const lines: string[] = [
    `# Apify spike summary (#9)`,
    ``,
    `Search: "${SEARCH}" in "${LOCATION}" (Scraperlink: that text; Compass: a polygon around DHA phases 1-6), ${String(PLACES)} places; pass 2: ${String(REVIEWS)} newest reviews for up to ${String(PASS2_PLACES)} survivors. Tier: ${process.env['APIFY_PLAN_TIER'] ?? 'FREE'}. Total spent: ${usd(spent)}.`,
    ``,
    `## Pass 1: places only`,
    ``,
    `| Actor | Status | Places | Run time | Cost | Cost / 100 places | Phone | Mobile +923 | Website | Category | Booking link on listing | Filtered out | Survivors |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const p of pass1) {
    const n = p.places.length;
    const count = (test: (place: Place) => boolean) => p.places.filter(test).length;
    lines.push(
      `| ${p.label} | ${reliability(p.run, n, PLACES)} | ${String(n)} | ${String(Math.round(p.run.runTimeSecs))}s | ${usd(p.run.costUsd)} | ${usd(n === 0 ? 0 : (p.run.costUsd / n) * 100)} | ${pct(
        count((x) => x.phone !== ''),
        n,
      )} | ${pct(
        count((x) => x.phone.replaceAll(/\D/g, '').startsWith('923')),
        n,
      )} | ${pct(
        count((x) => x.website !== ''),
        n,
      )} | ${pct(
        count((x) => x.categories.length > 0),
        n,
      )} | ${pct(
        count((x) => x.hasBookingLink),
        n,
      )} | ${pct(n - p.survivors.length, n)} | ${String(p.survivors.length)} |`,
    );
  }
  const [a, b] = pass1;
  if (a && b) {
    const idsA = new Set(a.places.map((x) => x.placeId));
    const both = b.places.filter((x) => idsA.has(x.placeId)).length;
    const union = new Set([...idsA, ...b.places.map((x) => x.placeId)]).size;
    lines.push(
      ``,
      `Overlap: ${String(both)} places found by both; ${String(union)} distinct in total (${a.label} found ${pct(idsA.size, union)}, ${b.label} ${pct(b.places.length, union)}).`,
    );
  }
  lines.push(
    ``,
    `## Pass 2: reviews for survivors`,
    ``,
    `| Option | On pass 1 of | Status | Places asked | Reviews | Per place | Owner reply | Dated | Newest first | Run time | Cost | Cost / review |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  );
  for (const p of pass2) {
    const n = p.reviews.length;
    const placesWithReviews = new Set(p.reviews.map((r) => r.placeId)).size;
    lines.push(
      `| ${p.label} | ${p.pass1} | ${reliability(p.run, placesWithReviews, p.requested)} | ${String(p.requested)} | ${String(n)} | ${(n / Math.max(1, p.requested)).toFixed(1)} | ${pct(p.reviews.filter((r) => r.hasOwnerReply).length, n)} | ${pct(p.reviews.filter((r) => r.publishedAt !== '').length, n)} | ${isNewestFirst(p.reviews) ? 'yes' : 'no'} | ${String(Math.round(p.run.runTimeSecs))}s | ${usd(p.run.costUsd)} | ${usd(n === 0 ? 0 : p.run.costUsd / n)} |`,
    );
  }
  lines.push(
    ``,
    `## Cost per 100 qualified leads (extrapolated from the measured unit costs)`,
    ``,
    `| Design | Pass 1 | Pass 2 | Places to search | Pass 1 cost | Reviews cost | Total per 100 qualified |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
  );
  for (const p2 of pass2) {
    const p1 = pass1.find((p) => p.label === p2.pass1);
    if (!p1 || p1.places.length === 0 || p1.survivors.length === 0 || p2.reviews.length === 0)
      continue;
    const placeCost = p1.run.costUsd / p1.places.length;
    // Two-pass pays the whole pass-2 run per survivor; one-pass would pay only the review events.
    const pass2CostPerPlace = p2.run.costUsd / p2.requested;
    const reviewOnlyPerPlace = p2.run.reviewCostUsd / p2.requested;
    const placesToSearch = 100 / (p1.survivors.length / p1.places.length);
    const twoPass = placesToSearch * placeCost + 100 * pass2CostPerPlace;
    const onePass = placesToSearch * (placeCost + reviewOnlyPerPlace);
    lines.push(
      `| two-pass | ${p1.label} | ${p2.label} | ${String(Math.round(placesToSearch))} | ${usd(placesToSearch * placeCost)} | ${usd(100 * pass2CostPerPlace)} | **${usd(twoPass)}** |`,
      `| one-pass (reviews for every place) | ${p1.label} | ${p2.label} | ${String(Math.round(placesToSearch))} | ${usd(placesToSearch * placeCost)} | ${usd(placesToSearch * reviewOnlyPerPlace)} | ${usd(onePass)} |`,
    );
  }
  lines.push(
    ``,
    `All places in this spike were new; in the app, pass 2 also skips place ids already stored.`,
    ``,
    `## Charged events per run (to recompute costs)`,
    ``,
  );
  for (const p of [
    ...pass1.map((x) => [`pass 1 ${x.label}`, x.run] as const),
    ...pass2.map((x) => [`pass 2 ${x.label} on ${x.pass1}`, x.run] as const),
  ]) {
    lines.push(`- ${p[0]}: ${JSON.stringify(p[1].chargedEvents)}`);
  }
  return lines.join('\n') + '\n';
};

// ── Main ───────────────────────────────────────────────────────────────────────────────────────
const dryRun = process.argv.includes('--dry-run');
const flag = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
// --only=compass reruns just one actor's pass 1 and the pass-2 options on its survivors.
const only = flag('only');
// --already-spent=0.19 counts an earlier run against the same $0.90 total, so the spike stays under $1.
const alreadySpent = Number(flag('already-spent') ?? 0);
// Trimmed, because a stray space or line ending copied into .env makes Apify answer 401.
const token = process.env['APIFY_TOKEN']?.trim();
if (!dryRun && (token === undefined || token === '')) {
  process.stderr.write(
    'APIFY_TOKEN is not set. Run with: pnpm exec tsx --env-file=.env scripts/spikes/apify-compare.ts\n',
  );
  process.exit(1);
}
// Checked once before any run, so a bad token stops here instead of failing every run one by one.
if (!dryRun && token !== undefined) {
  const me = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (me.status === 401) {
    process.stderr.write(
      'Apify refused APIFY_TOKEN (HTTP 401). Copy the token from Apify Console → Settings → ' +
        'API & Integrations → Personal API tokens (it starts with apify_api_) into .env as ' +
        'APIFY_TOKEN=apify_api_..., with no quotes or spaces. Nothing was run or charged.\n',
    );
    process.exit(1);
  }
}
const runActor = dryRun || token === undefined ? dryRunner : realRunner(token);
const outDir = join(
  repoRoot,
  'data/spikes',
  `${new Date().toISOString().replaceAll(':', '-')}${dryRun ? '-dry-run' : ''}`,
);
await mkdir(outDir, { recursive: true });

let spent = alreadySpent;
const run = async (name: string, actorId: string, input: Json): Promise<RunResult> => {
  const worst = worstCaseUsd(actorId, input);
  if (spent + worst > SPEND_LIMIT_USD)
    throw new Error(
      `Spend limit: ${usd(spent)} spent; this run could cost up to ${usd(worst)}, passing ${usd(SPEND_LIMIT_USD)}`,
    );
  process.stdout.write(`running ${name} (at most ${usd(worst)})…\n`);
  const result = await runActor(actorId, input);
  spent += result.costUsd;
  await writeFile(join(outDir, `${name}.json`), JSON.stringify(result, null, 2));
  process.stdout.write(
    `  ${result.status}, ${String(result.items.length)} items, ${usd(result.costUsd)} (total ${usd(spent)})\n`,
  );
  return result;
};

const rules = await loadIdealClient();
const pass1: Pass1[] = [];
const pass2: Pass2[] = [];
const pass1Inputs: [string, string, Json][] = [
  [
    'compass',
    ACTORS.compass,
    {
      searchStringsArray: [SEARCH],
      // Compass geocodes free text with OpenStreetMap, which reads "DHA, Lahore, Pakistan" as one
      // small residential patch, and the first run found 0 places. This polygon covers DHA phases
      // 1-6, from the bounding boxes OpenStreetMap returns for DHA and its phases.
      customGeolocation: DHA_POLYGON,
      maxCrawledPlacesPerSearch: PLACES,
      language: 'en',
      // Detail pages carry the booking links; reviews, images and contacts stay off in pass 1.
      scrapePlaceDetailPage: true,
      maxReviews: 0,
      maxImages: 0,
      scrapeContacts: false,
    },
  ],
  [
    'scraperlink',
    ACTORS.scraperlink,
    {
      query: [SEARCH],
      location: LOCATION,
      num: PLACES,
      languages: ['en'],
      placeDetails: true,
      reviews: false,
      maxImages: 0,
    },
  ],
];
// Pass 2 follows: an actor skipped here has no survivors, so its pass-2 options are skipped too.
for (const [label, actorId, input] of pass1Inputs.filter(
  ([l]) => only === undefined || l === only,
)) {
  try {
    const result = await run(`pass1-${label}`, actorId, input);
    const places = result.items.map(toPlace).filter((p) => p.placeId !== '');
    pass1.push({
      label,
      run: result,
      places,
      survivors: places.filter((p) => passesFilter(p, rules)),
    });
  } catch (error) {
    process.stdout.write(
      `  ${label} pass 1 failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

const pass2Options: [string, string, (ids: string[]) => Json, string][] = [
  [
    'compass crawler + reviews',
    ACTORS.compass,
    (ids) => ({
      placeIds: ids,
      maxReviews: REVIEWS,
      reviewsSort: 'newest',
      scrapeReviewsPersonalData: false,
      scrapePlaceDetailPage: false,
      maxImages: 0,
      language: 'en',
    }),
    'compass',
  ],
  [
    'compass Reviews Scraper',
    ACTORS.compassReviews,
    (ids) => ({
      placeIds: ids,
      maxReviews: REVIEWS,
      reviewsSort: 'newest',
      personalData: false,
      language: 'en',
    }),
    'compass',
  ],
  [
    'scraperlink + reviews',
    ACTORS.scraperlink,
    (ids) => ({
      placeIds: ids,
      reviews: true,
      maxReviews: REVIEWS,
      reviewsSort: 'newest',
      placeDetails: false,
      maxImages: 0,
    }),
    'scraperlink',
  ],
  [
    'compass Reviews Scraper',
    ACTORS.compassReviews,
    (ids) => ({
      placeIds: ids,
      maxReviews: REVIEWS,
      reviewsSort: 'newest',
      personalData: false,
      language: 'en',
    }),
    'scraperlink',
  ],
];
for (const [label, actorId, inputFor, on] of pass2Options) {
  const p1 = pass1.find((p) => p.label === on);
  const ids = (p1?.survivors ?? []).slice(0, PASS2_PLACES).map((p) => p.placeId);
  if (ids.length === 0) continue;
  try {
    const result = await run(
      `pass2-${label.replaceAll(/\W+/g, '-')}-on-${on}`,
      actorId,
      inputFor(ids),
    );
    pass2.push({
      label,
      pass1: on,
      requested: ids.length,
      run: result,
      reviews: reviewsOf(result.items),
    });
  } catch (error) {
    process.stdout.write(
      `  ${label} on ${on} failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

const summary = summarize(pass1, pass2, spent);
await writeFile(join(outDir, 'summary.md'), summary);
process.stdout.write(`\n${summary}\nSaved to ${outDir} (git-ignored). Paste summary.md only.\n`);
