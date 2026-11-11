/**
 * Spend status use case: this Asia/Karachi month's LLM spend against the monthly cap, for the
 * dashboard's cap banner.
 *
 * Serves: FR-33 (reaching a cap shows a banner), NFR-4; issue #13.
 * Used by: apps/api/src/modules/costs/costs.controller.ts.
 */
import { HttpError, Injectable } from '@hazeljs/core';
import type { CostsStatus } from '@voxflow/shared';
import { LlmSpendRepository } from '../../db/llm-spend.repository.js';
import { Prisma } from '../../generated/prisma/client.js';
import { karachiMonthStart, wouldPassCap } from '../../pipeline/spend-cap.js';
import { CampaignsRepository } from '../campaigns/campaigns.repository.js';

// The banner counts the cap as reached once less than this is left: more than the worst case of
// any v1 LLM call (a 30-review labelling call is about $0.001 to $0.005), so whenever the gate
// refuses a call the banner is already on.
const BANNER_HEADROOM_USD = new Prisma.Decimal('0.01');

/** Reports spend against the caps. */
@Injectable()
export class CostsService {
  /**
   * Wires the use case to the spend and the organization lookup.
   * @param spend - Monthly LLM cap and spend.
   * @param campaigns - Finds the one v1 organization.
   */
  constructor(
    private readonly spend: LlmSpendRepository,
    private readonly campaigns: CampaignsRepository,
  ) {}

  /**
   * Reads this month's LLM spend and the cap.
   *
   * `blocked` is true once less than one cent of the cap is left. The gate refuses a call as soon
   * as its worst case would not fit, which for every v1 call is less than a cent, so the banner is
   * on before the first refusal; it may show while a very small call would still fit.
   * Does not cover the daily Apify, Perplexity and Vapi caps: their steps report CAP_REACHED.
   * @returns The spend, the cap, whether calls are blocked, and when the month began.
   * @throws HttpError (503) when the database has not been seeded; Prisma's not-found error when
   * the organization has no settings; ZodError when its `spendCaps` are invalid (both answer 500).
   */
  async status(): Promise<CostsStatus> {
    const organizationId = await this.campaigns.findOrganizationId();
    // 503: the API works, but this database has not been set up yet.
    if (organizationId === null)
      throw new HttpError(503, 'No organization found: run pnpm db:seed');
    const monthStart = karachiMonthStart(new Date());
    const { capUsd, spentUsd } = await this.spend.monthToDate(organizationId, monthStart);
    return {
      llm: {
        // Five decimals, as CostRecord stores them.
        spentUsd: spentUsd.toFixed(5),
        capUsd: capUsd.toFixed(2),
        blocked: wouldPassCap(spentUsd, BANNER_HEADROOM_USD, capUsd),
        monthStart: monthStart.toISOString(),
      },
    };
  }
}
