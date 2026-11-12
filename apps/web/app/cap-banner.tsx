/**
 * The banner across every page when the monthly LLM cap is reached (labelling is paused), or when
 * the API cannot be reached at all.
 *
 * Serves: FR-33 ("reaching a cap pauses that step and shows a banner"); issue #16.
 * Used by: apps/web/app/layout.tsx.
 */
import { CostsStatus } from '@voxflow/shared';
import { ApiError, apiGet } from '../lib/api';

/**
 * Renders the banner, or nothing when all is well.
 *
 * Does not show the Apify or Perplexity day caps: those pause a campaign, whose page shows the
 * reason. Does not hide a broken answer from the API: that is a bug and throws.
 * @returns The banner or null.
 */
export async function CapBanner() {
  let status: CostsStatus;
  try {
    status = await apiGet('/costs/status', CostsStatus);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return (
      <div className="bg-amber-100 px-6 py-2 text-sm text-amber-900">
        The API is not reachable: start it with `pnpm dev`.
      </div>
    );
  }
  if (!status.llm.blocked) return null;
  return (
    <div className="bg-red-100 px-6 py-2 text-sm text-red-900">
      Monthly LLM cap reached: ${status.llm.spentUsd} of ${status.llm.capUsd} spent. Review
      labelling is paused until the month turns or the cap is raised.
    </div>
  );
}
