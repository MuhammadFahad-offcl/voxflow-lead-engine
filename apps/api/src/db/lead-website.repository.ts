/**
 * Database access for the website part of enrichment: a lead's website, and what reading it found.
 *
 * Serves: FR-9, FR-10; issue #11.
 * Used by: apps/api/src/pipeline/enrich.step.ts, apps/api/test/enrich.int.spec.ts.
 */
import { Injectable } from '@hazeljs/core';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaProvider } from './prisma.provider.js';

/** The Lead columns the website read fills. */
export type LeadWebsiteFacts = Required<
  Pick<
    Prisma.LeadUpdateInput,
    | 'websiteStatus'
    | 'emails'
    | 'whatsappLinks'
    | 'socialLinks'
    | 'hasOnlineBooking'
    | 'hasChatWidget'
    | 'decisionMakerName'
  >
>;

/** Reads a lead's website and stores what reading it found. */
@Injectable()
export class LeadWebsiteRepository {
  /**
   * Wires the repository to the process's database client.
   * @param prisma - The process's Prisma client.
   */
  constructor(private readonly prisma: PrismaProvider) {}

  /**
   * Gives a lead's website.
   * @param leadId - `Lead.id`.
   * @returns The normalized website URL, or null when the listing had none.
   * @throws Prisma's not-found error when there is no such lead.
   */
  async websiteOf(leadId: string): Promise<string | null> {
    const { website } = await this.prisma.lead.findUniqueOrThrow({
      where: { id: leadId },
      select: { website: true },
    });
    return website;
  }

  /**
   * Stores what reading the website found, replacing any earlier read.
   * @param leadId - `Lead.id`.
   * @param facts - Status and extracted fields.
   * @throws Prisma's not-found error when there is no such lead.
   */
  async saveWebsite(leadId: string, facts: LeadWebsiteFacts): Promise<void> {
    await this.prisma.lead.update({ where: { id: leadId }, data: facts });
  }
}
