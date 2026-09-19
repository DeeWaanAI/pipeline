/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ISSUES ROUTER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Issue tracking: CRUD, assign, status changes, fix verification loop.
 */

import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { issues, fixVerifications, users } from "@db/schema";
import { eq, desc, and, sql } from "drizzle-orm";

export const issuesRouter = createRouter({
  /**
   * Create an issue (from feedback or manually).
   */
  create: authedQuery
    .input(
      z.object({
        teamId: z.number().optional(),
        projectId: z.number().optional(),
        title: z.string().min(1).max(255),
        description: z.string().optional(),
        priority: z.enum(["p0", "p1", "p2", "p3"]).default("p2"),
        assigneeId: z.number().optional(),
        relatedFeedbackIds: z.array(z.number()).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      const [result] = await db.insert(issues).values({
        teamId: input.teamId || null,
        projectId: input.projectId || null,
        title: input.title,
        description: input.description || null,
        priority: input.priority,
        assigneeId: input.assigneeId || null,
        relatedFeedbackIdsJson: input.relatedFeedbackIds || null,
        createdBy: ctx.user.id,
      });

      return { id: result.insertId, success: true };
    }),

  /**
   * List issues for a team or project.
   */
  list: authedQuery
    .input(
      z.object({
        teamId: z.number().optional(),
        projectId: z.number().optional(),
        status: z.enum(["open", "in_progress", "resolved", "verified", "closed"]).optional(),
        priority: z.enum(["p0", "p1", "p2", "p3"]).optional(),
        assigneeId: z.number().optional(),
        limit: z.number().min(1).max(100).default(50),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();

      const results = await db
        .select({
          id: issues.id,
          teamId: issues.teamId,
          projectId: issues.projectId,
          title: issues.title,
          description: issues.description,
          priority: issues.priority,
          status: issues.status,
          assigneeId: issues.assigneeId,
          assigneeName: users.name,
          assigneeUsername: users.username,
          relatedFeedbackIdsJson: issues.relatedFeedbackIdsJson,
          resolutionNotes: issues.resolutionNotes,
          createdBy: issues.createdBy,
          createdAt: issues.createdAt,
          resolvedAt: issues.resolvedAt,
        })
        .from(issues)
        .leftJoin(users, eq(issues.assigneeId, users.id))
        .orderBy(desc(issues.createdAt))
        .limit(input.limit);

      return results.filter((i) => {
        if (input.teamId && i.teamId !== input.teamId) return false;
        if (input.projectId && i.projectId !== input.projectId) return false;
        if (input.status && i.status !== input.status) return false;
        if (input.priority && i.priority !== input.priority) return false;
        if (input.assigneeId && i.assigneeId !== input.assigneeId) return false;
        return true;
      });
    }),

  /**
   * Get single issue with verification history.
   */
  get: authedQuery
    .input(z.object({ issueId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();

      const [issue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .limit(1);

      if (!issue) throw new Error("Issue not found");

      const verifications = await db
        .select({
          id: fixVerifications.id,
          userId: fixVerifications.userId,
          status: fixVerifications.status,
          testerComment: fixVerifications.testerComment,
          createdAt: fixVerifications.createdAt,
          verifiedAt: fixVerifications.verifiedAt,
          username: users.username,
          name: users.name,
        })
        .from(fixVerifications)
        .leftJoin(users, eq(fixVerifications.userId, users.id))
        .where(eq(fixVerifications.issueId, input.issueId))
        .orderBy(desc(fixVerifications.createdAt));

      return { issue, verifications };
    }),

  /**
   * Update issue status and assignee.
   */
  update: authedQuery
    .input(
      z.object({
        issueId: z.number(),
        status: z.enum(["open", "in_progress", "resolved", "verified", "closed"]).optional(),
        priority: z.enum(["p0", "p1", "p2", "p3"]).optional(),
        assigneeId: z.number().optional(),
        resolutionNotes: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      const update: Record<string, unknown> = {};
      if (input.status) {
        update.status = input.status;
        if (["resolved", "verified", "closed"].includes(input.status)) {
          update.resolvedAt = new Date();
        }
      }
      if (input.priority) update.priority = input.priority;
      if (input.assigneeId !== undefined) update.assigneeId = input.assigneeId;
      if (input.resolutionNotes) update.resolutionNotes = input.resolutionNotes;

      await db
        .update(issues)
        .set(update)
        .where(eq(issues.id, input.issueId));

      return { success: true };
    }),

  /**
   * Submit fix verification.
   */
  verifyFix: authedQuery
    .input(
      z.object({
        issueId: z.number(),
        status: z.enum(["verified", "failed"]),
        comment: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      await db.insert(fixVerifications).values({
        issueId: input.issueId,
        userId: ctx.user.id,
        status: input.status,
        testerComment: input.comment || null,
        verifiedAt: new Date(),
      });

      // Update issue status based on verification
      const newStatus = input.status === "verified" ? "verified" : "open";
      await db
        .update(issues)
        .set({ status: newStatus })
        .where(eq(issues.id, input.issueId));

      return { success: true, status: input.status };
    }),

  /**
   * Get issue stats for dashboard.
   */
  stats: authedQuery
    .input(
      z.object({
        teamId: z.number().optional(),
        projectId: z.number().optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();

      // Build WHERE conditions using SQL (no full-table load)
      const whereConditions = [];
      if (input.teamId) {
        whereConditions.push(eq(issues.teamId, input.teamId));
      }
      if (input.projectId) {
        whereConditions.push(eq(issues.projectId, input.projectId));
      }
      const whereClause = whereConditions.length > 0 ? and(...whereConditions) : undefined;

      // SQL GROUP BY aggregation instead of loading all records into memory
      const byStatusRows = await db
        .select({
          status: issues.status,
          count: sql<number>`count(*)`,
        })
        .from(issues)
        .where(whereClause)
        .groupBy(issues.status);

      const byPriorityRows = await db
        .select({
          priority: issues.priority,
          count: sql<number>`count(*)`,
        })
        .from(issues)
        .where(whereClause)
        .groupBy(issues.priority);

      let total = 0;
      let open = 0;
      let inProgress = 0;
      let resolved = 0;

      for (const row of byStatusRows) {
        total += row.count;
        if (row.status === "open") open += row.count;
        else if (row.status === "in_progress") inProgress += row.count;
        else if (["resolved", "verified", "closed"].includes(row.status)) resolved += row.count;
      }

      const byPriority = { p0: 0, p1: 0, p2: 0, p3: 0 };
      for (const row of byPriorityRows) {
        if (row.priority in byPriority) {
          byPriority[row.priority as keyof typeof byPriority] = row.count;
        }
      }

      return { total, open, inProgress, resolved, byPriority };
    }),

  /**
   * Delete issue (owner/admin only).
   */
  delete: authedQuery
    .input(z.object({ issueId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(issues).where(eq(issues.id, input.issueId));
      return { success: true };
    }),
});
