/**
 * The lead page's view: header, score breakdown and evidence (cited signals highlighted), the
 * Solution card or why there is none, and the stored reviews. No script block: the script agent
 * (#20) does not exist yet, and the page does not hint that it does.
 *
 * Serves: FR-30 (lead detail), FR-14 (every point has evidence), FR-17 (the chosen service, its
 * reason and cited signals; NO_STRONG_SIGNAL, NEEDS_REVIEW), FR-32, US-5; issue #24.
 * Used by: apps/web/app/leads/[id]/page.tsx, ./lead-detail.spec.tsx.
 */
import type { LeadDetail } from '@voxflow/shared';
import Link from 'next/link';
import { karachiTime } from '../../../lib/format';
import { safeHref } from '../../../lib/safe-href';
import { LeadEvidence } from '../../campaigns/[id]/lead-evidence';

type Signal = LeadDetail['signals'][number];
type Review = LeadDetail['reviews'][number];

/**
 * Renders the whole lead page below the site layout.
 * @param props - The lead.
 * @param props.lead - The lead as `GET /leads/:id` returns it.
 * @returns The page body.
 */
export function LeadDetailView({ lead }: Readonly<{ lead: LeadDetail }>) {
  const byId = new Map(lead.signals.map((signal) => [signal.id, signal]));
  // A cited id missing from the signals (the lead was scored again) highlights nothing.
  const cited = new Set((lead.solution?.signalIds ?? []).flatMap((id) => byId.get(id)?.key ?? []));
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <Header lead={lead} />
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Score and evidence</h2>
        <LeadEvidence lead={lead} cited={cited} />
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Solution</h2>
        <SolutionPanel lead={lead} byId={byId} />
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Reviews ({lead.reviews.length} stored)</h2>
        <ReviewList reviews={lead.reviews} />
      </section>
    </main>
  );
}

/**
 * The lead's name, place, contact, score and status, with a link back to its campaign.
 * @param props - The lead.
 * @param props.lead - The lead detail.
 * @returns The header.
 */
function Header({ lead }: Readonly<{ lead: LeadDetail }>) {
  // Only an http(s) website becomes a link: a scraped `javascript:` URL is shown as text.
  const website = lead.website === null ? null : safeHref(lead.website);
  return (
    <header className="space-y-1">
      <Link href={`/campaigns/${lead.campaignId}`} className="text-sm underline">
        Back to the campaign
      </Link>
      <h1 className="text-2xl font-semibold">{lead.name}</h1>
      <p className="text-sm text-slate-600">
        {lead.area ?? 'No area'} · {lead.phone ?? 'No phone'} ({lead.phoneType.toLowerCase()}) ·{' '}
        {website === null ? (
          (lead.website ?? 'No website')
        ) : (
          <a href={website} className="underline" target="_blank" rel="noreferrer">
            {lead.website}
          </a>
        )}
      </p>
      <p className="text-sm">
        Score <span className="font-semibold">{lead.score ?? '—'}</span> · Tier{' '}
        <span className="font-semibold">{lead.tier ?? '—'}</span> · Status{' '}
        <span className="font-semibold">{lead.status}</span>
      </p>
    </header>
  );
}

/**
 * The Solution card for a pick, or one sentence saying why there is no pick, per lead state.
 * @param props - The lead and its signals by id.
 * @param props.lead - The lead detail.
 * @param props.byId - The lead's current signals, by `Signal.id`.
 * @returns The card or the sentence.
 */
function SolutionPanel({
  lead,
  byId,
}: Readonly<{ lead: LeadDetail; byId: ReadonlyMap<string, Signal> }>) {
  const { solution } = lead;
  if (solution !== null) {
    return (
      <div className="space-y-2 rounded border bg-white px-4 py-3 text-sm">
        <p className="text-base font-semibold">{solution.serviceName}</p>
        <p>{solution.reason}</p>
        <ul className="space-y-1">
          {solution.signalIds.map((id) => {
            const signal = byId.get(id);
            return signal === undefined ? (
              <li key={id} className="text-slate-500">
                Signal no longer available (the lead was scored again after this pick)
              </li>
            ) : (
              <li key={id}>
                <span className="mr-2 text-xs uppercase text-slate-500">{signal.key}</span>
                {signal.evidence}
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-slate-500">Picked by {solution.model}</p>
      </div>
    );
  }
  return <p className="rounded border bg-white px-4 py-3 text-sm">{noPickReason(lead)}</p>;
}

/**
 * Says why a lead has no Solution, from its status and tier.
 *
 * Does not quote the agent's reason for NO_STRONG_SIGNAL: it is not stored.
 * @param lead - A lead with no Solution.
 * @returns One sentence for the founder.
 */
function noPickReason(lead: LeadDetail): string {
  switch (lead.status) {
    case 'NO_STRONG_SIGNAL': {
      return 'No service picked: the solution agent found no evidence-backed problem to pitch.';
    }
    case 'NEEDS_REVIEW': {
      return 'No service picked: the solution agent’s answer failed the catalog and signal checks twice, so this lead needs your review.';
    }
    case 'FILTERED_OUT': {
      return `No service picked: the ideal-client filter dropped this lead (${lead.filterReason ?? 'no reason stored'}).`;
    }
    case 'FAILED': {
      return 'No service yet: a step failed before the solution agent ran (see the error above).';
    }
    default: {
      return lead.tier === 'COLD'
        ? 'No service picked: COLD leads stop after scoring.'
        : 'No service yet: the solution agent has not run on this lead.';
    }
  }
}

/**
 * The stored reviews, newest first as the API sends them. Never shows an author: the API does not
 * send one.
 * @param props - The reviews.
 * @param props.reviews - The lead's reviews.
 * @returns The list, or a line saying none are stored.
 */
function ReviewList({ reviews }: Readonly<{ reviews: readonly Review[] }>) {
  if (reviews.length === 0) return <p className="text-sm text-slate-500">No reviews stored.</p>;
  return (
    <ul className="space-y-2 text-sm">
      {reviews.map((review) => (
        <li key={review.id} className="rounded border bg-white px-4 py-2">
          <p className="text-xs text-slate-500">
            {review.rating === null ? 'No rating' : `${String(review.rating)} / 5`} ·{' '}
            {review.publishedAt === null ? 'Undated' : karachiTime(review.publishedAt)} ·{' '}
            {review.ownerReplied ? 'Owner replied' : 'No owner reply'}
            {review.labels.length === 0 ? null : ` · ${review.labels.join(', ')}`}
          </p>
          {/* A rating-only review has no text; say so rather than leave a blank line. */}
          {review.text === '' ? (
            <p className="text-slate-500">No review text.</p>
          ) : (
            <p>{review.text}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
