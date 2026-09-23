/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FEEDBACK ROUTER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles all feedback: floating button submissions, message reactions,
 * screenshot storage, tagging, and listing/filtering.
 *
 * D11 (ticket #22) adds the CONSENTED ATTACHMENT half: a submission may carry
 * the pipeline / run / benchmark the report is about, one explicit opt-in per
 * object, and the author can read back exactly what they consented to. The
 * access rules and the snapshot redaction are NOT in this file — they live in
 * api/services/feedbackAttachments.ts, which is the only thing that decides
 * what an attachment may contain (see spec A12 there).
 */

import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { feedback, users } from "@db/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { signScreenshotUrl } from "../lib/screenshotUrls";
import {
  attachableObjectsFor, feedbackSubmitInputSchema, listOwnAttachments,
  submitFeedbackWithAttachments,
} from "../services/feedbackAttachments";

export const feedbackRouter = createRouter({
  /**
   * Submit feedback (from floating button or message reactions), optionally
   * with the objects it is about attached under a per-item consent.
   */
  submit: authedQuery
    .input(feedbackSubmitInputSchema)
    .mutation(async ({ input, ctx }) => submitFeedbackWithAttachments(ctx.user.id, input)),

  /**
   * What this account could attach: its own pipelines, runs and benchmarks (and
   * the pipelines another account named it on), as LABELS ONLY. Content enters
   * a snapshot at submit time through the author's own read projections, so this
   * picker cannot be used to fetch someone else's prompts.
   */
  attachable: authedQuery
    .input(z.object({ projectId: z.number().int().positive().optional() }))
    .query(({ ctx, input }) => attachableObjectsFor(ctx.user.id, input.projectId)),

  /**
   * The author's own attachments for one feedback item, consent version and
   * snapshot included — these are their consented copies. Author-only: any
   * other account gets the same not-found-shaped refusal used everywhere else,
   * so a feedback id cannot be probed.
   */
  attachments: authedQuery
    .input(z.object({ feedbackId: z.number().int().positive() }))
    .query(({ ctx, input }) => listOwnAttachments(ctx.user.id, input.feedbackId)),

  /**
   * Message reaction: thumbs up/down with optional tags and comment.
   */
  reactToMessage: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        messageId: z.number(),
        reaction: z.enum(["up", "down"]),
        tags: z.array(z.string()).optional(),
        comment: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      const type = input.reaction === "up" ? "praise" : "bug";

      const [result] = await db.insert(feedback).values({
        projectId: input.projectId,
        userId: ctx.user.id,
        targetType: "message",
        targetMessageId: input.messageId,
        feedbackType: type,
        content: input.comment || (input.reaction === "up" ? "Thumbs up" : "Thumbs down"),
        tagsJson: input.tags || null,
        status: "new",
      });

      return { id: result.insertId, reaction: input.reaction };
    }),

  /**
   * List feedback for a project (or by status/type).
   */
  list: authedQuery
    .input(
      z.object({
        projectId: z.number().optional(),
        status: z.enum(["new", "triaged", "in_progress", "resolved", "verified", "closed"]).optional(),
        feedbackType: z.enum(["bug", "suggestion", "praise", "confusion"]).optional(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();

      // Build WHERE conditions dynamically using proper SQL (no JS filtering)
      const whereConditions = [];

      if (input.projectId !== undefined) {
        whereConditions.push(eq(feedback.projectId, input.projectId));
      }

      if (input.status) {
        whereConditions.push(eq(feedback.status, input.status));
      }

      if (input.feedbackType) {
        whereConditions.push(eq(feedback.feedbackType, input.feedbackType));
      }

      // Build query with all filters in SQL — no JS filtering needed
      const rows = await db
        .select({
          id: feedback.id,
          teamId: feedback.teamId,
          projectId: feedback.projectId,
          userId: feedback.userId,
          targetType: feedback.targetType,
          targetMessageId: feedback.targetMessageId,
          feedbackType: feedback.feedbackType,
          severity: feedback.severity,
          content: feedback.content,
          screenshotUrl: feedback.screenshotUrl,
          tagsJson: feedback.tagsJson,
          status: feedback.status,
          assignedTo: feedback.assignedTo,
          createdAt: feedback.createdAt,
          username: users.username,
          name: users.name,
        })
        .from(feedback)
        .leftJoin(users, eq(feedback.userId, users.id))
        .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
        .orderBy(desc(feedback.createdAt))
        .limit(input.limit)
        .offset(input.offset);

      // Decorate stored screenshot paths with short-lived signed URLs —
      // <img> tags can't send auth headers, and the session JWT must never
      // travel in a query string (see api/lib/screenshotUrls.ts).
      return rows.map((r) => ({
        ...r,
        screenshotUrl: r.screenshotUrl ? signScreenshotUrl(r.screenshotUrl) : r.screenshotUrl,
      }));
    }),

  /**
   * Update feedback status (triaged, in_progress, etc.).
   */
  updateStatus: authedQuery
    .input(
      z.object({
        feedbackId: z.number(),
        status: z.enum(["new", "triaged", "in_progress", "resolved", "verified", "closed"]),
        assignedTo: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      const update: Record<string, unknown> = { status: input.status };
      if (input.assignedTo) update.assignedTo = input.assignedTo;
      if (input.status === "resolved" || input.status === "closed") {
        update.resolvedAt = new Date();
      }

      await db
        .update(feedback)
        .set(update)
        .where(eq(feedback.id, input.feedbackId));

      return { success: true };
    }),

  /**
   * Get feedback stats for dashboard.
   */
  stats: authedQuery
    .input(
      z.object({
        projectId: z.number().optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();

      // Build WHERE conditions using SQL (no full-table load)
      const whereConditions = [];

      if (input.projectId !== undefined) {
        whereConditions.push(eq(feedback.projectId, input.projectId));
      }

      const whereClause = whereConditions.length > 0 ? and(...whereConditions) : undefined;

      // SQL GROUP BY aggregation instead of loading all records into memory
      const byTypeRows = await db
        .select({
          feedbackType: feedback.feedbackType,
          count: sql<number>`count(*)`,
        })
        .from(feedback)
        .where(whereClause)
        .groupBy(feedback.feedbackType);

      const byStatusRows = await db
        .select({
          status: feedback.status,
          count: sql<number>`count(*)`,
        })
        .from(feedback)
        .where(whereClause)
        .groupBy(feedback.status);

      const byType = { bug: 0, suggestion: 0, praise: 0, confusion: 0 };
      for (const row of byTypeRows) {
        if (row.feedbackType in byType) {
          byType[row.feedbackType as keyof typeof byType] = row.count;
        }
      }

      const byStatus = { new: 0, triaged: 0, in_progress: 0, resolved: 0, verified: 0, closed: 0 };
      for (const row of byStatusRows) {
        if (row.status in byStatus) {
          byStatus[row.status as keyof typeof byStatus] = row.count;
        }
      }

      const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
      const open = byStatus.new + byStatus.triaged + byStatus.in_progress;
      const resolved = byStatus.resolved + byStatus.verified + byStatus.closed;

      return { total, byType, byStatus, open, resolved };
    }),

  /**
   * Convert feedback to an issue.
   */
  convertToIssue: authedQuery
    .input(
      z.object({
        feedbackId: z.number(),
        title: z.string().min(1),
        priority: z.enum(["p0", "p1", "p2", "p3"]).default("p2"),
        assigneeId: z.number().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      const [fb] = await db
        .select()
        .from(feedback)
        .where(eq(feedback.id, input.feedbackId))
        .limit(1);

      if (!fb) throw new Error("Feedback not found");

      // Create issue
      const { issues } = await import("@db/schema");
      const [issue] = await db.insert(issues).values({
        teamId: fb.teamId,
        projectId: fb.projectId,
        title: input.title,
        description: fb.content + (fb.screenshotUrl ? `\n\nScreenshot: ${fb.screenshotUrl}` : ""),
        priority: input.priority,
        status: "open",
        assigneeId: input.assigneeId || null,
        relatedFeedbackIdsJson: [input.feedbackId],
        createdBy: ctx.user.id,
      });

      // Update feedback with issue reference
      await db
        .update(feedback)
        .set({
          status: "triaged",
          convertedToIssueId: issue.insertId,
        })
        .where(eq(feedback.id, input.feedbackId));

      return { issueId: issue.insertId };
    }),
});
