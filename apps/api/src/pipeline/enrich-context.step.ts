/**
 * The web context part of the enrich step: one Perplexity search for a lead that passed the
 * filter, stored with its sources and its cost. FR-12 is "should", so a failed search never fails
 * the lead. Not wired into a runner or graph yet: #15 does that.
 *
 * CAP_REACHED is only returned and logged. Nothing is persisted for it: the cap is re-derived
 * from the CostRecord rows on every call, so it clears by itself when the Asia/Karachi day turns
 * or the cap is raised. The pause or banner comes with #15 and #16.
 *
 * Serves: FR-12, FR-33, NFR-4, ADR-0007; issue #12.
 * Used by: apps/api/test/enrich-context.int.spec.ts only, until #15 calls it from the lead graph.
 */
import type { LeadContextRepository } from '../db/lead-context.repository.js';
import { errorFields, type Logger } from '../logging/logger.js';
import {
  WebContextError,
  type WebContextPort,
  type WebContextResult,
} from '../ports/web-context.port.js';
import { karachiDayStart, wouldPassCap } from './spend-cap.js';

/** What the step needs from outside. */
export interface EnrichContextDeps {
  leads: LeadContextRepository;
  webContext: WebContextPort;
  logger: Logger;
  /** The clock, so tests can fix the day the cap counts. */
  now: () => Date;
}

/** How one run ended. CAP_REACHED carries the sentence for the dashboard banner (#16). */
export type ContextOutcome =
  | { status: 'STORED'; sources: number }
  | { status: 'SKIPPED'; reason: 'FILTERED_OUT' | 'ALREADY_HAS_CONTEXT' }
  | { status: 'CAP_REACHED'; reason: string }
  | { status: 'FAILED' };

/**
 * Searches the web for one lead's business and stores the context and the request's cost.
 *
 * Safe to repeat: a lead that already has a context is not searched, and so not paid for, again.
 * #15 must not blindly retry a FAILED lead: a retry can pay again. It must also run the ideal-client
 * filter first, because this step skips only FILTERED_OUT leads, and serialise this step or bound
 * its concurrency (see below).
 *
 * The cap is checked before the call as spent today plus the most one call can cost. That differs
 * from the Apify reservation: a Search request has a small, flat, known price ($0.005), so the
 * check is exact and the cap can be passed only by searches in flight at the same moment, by at
 * most one price each. An Apify run's cost is large and unknown until it ends, so it needs a
 * reservation first.
 * The cap is a hard rule (FR-33), so spend is counted conservatively: a failure that may have been
 * billed (a timeout, a dropped connection, a bad answer to a 200, or an error this code does not
 * know) records a CostRecord at the full price with `units: 0` and leaves the context empty. A
 * failure known not to be billed (429 or 5xx after retries, never connected, refused) records
 * nothing. If the context cannot be saved after a good answer, the cost is recorded the same way
 * and the error is thrown.
 * A crash between a successful call and the save cannot be covered without a reservation before
 * the call. The loss is at most $0.005 per crash and is accepted.
 * Logs only the lead id, counts and fixed words: never the business name, query, result text or
 * an error message.
 * Does not change the lead's status, and does not retry a failed search: the adapter decides what
 * is safe to retry.
 * @param deps - Its dependencies.
 * @param leadId - `Lead.id` of the lead to enrich.
 * @returns What happened; a search that failed leaves the context empty and reports FAILED.
 * @throws Prisma errors, e.g. when there is no such lead or the save fails; ZodError for invalid
 * settings or a context that does not match BusinessContext (a bug, not a service failure).
 */
export async function enrichContext(
  deps: EnrichContextDeps,
  leadId: string,
): Promise<ContextOutcome> {
  const { leads, webContext, logger, now } = deps;
  const lead = await leads.forContext(leadId);
  if (lead.status === 'FILTERED_OUT') return { status: 'SKIPPED', reason: 'FILTERED_OUT' };
  if (lead.hasContext) return { status: 'SKIPPED', reason: 'ALREADY_HAS_CONTEXT' };

  const maxCostUsd = webContext.maxCostUsd();
  const { capUsd, spentUsd } = await leads.dailyCap(lead.organizationId, karachiDayStart(now()));
  if (wouldPassCap(spentUsd, maxCostUsd, capUsd)) {
    const [spent, next, cap] = [spentUsd, maxCostUsd, capUsd].map((usd) => usd.toFixed(3));
    const reason = `Perplexity daily cap: $${String(spent)} spent today, the next search may cost $${String(next)}, the cap is $${String(cap)}`;
    logger.warn({ leadId }, 'Perplexity daily cap reached; context not searched');
    return { status: 'CAP_REACHED', reason };
  }

  let found: WebContextResult;
  try {
    found = await webContext.getContext({
      name: lead.name,
      area: lead.area ?? '',
      city: lead.city ?? '',
      website: lead.website,
    });
  } catch (error) {
    // The error's message is left out: it is fixed text today, but a future adapter may echo more.
    logger.warn({ leadId, ...errorFields(error) }, 'web context search failed; context left empty');
    // Only a failure known not to be billed is free; anything else counts against the cap.
    if (!(error instanceof WebContextError) || error.maybeBilled) {
      await leads.recordSpend({ id: leadId, ...lead }, maxCostUsd);
    }
    return { status: 'FAILED' };
  }
  try {
    await leads.saveContext({ id: leadId, ...lead }, found.context, found.costUsd);
  } catch (error) {
    // The search was paid for: keep its cost on the cap, then report the save's own error.
    await leads.recordSpend({ id: leadId, ...lead }, found.costUsd).catch(() => undefined);
    throw error;
  }
  const sources = found.context.sources.length;
  logger.info({ leadId, sources }, 'web context stored');
  return { status: 'STORED', sources };
}
