/**
 * Component tests of the lead table's filters, rendered to HTML with react-dom/server (no browser,
 * no testing library): the status list offers the solution step's exit statuses.
 *
 * Serves: FR-30 (filter by status), FR-17 (NO_STRONG_SIGNAL, NEEDS_REVIEW); issue #19.
 * Used by: `pnpm test`, through the `web` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { LeadFilters } from './lead-filters';

const render = (status?: string) =>
  renderToStaticMarkup(
    <LeadFilters
      campaignId="fictional-campaign"
      query={status === undefined ? {} : { status }}
      refused={false}
    />,
  );

// Proves the founder can filter on the statuses the solution step ends a lead with.
describe('LeadFilters', () => {
  it.each(['NO_STRONG_SIGNAL', 'NEEDS_REVIEW'])('offers the %s status', (status) => {
    expect(render()).toContain(`<option>${status}</option>`);
  });

  it('keeps NEEDS_REVIEW selected when the page is filtered on it', () => {
    expect(render('NEEDS_REVIEW')).toContain('<option selected="">NEEDS_REVIEW</option>');
  });
});
