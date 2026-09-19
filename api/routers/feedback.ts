/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FEEDBACK ROUTER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles all feedback: floating button submissions, message reactions,
 * screenshot storage, tagging, and listing/filtering.
 */

import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { feedback, users, teamMembers, teamProjects } from "@db/schema";
import { eq, desc, and, inArray, sql, or } from "drizzle-orm";
import { signScreenshotUrl } from "../lib/screenshotUrls";

export const feedbackRouter = createRouter({
  /**
   * Submit feedback (from floating button or message reactions).
   */
  submit: authedQuery
    .input(
      z.object({
        teamId: z.number().optional(),
        projectId: z.number().optional(),
        targetType: z.enum(["message", "ui", "general"]).default("general"),
        targetMessageId: z.number().optional(),
        feedbackType: z.enum(["bug", "suggestion", "praise", "confusion"]),
        severity: z.enum(["critical", "major", "minor", "cosmetic"]).default("minor"),
        content: z.string().min(1).max(5000),
        screenshotUrl: z.string().optional(),
        context: z.object({
          url: z.string().optional(),
          browser: z.string().optional(),
          os: z.string().optional(),
          consoleLogs: z.array(z.string()).optional(),
          activePipeline: z.string().optional(),
          activeStep: z.string().optional(),
          modelUsed: z.string().optional(),
          tokenCount: z.number().optional(),
          latencyMs: z.number().optional(),
        }).optional(),
        tags: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      // Auto-detect team from projectId if not explicitly provided
      let teamId = input.teamId || null;
      if (!teamId && input.projectId) {
        // Check if project is shared with any team the user belongs to
        const memberships = await db
          .select({ teamId: teamMembers.teamId })
          .from(teamMembers)
          .where(eq(teamMembers.userId, ctx.user.id));
        const teamIds = memberships.map((m) => m.teamId);
        if (teamIds.length > 0) {
          const shared = await db
            .select({ teamId: teamProjects.teamId })
            .from(teamProjects)
            .where(and(
              eq(teamProjects.projectId, input.projectId),
              inArray(teamProjects.teamId, teamIds),
            ))
            .limit(1);
          if (shared.length > 0) teamId = shared[0].teamId;
        }
      }

      const [result] = await db.insert(feedback).values({
        teamId,
        projectId: input.projectId || null,
        userId: ctx.user.id,
        targetType: input.targetType,
        targetMessageId: input.targetMessageId || null,
        feedbackType: input.feedbackType,
        severity: input.severity,
        content: input.content,
        screenshotUrl: input.screenshotUrl || null,
        contextJson: input.context || null,
        tagsJson: input.tags || null,
        status: "new",
      });

      return { id: result.insertId, success: true, teamId };
    }),

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
   * List feedback for a project or team.
   * When filtering by teamId, also includes feedback for shared projects
   * even if teamId was not explicitly set on the feedback record.
   */
  list: authedQuery
    .input(
      z.object({
        projectId: z.number().optional(),
        teamId: z.number().optional(),
        status: z.enum(["new", "triaged", "in_progress", "resolved", "verified", "closed"]).optional(),
        feedbackType: z.enum(["bug", "suggestion", "praise", "confusion"]).optional(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();

      // Get shared project IDs for this team (for retroactive matching)
      let sharedProjectIds: number[] = [];
      if (input.teamId !== undefined) {
        const shared = await db
          .select({ projectId: teamProjects.projectId })
          .from(teamProjects)
          .where(eq(teamProjects.teamId, input.teamId));
        sharedProjectIds = shared.map((s) => s.projectId);
      }

      // Build WHERE conditions dynamically using proper SQL (no JS filtering)
      const whereConditions = [];

      if (input.projectId !== undefined) {
        whereConditions.push(eq(feedback.projectId, input.projectId));
      }

      if (input.teamId !== undefined) {
        // Match by teamId, shared project, or current user's own feedback
        const teamConditions: ReturnType<typeof eq>[] = [
          eq(feedback.teamId, input.teamId),
          eq(feedback.userId, ctx.user.id),
        ];
        if (sharedProjectIds.length > 0) {
          teamConditions.push(inArray(feedback.projectId, sharedProjectIds));
        }
        whereConditions.push(or(...teamConditions));
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
        teamId: z.number().optional(),
        projectId: z.number().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = getDb();

      // Build WHERE conditions using SQL (no full-table load)
      const whereConditions = [];

      if (input.projectId !== undefined) {
        whereConditions.push(eq(feedback.projectId, input.projectId));
      }

      // Get shared project IDs for retroactive matching
      let sharedProjectIds: number[] = [];
      if (input.teamId !== undefined) {
        const shared = await db
          .select({ projectId: teamProjects.projectId })
          .from(teamProjects)
          .where(eq(teamProjects.teamId, input.teamId));
        sharedProjectIds = shared.map((s) => s.projectId);

        const teamConditions: ReturnType<typeof eq>[] = [
          eq(feedback.teamId, input.teamId),
          eq(feedback.userId, ctx.user.id),
        ];
        if (sharedProjectIds.length > 0) {
          teamConditions.push(inArray(feedback.projectId, sharedProjectIds));
        }
        whereConditions.push(or(...teamConditions));
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
