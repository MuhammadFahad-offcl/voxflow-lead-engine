/**
 * What an expanded lead row shows: the score by dimension, then every signal with its points, its
 * evidence and where the evidence came from. A 0-point note (e.g. too few reviews) is shown, muted,
 * because it explains a missing score. A source is linked only when it is an http(s) URL. On the
 * lead page, the signals the Solution cites are highlighted.
 *
 * Serves: FR-14 (every point has evidence), FR-30 (lead table rows expand to their evidence; the
 * lead page), FR-17 (the signals a pick cites), FR-32 (a FAILED lead's error); issues #16, #24.
 * Used by: apps/web/app/campaigns/[id]/lead-table.tsx, apps/web/app/leads/[id]/lead-detail.tsx,
 * ./lead-evidence.spec.tsx.
 */
import type { LeadRow } from '@voxflow/shared';
import { safeHref } from '../../../lib/safe-href';

const DIMENSIONS = [
  ['pain', 'Pain', 40],
  ['fit', 'Fit', 25],
  ['reachability', 'Reachability', 20],
  ['abilityToPay', 'Ability to pay', 15],
] as const;

/**
 * Renders the evidence.
 * @param props - The lead and the signals to highlight.
 * @param props.lead - A lead-table row, or a lead detail. Does not sort its signals: the API sends
 * them highest points first.
 * @param props.cited - Signal keys the lead's Solution cites; none when left out (the lead table).
 * @returns The breakdown and the signal list; for a lead with neither, a line saying so.
 */
export function LeadEvidence({
  lead,
  cited = new Set(),
}: Readonly<{ lead: LeadRow; cited?: ReadonlySet<string> }>) {
  return (
    <div className="space-y-3 bg-slate-50 px-4 py-3 text-sm">
      {lead.error === null ? null : (
        <p className="text-red-800">
          Failed at {lead.failedStep ?? 'an unknown step'}: {lead.error}
        </p>
      )}
      {lead.breakdown === null ? null : (
        <dl className="flex gap-6">
          {DIMENSIONS.map(([key, label, max]) => (
            <div key={key}>
              <dt className="text-xs text-slate-500">{label}</dt>
              <dd className="font-semibold">
                {lead.breakdown?.[key]} / {max}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {lead.signals.length === 0 ? (
        <p className="text-slate-500">No evidence yet: this lead has not been scored.</p>
      ) : (
        <ul className="space-y-1">
          {lead.signals.map((signal) => {
            // Only an http(s) source becomes a link: a scraped `javascript:` URL is not shown.
            const href = signal.sourceUrl === null ? null : safeHref(signal.sourceUrl);
            const isCited = cited.has(signal.key);
            const tone = [
              signal.points === 0 ? 'text-slate-500' : '',
              isCited ? 'bg-amber-100' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <li key={signal.key} className={tone}>
                <span className="inline-block w-12 font-semibold">+{signal.points}</span>
                <span className="mr-2 text-xs uppercase text-slate-500">{signal.key}</span>
                {isCited ? (
                  <span className="mr-2 rounded bg-amber-300 px-1 text-xs">cited by the pick</span>
                ) : null}
                {signal.evidence}
                {href === null ? null : (
                  <>
                    {' '}
                    <a href={href} className="underline" target="_blank" rel="noreferrer">
                      source
                    </a>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
