import { z } from "zod";
import { createRouter, adminQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  users, feedback, swarmRuns, featureFlags,
  projects, ssoConnections, marketplaceListings, blindReviewTasks, waitlistEntries
} from "@db/schema";
import { eq, sql, desc, and, or, like, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { signScreenshotUrl } from "../lib/screenshotUrls";
import { encryptClientSecret, maskSecret, normalizeDomain } from "../services/sso";
import { logAdminAction } from "../services/adminAudit";
import { adminDemotionError } from "../lib/adminGuards";
import { adminAuditLog } from "@db/schema";

export const adminRouter = createRouter({
  // ─── User Management ───────────────────────────────────────────────
  listUsers: adminQuery
    .input(z.object({
      page: z.number().min(1).default(1),
      pageSize: z.number().min(1).max(100).default(20),
      search: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      const offset = (input.page - 1) * input.pageSize;

      // Search matches username, name AND email; the same filter drives both
      // the page query and the total count (previously count ignored it).
      const whereClause = input.search
        ? or(
            like(users.username, `%${input.search}%`),
            like(users.name, `%${input.search}%`),
            like(users.email, `%${input.search}%`),
          )
        : undefined;

      const allUsers = await db.select({
        id: users.id,
        username: users.username,
        name: users.name,
        email: users.email,
        role: users.role,
        tier: users.tier,
        createdAt: users.createdAt,
        lastSignInAt: users.lastSignInAt,
        projectCount: sql<number>`(SELECT COUNT(*) FROM projects WHERE projects.user_id = ${users.id})`,
        runCount: sql<number>`(SELECT COUNT(*) FROM swarm_runs WHERE swarm_runs.user_id = ${users.id})`,
      }).from(users)
        .where(whereClause)
        .limit(input.pageSize).offset(offset);
      const [{ total }] = await db.select({ total: sql<number>`COUNT(*)` }).from(users).where(whereClause);

      return { users: allUsers, total: Number(total), page: input.page, pageSize: input.pageSize };
    }),

  setUserRole: adminQuery
    .input(z.object({ userId: z.number(), role: z.enum(["user", "admin"]) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      // Lockout guard: never allow self-demotion or demoting the last admin.
      const [target] = await db.select({ role: users.role }).from(users)
        .where(eq(users.id, input.userId)).limit(1);
      if (!target) throw new Error("User not found");
      const [{ adminCount }] = await db
        .select({ adminCount: sql<number>`COUNT(*)` }).from(users)
        .where(eq(users.role, "admin"));
      const guardError = adminDemotionError({
        actorId: ctx.user.id,
        targetId: input.userId,
        targetIsAdmin: target.role === "admin",
        adminCount: Number(adminCount),
        newRole: input.role,
      });
      if (guardError) throw new Error(guardError);

      await db.update(users).set({ role: input.role }).where(eq(users.id, input.userId));
      logger.info("Admin: user role changed", { targetUserId: input.userId, role: input.role });
      await logAdminAction({
        adminUserId: ctx.user.id, action: "user.set_role",
        targetType: "user", targetId: input.userId,
        detail: { role: input.role, previousRole: target.role }, ip: ctx.remoteIp,
      });
      return { success: true };
    }),

  setUserTier: adminQuery
    .input(z.object({ userId: z.number(), tier: z.enum(["standard", "pro_designer", "pro_auto"]) }))
    .mutation(async ({ input, ctx }) => {
      await getDb().update(users).set({ tier: input.tier }).where(eq(users.id, input.userId));
      logger.info("Admin: user tier changed", { targetUserId: input.userId, tier: input.tier });
      await logAdminAction({
        adminUserId: ctx.user.id, action: "user.set_tier",
        targetType: "user", targetId: input.userId,
        detail: { tier: input.tier }, ip: ctx.remoteIp,
      });
      return { success: true };
    }),

  // ─── Feedback Management (CRITICAL for beta testing) ───────────────
  listAllFeedback: adminQuery
    .input(z.object({
      page: z.number().min(1).default(1),
      pageSize: z.number().min(1).max(100).default(20),
      status: z.enum(["new", "triaged", "in_progress", "resolved", "verified", "closed"]).optional(),
      severity: z.enum(["critical", "major", "minor", "cosmetic"]).optional(),
      feedbackType: z.enum(["bug", "suggestion", "praise", "confusion"]).optional(),
      projectId: z.number().optional(),
      userId: z.number().optional(),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      const offset = (input.page - 1) * input.pageSize;
      
      // Build where conditions
      const conditions = [];
      if (input.status) conditions.push(eq(feedback.status, input.status));
      if (input.severity) conditions.push(eq(feedback.severity, input.severity));
      if (input.feedbackType) conditions.push(eq(feedback.feedbackType, input.feedbackType));
      if (input.projectId) conditions.push(eq(feedback.projectId, input.projectId));
      if (input.userId) conditions.push(eq(feedback.userId, input.userId));

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
      
      const items = await db.select({
        id: feedback.id,
        userId: feedback.userId,
        username: users.username,
        projectId: feedback.projectId,
        feedbackType: feedback.feedbackType,
        severity: feedback.severity,
        status: feedback.status,
        content: feedback.content,
        screenshotUrl: feedback.screenshotUrl,
        contextJson: feedback.contextJson,
        createdAt: feedback.createdAt,
      })
        .from(feedback)
        .leftJoin(users, eq(feedback.userId, users.id))
        .where(whereClause)
        .orderBy(desc(feedback.createdAt))
        .limit(input.pageSize)
        .offset(offset);

      // Get total count with same filters
      const [{ total }] = await db.select({ total: sql<number>`COUNT(*)` })
        .from(feedback)
        .where(whereClause);
      
      // Decorate stored screenshot paths with short-lived signed URLs so the
      // admin panel can render them in <img> tags (see api/lib/screenshotUrls.ts).
      const decorated = items.map((r) => ({
        ...r,
        screenshotUrl: r.screenshotUrl ? signScreenshotUrl(r.screenshotUrl) : r.screenshotUrl,
      }));

      return { items: decorated, total: Number(total), page: input.page, pageSize: input.pageSize };
    }),

  updateFeedbackStatus: adminQuery
    .input(z.object({
      feedbackId: z.number(),
      status: z.enum(["new", "triaged", "in_progress", "resolved", "verified", "closed"]),
      assignedTo: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const updates: Record<string, any> = { status: input.status };
      if (input.assignedTo !== undefined) updates.assignedTo = input.assignedTo;

      await getDb().update(feedback).set(updates).where(eq(feedback.id, input.feedbackId));
      await logAdminAction({
        adminUserId: ctx.user.id, action: "feedback.update_status",
        targetType: "feedback", targetId: input.feedbackId,
        detail: { status: input.status, assignedTo: input.assignedTo }, ip: ctx.remoteIp,
      });
      return { success: true };
    }),

  // ─── System Stats ──────────────────────────────────────────────────
  systemStats: adminQuery.query(async () => {
    const db = getDb();
    
    const [userStats] = await db.select({
      total: sql<number>`COUNT(*)`,
      active7d: sql<number>`COUNT(CASE WHEN last_sign_in_at > DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 END)`,
      byTier: sql<Record<string, number>>`JSON_OBJECT(
        'standard', COUNT(CASE WHEN tier = 'standard' THEN 1 END),
        'pro_designer', COUNT(CASE WHEN tier = 'pro_designer' THEN 1 END),
        'pro_auto', COUNT(CASE WHEN tier = 'pro_auto' THEN 1 END)
      )`,
    }).from(users);

    const [runStats] = await db.select({
      total: sql<number>`COUNT(*)`,
      completed: sql<number>`COUNT(CASE WHEN status = 'completed' THEN 1 END)`,
      failed: sql<number>`COUNT(CASE WHEN status = 'failed' THEN 1 END)`,
      totalTokens: sql<number>`COALESCE(SUM(total_tokens_used), 0)`,
    }).from(swarmRuns);

    const [feedbackStats] = await db.select({
      total: sql<number>`COUNT(*)`,
      open: sql<number>`COUNT(CASE WHEN status IN ('new', 'triaged', 'in_progress') THEN 1 END)`,
      critical: sql<number>`COUNT(CASE WHEN severity = 'critical' AND status != 'closed' THEN 1 END)`,
    }).from(feedback);

    const [projectCount] = await db.select({ total: sql<number>`COUNT(*)` }).from(projects);

    return {
      users: userStats,
      runs: runStats,
      feedback: feedbackStats,
      projects: projectCount,
      uptime: process.uptime(),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    };
  }),

  // ─── Feature Flags ─────────────────────────────────────────────────
  listFeatureFlags: adminQuery.query(async () => {
    return getDb().select().from(featureFlags);
  }),

  toggleFeatureFlag: adminQuery
    .input(z.object({ key: z.string(), enabled: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      await getDb().update(featureFlags)
        .set({ enabled: input.enabled })
        .where(eq(featureFlags.key, input.key));
      logger.info("Feature flag toggled", { key: input.key, enabled: input.enabled });
      await logAdminAction({
        adminUserId: ctx.user.id, action: "feature_flag.toggle",
        targetType: "feature_flag", targetId: input.key,
        detail: { enabled: input.enabled }, ip: ctx.remoteIp,
      });
      return { success: true };
    }),

  // ─── Admin audit trail (persistent; Batch B 2026-07-28) ────────────
  listAdminAuditLog: adminQuery
    .input(z.object({
      page: z.number().min(1).default(1),
      pageSize: z.number().min(1).max(100).default(50),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      const offset = (input.page - 1) * input.pageSize;
      const items = await db.select({
        id: adminAuditLog.id,
        adminUserId: adminAuditLog.adminUserId,
        adminUsername: users.username,
        action: adminAuditLog.action,
        targetType: adminAuditLog.targetType,
        targetId: adminAuditLog.targetId,
        detail: adminAuditLog.detail,
        ip: adminAuditLog.ip,
        createdAt: adminAuditLog.createdAt,
      })
        .from(adminAuditLog)
        .leftJoin(users, eq(adminAuditLog.adminUserId, users.id))
        .orderBy(desc(adminAuditLog.createdAt))
        .limit(input.pageSize).offset(offset);
      const [{ total }] = await db.select({ total: sql<number>`COUNT(*)` }).from(adminAuditLog);
      return { items, total: Number(total), page: input.page, pageSize: input.pageSize };
    }),

  // ─── SSO Connections (Phase 3, enterprise_sso) ───────────────────
  // Client secrets are write-only: masked in list responses, encrypted
  // (AES-256-GCM via cryptoService) before any DB write.

  ssoListConnections: adminQuery.query(async () => {
    const rows = await getDb().select().from(ssoConnections)
      .orderBy(desc(ssoConnections.createdAt));
    return rows.map((r) => ({
      ...r,
      oidcClientSecretEnc: maskSecret(r.oidcClientSecretEnc),
    }));
  }),

  ssoUpsertConnection: adminQuery
    .input(z.object({
      id: z.number().int().positive().optional(),
      type: z.enum(["oidc", "saml"]),
      domain: z.string().min(1).max(255),
      displayName: z.string().min(1).max(255),
      enabled: z.boolean().default(true),
      oidcIssuer: z.string().max(512).optional().nullable(),
      oidcClientId: z.string().max(255).optional().nullable(),
      // Plaintext secret on write only. Omitted → existing secret preserved.
      oidcClientSecret: z.string().max(1024).optional(),
      oidcScopes: z.string().max(255).optional(),
      samlEntryPoint: z.string().max(512).optional().nullable(),
      samlIssuer: z.string().max(512).optional().nullable(),
      samlCert: z.string().optional().nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const domain = normalizeDomain(input.domain);
      if (!domain) throw new Error("A valid email domain is required");

      // Full-replacement semantics for non-secret fields (omitted → NULL);
      // the encrypted secret is only overwritten when a new one is supplied.
      const row = {
        type: input.type,
        domain,
        displayName: input.displayName,
        enabled: input.enabled,
        oidcIssuer: input.oidcIssuer ?? null,
        oidcClientId: input.oidcClientId ?? null,
        oidcScopes: input.oidcScopes ?? "openid email profile",
        samlEntryPoint: input.samlEntryPoint ?? null,
        samlIssuer: input.samlIssuer ?? null,
        samlCert: input.samlCert ?? null,
        ...(input.oidcClientSecret
          ? { oidcClientSecretEnc: encryptClientSecret(input.oidcClientSecret) }
          : {}),
      };

      if (input.type === "oidc" && (!row.oidcIssuer || !row.oidcClientId)) {
        throw new Error("oidcIssuer and oidcClientId are required for OIDC connections");
      }
      if (input.type === "saml" && (!row.samlEntryPoint || !row.samlIssuer || !row.samlCert)) {
        throw new Error("samlEntryPoint, samlIssuer and samlCert are required for SAML connections");
      }

      try {
        if (input.id) {
          await db.update(ssoConnections).set(row).where(eq(ssoConnections.id, input.id));
        } else {
          await db.insert(ssoConnections).values(row);
        }
      } catch (err) {
        const m = (err as Error).message ?? "";
        if (m.includes("Duplicate entry") || m.includes("ER_DUP_ENTRY")) {
          throw new Error("An SSO connection already exists for this domain");
        }
        throw err;
      }

      const [saved] = await db.select().from(ssoConnections)
        .where(eq(ssoConnections.domain, domain)).limit(1);
      logger.info("Admin: SSO connection upserted", {
        connectionId: saved?.id ?? input.id,
        type: input.type,
        domain,
      });
      await logAdminAction({
        adminUserId: ctx.user.id, action: "sso.upsert_connection",
        targetType: "sso_connection", targetId: saved?.id ?? input.id,
        detail: { type: input.type, domain, enabled: input.enabled }, ip: ctx.remoteIp,
      });
      return {
        success: true,
        id: saved?.id ?? input.id,
        connection: saved ? { ...saved, oidcClientSecretEnc: maskSecret(saved.oidcClientSecretEnc) } : null,
      };
    }),

  ssoDeleteConnection: adminQuery
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await getDb().delete(ssoConnections).where(eq(ssoConnections.id, input.id));
      logger.info("Admin: SSO connection deleted", { connectionId: input.id });
      await logAdminAction({
        adminUserId: ctx.user.id, action: "sso.delete_connection",
        targetType: "sso_connection", targetId: input.id,
        ip: ctx.remoteIp,
      });
      return { success: true };
    }),

  // ─── Certification queue (Trust Phase 0 ops, Batch B 2026-07-28) ────
  // Listings by pipeline stage with last-activity age and blind-pool stats,
  // so stuck states (e.g. orphaned `generating`) are visible without SQL.
  certificationQueue: adminQuery.query(async () => {
    const db = getDb();
    const rows = await db.select({
      id: marketplaceListings.id,
      title: marketplaceListings.title,
      status: marketplaceListings.status,
      grade: marketplaceListings.grade,
      aiGrade: marketplaceListings.aiGrade,
      kappaScore: marketplaceListings.kappaScore,
      reviewCount: marketplaceListings.reviewCount,
      createdAt: marketplaceListings.createdAt,
      updatedAt: marketplaceListings.updatedAt,
      creatorId: marketplaceListings.creatorId,
      creatorUsername: users.username,
      poolTotal: sql<number>`(SELECT COUNT(*) FROM blind_review_tasks t WHERE t.listing_id = ${marketplaceListings.id})`,
      poolCompleted: sql<number>`(SELECT COUNT(*) FROM blind_review_tasks t WHERE t.listing_id = ${marketplaceListings.id} AND t.status = 'completed')`,
    })
      .from(marketplaceListings)
      .leftJoin(users, eq(marketplaceListings.creatorId, users.id))
      .where(inArray(marketplaceListings.status, [
        "generating", "pending_review", "reviewing", "certifying", "rejected", "published",
      ]))
      .orderBy(sql`FIELD(${marketplaceListings.status}, 'generating','pending_review','reviewing','certifying','rejected','published')`, desc(marketplaceListings.updatedAt))
      .limit(200);

    return rows.map((r) => {
      const lastActivity = r.updatedAt ?? r.createdAt;
      const ageMinutes = lastActivity
        ? Math.max(0, Math.floor((Date.now() - new Date(lastActivity).getTime()) / 60000))
        : null;
      return {
        ...r,
        ageMinutes,
        // A listing stuck in `generating` beyond one full generation cycle
        // (~30 min) means the fire-and-forget block died — needs requeue.
        stuck: r.status === "generating" && ageMinutes !== null && ageMinutes > 30,
      };
    });
  }),

  requeueCertification: adminQuery
    .input(z.object({ listingId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [listing] = await db
        .select({ id: marketplaceListings.id, status: marketplaceListings.status })
        .from(marketplaceListings)
        .where(eq(marketplaceListings.id, input.listingId))
        .limit(1);
      if (!listing) throw new Error("Listing not found");

      if (listing.status === "generating") {
        // Stuck/orphaned background generation → back to draft so the creator
        // can resubmit (resubmission is idempotent: prompts/pool are reset).
        await db.update(marketplaceListings)
          .set({ status: "draft" })
          .where(eq(marketplaceListings.id, input.listingId));
        logger.info("Admin: certification requeued to draft", { listingId: input.listingId });
        await logAdminAction({
          adminUserId: ctx.user.id, action: "certification.requeue",
          targetType: "marketplace_listing", targetId: input.listingId,
          detail: { from: "generating", to: "draft" }, ip: ctx.remoteIp,
        });
        return { success: true, action: "reset_to_draft" as const };
      }

      if (listing.status === "certifying") {
        // Certifying but the blind pool was never created (enqueue crashed).
        const [{ pooled }] = await db
          .select({ pooled: sql<number>`COUNT(*)` })
          .from(blindReviewTasks)
          .where(eq(blindReviewTasks.listingId, input.listingId));
        if (Number(pooled) > 0) {
          throw new Error("Listing already has blind review tasks — nothing to requeue");
        }
        const { enqueueBlindReviewTasks } = await import("./marketplace");
        const created = await enqueueBlindReviewTasks(input.listingId);
        logger.info("Admin: blind pool recreated", { listingId: input.listingId, tasks: created });
        await logAdminAction({
          adminUserId: ctx.user.id, action: "certification.requeue",
          targetType: "marketplace_listing", targetId: input.listingId,
          detail: { from: "certifying", to: "certifying", tasksCreated: created }, ip: ctx.remoteIp,
        });
        return { success: true, action: "pool_recreated" as const, tasks: created };
      }

      if (listing.status === "reviewing" || listing.status === "pending_review") {
        // Stuck/orphaned review pool (reviewer pool never filled) → back to
        // pending_review so the pool can be re-opened.
        await db.update(marketplaceListings)
          .set({ status: "pending_review" })
          .where(eq(marketplaceListings.id, input.listingId));
        logger.info("Admin: certification returned to pending_review", { listingId: input.listingId });
        await logAdminAction({
          adminUserId: ctx.user.id, action: "certification.requeue",
          targetType: "marketplace_listing", targetId: input.listingId,
          detail: { from: listing.status, to: "pending_review" }, ip: ctx.remoteIp,
        });
        return { success: true, action: "returned_to_pending_review" as const };
      }

      throw new Error(`Cannot requeue a listing in status "${listing.status}"`);
    }),
  // ─── Waitlist (Pioneer 100 beta ops, Batch D 2026-07-29) ────────────
  listWaitlist: adminQuery
    .input(z.object({
      page: z.number().min(1).default(1),
      pageSize: z.number().min(1).max(100).default(20),
      search: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      const offset = (input.page - 1) * input.pageSize;
      const whereClause = input.search
        ? like(waitlistEntries.email, `%${input.search}%`)
        : undefined;

      const items = await db.select({
        id: waitlistEntries.id,
        email: waitlistEntries.email,
        role: waitlistEntries.role,
        ref: waitlistEntries.ref,
        referralCode: waitlistEntries.referralCode,
        invitedAt: waitlistEntries.invitedAt,
        createdAt: waitlistEntries.createdAt,
        position: sql<number>`(SELECT COUNT(*) FROM waitlist_entries w2 WHERE w2.id <= ${waitlistEntries.id})`,
        referralCount: sql<number>`(SELECT COUNT(*) FROM waitlist_entries w2 WHERE w2.ref = ${waitlistEntries.referralCode})`,
      })
        .from(waitlistEntries)
        .where(whereClause)
        .orderBy(waitlistEntries.id)
        .limit(input.pageSize)
        .offset(offset);

      // Resolve referred-by emails where possible
      const referrerEmails: Record<string, string> = {};
      for (const item of items) {
        if (item.ref && !referrerEmails[item.ref]) {
          const [referrer] = await db.select({ email: waitlistEntries.email })
            .from(waitlistEntries)
            .where(eq(waitlistEntries.referralCode, item.ref))
            .limit(1);
          referrerEmails[item.ref] = referrer?.email ?? item.ref;
        }
      }

      const enriched = items.map((r) => ({
        ...r,
        referredBy: r.ref ? (referrerEmails[r.ref] ?? r.ref) : null,
      }));

      const [{ total }] = await db.select({ total: sql<number>`COUNT(*)` })
        .from(waitlistEntries)
        .where(whereClause);

      return { items: enriched, total: Number(total), page: input.page, pageSize: input.pageSize };
    }),

  markWaitlistInvited: adminQuery
    .input(z.object({ entryId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [entry] = await db.select({ id: waitlistEntries.id, email: waitlistEntries.email })
        .from(waitlistEntries)
        .where(eq(waitlistEntries.id, input.entryId))
        .limit(1);
      if (!entry) throw new Error("Waitlist entry not found");

      await db.update(waitlistEntries)
        .set({ invitedAt: new Date() })
        .where(eq(waitlistEntries.id, input.entryId));

      logger.info("Admin: waitlist entry marked invited", { entryId: input.entryId, email: entry.email });
      await logAdminAction({
        adminUserId: ctx.user.id, action: "waitlist.invite",
        targetType: "waitlist_entry", targetId: input.entryId,
        detail: { email: entry.email }, ip: ctx.remoteIp,
      });
      return { success: true };
    }),
});
