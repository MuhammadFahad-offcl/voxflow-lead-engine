/**
 * Database access for review labelling: what a lead needs labelled, and storing the labels.
 *
 * Serves: FR-13, FR-11 (the 30 newest reviews); issue #13.
 * Used by: apps/api/src/pipeline/label-reviews.step.ts, apps/api/test/label-reviews.int.spec.ts.
 */
import { Injectable } from '@hazeljs/core';
import type { LeadStatus } from '../generated/prisma/client.js';
import type { ReviewToLabel } from '../llm/review-labelling.js';
import { PrismaProvider } from './prisma.provider.js';

// Scoring counts labels over the 30 newest reviews (PRD "Lead scoring model"), so only those matter.
const NEWEST_REVIEWS = 30;

/** What the labelling step reads about a lead. */
export interface LeadForLabelling {
  organizationId: string;
  campaignId: string;
  status: LeadStatus;
  /** The labels of the niche the lead's campaign uses. */
  reviewLabels: string[];
  /** Reviews among the 30 newest that have no labels yet, newest first. */
  unlabelled: ReviewToLabel[];
}

/** Reads reviews to label and stores their labels. */
@Injectable()
export class ReviewLabelRepository {
  /**
   * Wires the repository to the process's database client.
   * @param prisma - The process's Prisma client.
   */
  constructor(private readonly prisma: PrismaProvider) {}

  /**
   * Reads a lead, its niche's labels, and its unlabelled reviews among the 30 newest.
   *
   * Does not return reviews that already have labels, so a repeat run sends nothing twice.
   * @param leadId - `Lead.id`.
   * @returns The lead's owner, campaign, status, labels and reviews to label.
   * @throws Prisma's not-found error when there is no such lead.
   */
  async forLabelling(leadId: string): Promise<LeadForLabelling> {
    const lead = await this.prisma.lead.findUniqueOrThrow({
      where: { id: leadId },
      select: {
        organizationId: true,
        campaignId: true,
        status: true,
        campaign: { select: { nicheProfile: { select: { reviewLabels: true } } } },
        reviews: {
          // Pass 2 always stores a date; nulls-last and the id tie-break only make the order
          // complete. Scoring (#14) must count labels over this same order.
          orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
          take: NEWEST_REVIEWS,
          select: { id: true, text: true, rating: true, labels: true },
        },
      },
    });
    return {
      organizationId: lead.organizationId,
      campaignId: lead.campaignId,
      status: lead.status,
      reviewLabels: lead.campaign.nicheProfile.reviewLabels,
      unlabelled: lead.reviews
        .filter((review) => review.labels.length === 0)
        .map(({ id, text, rating }) => ({ id, text, rating })),
    };
  }

  /**
   * Stores labels for reviews that are still unlabelled, in one transaction.
   *
   * Does not overwrite labels: when two runs raced, the first run's labels stay.
   * @param rows - One row per review: `Review.id` and its labels.
   * @returns How many reviews got labels.
   */
  async saveLabels(rows: readonly { reviewId: string; labels: string[] }[]): Promise<number> {
    const results = await this.prisma.$transaction(
      rows.map(({ reviewId, labels }) =>
        this.prisma.review.updateMany({
          where: { id: reviewId, labels: { isEmpty: true } },
          data: { labels },
        }),
      ),
    );
    return results.reduce((total, { count }) => total + count, 0);
  }
}
