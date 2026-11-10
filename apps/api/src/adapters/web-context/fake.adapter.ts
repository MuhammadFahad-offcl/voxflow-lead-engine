/**
 * The fake web context: fictional Search API responses from fixtures/context instead of the
 * network, mapped by the same code as the real adapter.
 *
 * Serves: ADR-0007 (DEMO_MODE binds every fake), FR-12, FR-36, NFR-9; issue #12.
 * Used by: apps/api/src/bootstrap.ts, through `bindAdapter` (a later slice), when DEMO_MODE=true;
 * tests.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Injectable } from '@hazeljs/core';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  BusinessQuery,
  WebContextPort,
  WebContextResult,
} from '../../ports/web-context.port.js';
import { SearchResponse, toBusinessContext } from './search-results.js';

const FIXTURES_DIR = resolve(import.meta.dirname, '../../../../../fixtures/context');
// The real price of one Search API request, so demo cost figures are the right size.
const REQUEST_COST_USD = new Prisma.Decimal('0.005');

// "Fictional Bright Smile Dental" becomes fictional-bright-smile-dental.json. Only letters,
// digits and dashes reach the file name, so no name can leave the folder.
const fixtureFile = (name: string): string =>
  join(FIXTURES_DIR, `${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}.json`);

/** Serves fixtures/context/*.json. */
@Injectable()
export class FakeWebContextAdapter implements WebContextPort {
  /** @inheritDoc */
  maxCostUsd(): Prisma.Decimal {
    return REQUEST_COST_USD;
  }

  /**
   * Reads the fixture named after the business; a business with none gets no results, like a
   * search that found nothing, and still costs one request.
   * @inheritDoc
   */
  async getContext(query: BusinessQuery): Promise<WebContextResult> {
    const body = await readFile(fixtureFile(query.name), 'utf8').catch(() => '{"results":[]}');
    const response = SearchResponse.parse(JSON.parse(body));
    return { context: toBusinessContext(response), costUsd: REQUEST_COST_USD };
  }
}
