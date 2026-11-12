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

const CAMPAIGN_ID = /^[a-z0-9]{1,64}$/;

/**
 * Forwards the request to `GET /campaigns/:id/leads.csv` and returns the file as the API sent it.
 * @param request - The browser's request; its query holds the table's filters.
 * @param context - Next.js route context.
 * @param context.params - The route's `id`.
 * @returns The CSV with the API's type and file name; 404 for an id that is not a cuid; a one-line
 * text message for an API error.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  // Checked here too: "." or ".." would otherwise collapse the API path.
  if (!CAMPAIGN_ID.test(id)) return new Response('No such campaign.', { status: 404 });
  const params = new URL(request.url).searchParams;
  // getAll, so a repeated key keeps its first value exactly as the page's table does.
  const query = readLeadQuery(
    Object.fromEntries([...params.keys()].map((key) => [key, params.getAll(key)])),
  );
  return apiDownload(
    `/campaigns/${id}/leads.csv${toSearch(query, { page: undefined })}`,
    request.signal,
  );
}
