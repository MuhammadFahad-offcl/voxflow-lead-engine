/**
 * Component test of the lead table, rendered to HTML with react-dom/server: each lead's name
 * links to its lead page.
 *
 * Serves: FR-30 (lead table rows open the lead page); issue #24.
 * Used by: `pnpm test`, through the `web` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import type { LeadRow } from '@voxflow/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { LeadTable } from './lead-table';

const lead: LeadRow = {
  id: 'fictionallead1',
  name: 'Fictional Dental',
  area: 'DHA',
  phone: null,
  phoneType: 'UNKNOWN',
  website: null,
  rating: null,
  reviewCount: 3,
  score: 61,
  tier: 'WARM',
  status: 'SCORED',
  failedStep: null,
  error: null,
  breakdown: null,
  signals: [],
};

// Proves FR-30's link from the table: the row's name goes to /leads/<id>.
describe('LeadTable', () => {
  it('links each lead name to its lead page', () => {
    const html = renderToStaticMarkup(
      <LeadTable
        campaignId="fictionalcampaign"
        page={{ leads: [lead], total: 1, page: 1, pageSize: 50 }}
        query={{}}
      />,
    );

    expect(html).toContain('href="/leads/fictionallead1"');
    expect(html).toContain('>Fictional Dental</a>');
  });
});
