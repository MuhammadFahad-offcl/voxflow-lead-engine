/**
 * HTTP routes for campaigns. Parses input with Zod, calls the service, nothing else.
 *
 * Serves: FR-1, FR-2; ADR-0003 (these routes bind to 127.0.0.1 with the rest of the API).
 * Used by: apps/api/src/modules/campaigns/campaigns.module.ts.
 */
import { Body, Controller, HttpCode, Post, ValidationError } from '@hazeljs/core';
import { CreateCampaignInput, type CampaignSummary } from '@voxflow/shared';
import type { z } from 'zod';
import { CampaignsService } from './campaigns.service.js';

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
}
