/**
 * Component test of the lead table, rendered to HTML with react-dom/server: each row's expanded
 * part links to its lead page, outside `<summary>`.
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

// Proves FR-30's link from the table: each row opens /leads/<id>, from outside <summary>.
describe('LeadTable', () => {
  it('links each row to its lead page from the expanded part, not from <summary>', () => {
    const html = renderToStaticMarkup(
      <LeadTable
        campaignId="fictionalcampaign"
        page={{ leads: [lead], total: 1, page: 1, pageSize: 50 }}
        query={{}}
      />,
    );

    expect(html).toContain('href="/leads/fictionallead1"');
    expect(html).toContain('Open the lead page');
    expect(html.indexOf('href="/leads/')).toBeGreaterThan(html.indexOf('</summary>'));
  });
});
