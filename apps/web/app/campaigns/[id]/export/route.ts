/**
 * `/campaigns/[id]/export`: the CSV download, passed through from the API with the page's
 * filters, so the browser downloads from the dashboard and never talks to the API (ADR-0003). The
 * file name (`leads-<id>.csv`) comes from the API's Content-Disposition; the folder is not named
 * `leads.csv` because .gitignore keeps every `*.csv` out of git.
 *
 * Serves: FR-30 (CSV export of exactly the filtered rows); issue #16.
 * Used by: Next.js App Router; the "Export CSV" link in apps/web/app/campaigns/[id]/lead-filters.tsx.
 */
import { apiDownload } from '../../../../lib/api';
import { readLeadQuery, toSearch } from '../../../../lib/lead-query';

/**
 * Forwards the request to `GET /campaigns/:id/leads.csv` and returns the file as the API sent it.
 * @param request - The browser's request; its query holds the table's filters.
 * @param context - Next.js route context.
 * @param context.params - The route's `id`.
 * @returns The CSV with the API's type and file name, or the API's error status.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  // Only the table's known keys go on, never anything else from the URL.
  const query = readLeadQuery(Object.fromEntries(new URL(request.url).searchParams));
  return apiDownload(
    `/campaigns/${encodeURIComponent(id)}/leads.csv${toSearch(query, { page: undefined })}`,
  );
}
