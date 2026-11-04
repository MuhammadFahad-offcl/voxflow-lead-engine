/**
 * HTTP routes for campaigns. Parses input with Zod, calls the service, nothing else.
 *
 * Serves: FR-1, FR-2; ADR-0003 (these routes bind to 127.0.0.1 with the rest of the API).
 * Used by: apps/api/src/modules/campaigns/campaigns.module.ts; docs/http/campaigns.http.
 */
import { Body, Controller, Get, HttpCode, Param, Post, ValidationError } from '@hazeljs/core';
import { CreateCampaignInput, type CampaignSummary } from '@voxflow/shared';
import { z } from 'zod';
import { CampaignsService } from './campaigns.service.js';

// cuid ids are 25 characters; the limit only keeps junk out of logs and queries.
const CampaignId = z.string().trim().min(1, 'id is required').max(64, 'id is too long');

/**
 * Turns Zod issues into HazelJS's 400 body: one entry per field with its message.
 *
 * Does not include rejected values, so a pasted secret or phone number is never echoed. Unknown
 * key names are listed, because the message names the key.
 * @param message - Summary line, e.g. "Invalid campaign".
 * @param error - The failed parse.
 * @returns The error the router renders as `{ statusCode: 400, message, errors: [{ field, messages }] }`.
 */
function toValidationError(message: string, error: z.ZodError): ValidationError {
  return new ValidationError(
    message,
    error.issues.map((issue) => ({
      property: issue.path.join('.') || '(body)',
      constraints: { [issue.code]: issue.message },
    })),
  );
}

/**
 * Validates a campaign id from the path.
 * @param id - Raw path segment.
 * @returns The trimmed id.
 * @throws ValidationError (400) when it is empty or longer than 64 characters.
 */
function parseId(id: string): string {
  const result = CampaignId.safeParse(id);
  if (!result.success) throw toValidationError('Invalid campaign id', result.error);
  return result.data;
}

/** `/campaigns` routes for the dashboard. */
@Controller('/campaigns')
export class CampaignsController {
  /**
   * Wires the routes to the campaign use cases.
   * @param campaigns - Campaign use cases.
   */
  constructor(private readonly campaigns: CampaignsService) {}

  /**
   * Creates a campaign.
   * @param body - Raw JSON body; validated against `CreateCampaignInput`.
   * @returns 201 with the campaign summary.
   * @throws ValidationError (400) for a bad body; NotFoundError (404) for an unknown niche;
   * HttpError (503) when the database is not seeded.
   */
  @Post()
  @HttpCode(201)
  create(@Body() body: unknown): Promise<CampaignSummary> {
    const input = CreateCampaignInput.safeParse(body);
    if (!input.success) throw toValidationError('Invalid campaign', input.error);
    return this.campaigns.create(input.data);
  }

  /**
   * Lists campaigns, newest first.
   * @returns 200 with the summaries.
   * @throws HttpError (503) when the database is not seeded.
   */
  @Get()
  list(): Promise<CampaignSummary[]> {
    return this.campaigns.list();
  }

  /**
   * Gets one campaign.
   * @param id - Campaign id from the path.
   * @returns 200 with its summary.
   * @throws ValidationError (400) for a bad id; NotFoundError (404) when it does not exist;
   * HttpError (503) when the database is not seeded.
   */
  @Get('/:id')
  get(@Param('id') id: string): Promise<CampaignSummary> {
    return this.campaigns.get(parseId(id));
  }
}
