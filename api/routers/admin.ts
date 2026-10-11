import { z } from "zod";
import { createRouter, adminQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  users, feedback, swarmRuns, featureFlags,
  projects, ssoConnections, marketplaceListings, blindReviewTasks, waitlistEntries,
  trustedProviderEndpoints, modelCatalog, modelReleaseEvents,
  evidencePublications, benchmarks, callAttempts, spendApprovals,
} from "@db/schema";
import { eq, sql, desc, and, or, like, inArray, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { signScreenshotUrl } from "../lib/screenshotUrls";
import { encryptClientSecret, maskSecret, normalizeDomain } from "../services/sso";
import { logAdminAction } from "../services/adminAudit";
import { adminDemotionError } from "../lib/adminGuards";
import { setLegacyListingStatus } from "../services/marketplacePublication";
import {
  listPromotions,
  createPromotion,
  setPromotionActive,
} from "../services/promotionService";
import { adminAuditLog } from "@db/schema";
import {
  PROTECTED_EGRESS_POLICY_VERSION, normalizeEndpointUrl, resolvedAdapterKind,
} from "../services/protectedEgress";
import { benchmarkLedgerTotals, costDisclosure, repriceUnpricedOperations, type CostDisclosureInput } from "../services/benchmark/benchmarkLedger";
import { readAttachmentForSupport, summarizeAttachments } from "../services/feedbackAttachments";
import { PublicEvidenceManifestSchema } from "../../contracts/offeringV2";

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
        createdAt: users.createdAt,
        lastSignInAt: users.lastSignInAt,
        // The outer table has to be spelled out. drizzle emits an UNQUALIFIED
        // column for `${users.id}` inside raw sql — verified by `toSQL()`, which
        // renders ``projects.user_id = `id` `` — and MySQL then resolves `id` to
        // the subquery's own table, silently turning a correlated count into
        // `projects.user_id = projects.id`.
        projectCount: sql<number>`(SELECT COUNT(*) FROM projects WHERE projects.user_id = users.id)`,
        runCount: sql<number>`(SELECT COUNT(*) FROM swarm_runs WHERE swarm_runs.user_id = users.id)`,
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

  // NOTE: the old `setUserTier` mutation was removed with the tier ladder
  // (owner decision 2026-09-22) — `users.tier` is legacy data that gates
  // nothing, so there is no admin lever for it any more.

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
        // D11: how many objects the author consented to attach. The outer table
        // has to be spelled out — drizzle emits an UNQUALIFIED column for
        // `${feedback.id}` inside raw sql and MySQL then binds `id` to
        // `feedback_attachments`' own row, turning a correlated count into a
        // constant (finding #36, fixed in `99ffa9b` for the five older fields
        // below that had it). See also `listUsers.projectCount`,
        // `certificationQueue.poolTotal`, `listWaitlist.position`.
        attachmentCount: sql<number>`(SELECT COUNT(*) FROM feedback_attachments WHERE feedback_attachments.feedback_id = feedback.id)`,
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
      //
      // The attachment SUMMARY is the second half: what was attached, under
      // which consent version, and whether the stored snapshot is a redacted
      // view — deliberately NOT the payload, which can be several kilobytes of
      // prompt text per row and is a per-attachment read
      // (`feedbackAttachmentDetail`). A support list never drags every attached
      // prompt across the wire by accident.
      const summaries = await summarizeAttachments(items.map((i) => i.id));
      const decorated = items.map((r) => ({
        ...r,
        attachmentCount: Number(r.attachmentCount),
        attachments: summaries.get(r.id) ?? [],
        screenshotUrl: r.screenshotUrl ? signScreenshotUrl(r.screenshotUrl) : r.screenshotUrl,
      }));

      return { items: decorated, total: Number(total), page: input.page, pageSize: input.pageSize };
    }),

  // One consented attachment, payload included, for the support desk. Admin-only
  // by the middleware, and this widens nothing: the snapshot was written
  // through the consenting author's OWN read projection, so what is stored here
  // is exactly what that account could already see (spec A12 — see
  // api/services/feedbackAttachments.ts).
  feedbackAttachmentDetail: adminQuery
    .input(z.object({ attachmentId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const row = await readAttachmentForSupport(input.attachmentId);
      logger.info("Admin: feedback attachment read", {
        attachmentId: input.attachmentId, adminUserId: ctx.user.id,
        kind: row.kind, refId: row.refId, visibility: row.visibility,
      });
      await logAdminAction({
        adminUserId: ctx.user.id, action: "feedback.read_attachment",
        targetType: "feedback_attachment", targetId: input.attachmentId,
        // The ids and the shape only — never the content, which is the whole
        // reason this read is audited at all.
        detail: { kind: row.kind, refId: row.refId, consentVersion: row.consentVersion, visibility: row.visibility },
        ip: ctx.remoteIp,
      });
      return row;
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
      // Per-tier counts were removed with the tier ladder (2026-09-22):
      // `users.tier` is legacy data that gates nothing, so splitting the
      // audience by it reports a distinction the product no longer makes.
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
      poolTotal: sql<number>`(SELECT COUNT(*) FROM blind_review_tasks t WHERE t.listing_id = marketplace_listings.id)`,
      poolCompleted: sql<number>`(SELECT COUNT(*) FROM blind_review_tasks t WHERE t.listing_id = marketplace_listings.id AND t.status = 'completed')`,
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
        await setLegacyListingStatus(input.listingId, { status: "draft" });
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
        await setLegacyListingStatus(input.listingId, { status: "pending_review" });
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
        position: sql<number>`(SELECT COUNT(*) FROM waitlist_entries w2 WHERE w2.id <= waitlist_entries.id)`,
        referralCount: sql<number>`(SELECT COUNT(*) FROM waitlist_entries w2 WHERE w2.ref = waitlist_entries.referral_code)`,
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

  // ─── Promotions: admin-defined free days (ticket #62) ─────────────
  // A promotion grants free days on the one flat subscription; it is a Stripe
  // trial, not a discount, so nothing here touches the price. The rules live in
  // api/services/promotionService.ts — these procedures only gate and audit.
  listPromotions: adminQuery.query(async () => {
    return { promotions: await listPromotions() };
  }),

  createPromotion: adminQuery
    .input(z.object({
      name: z.string().min(1).max(80),
      days: z.number().int().min(1).max(365),
      audience: z.enum(["new_signups", "code"]),
      code: z.string().max(32).nullish(),
      startsAt: z.coerce.date().nullish(),
      endsAt: z.coerce.date().nullish(),
      maxRedemptions: z.number().int().min(1).nullish(),
      note: z.string().max(200).nullish(),
    }))
    .mutation(async ({ input, ctx }) => {
      const promo = await createPromotion({
        name: input.name,
        days: input.days,
        audience: input.audience,
        code: input.code ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        maxRedemptions: input.maxRedemptions ?? null,
        note: input.note ?? null,
      }, ctx.user.id);
      await logAdminAction({
        adminUserId: ctx.user.id, action: "promotion.create",
        targetType: "promotion", targetId: promo.id,
        detail: { days: promo.days, audience: promo.audience, code: promo.code, maxRedemptions: promo.maxRedemptions },
        ip: ctx.remoteIp,
      });
      return promo;
    }),

  // Deactivation stops FUTURE grants. Rows already granted live in
  // promotion_redemptions with their own copy of the days, so this cannot take
  // back anything somebody already received.
  setPromotionActive: adminQuery
    .input(z.object({ id: z.number().int().positive(), active: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      await setPromotionActive(input.id, input.active, ctx.user.id);
      await logAdminAction({
        adminUserId: ctx.user.id, action: input.active ? "promotion.reactivate" : "promotion.deactivate",
        targetType: "promotion", targetId: input.id,
        detail: { active: input.active }, ip: ctx.remoteIp,
      });
      return { success: true };
    }),

  // ═══ V2 OPERATIONS (spec D10) ═══════════════════════════════════════
  // Four areas that had no screen at all: trusted provider endpoints, the
  // reviewed model catalog, evidence publications, and the spend ledger.
  // Everything here is OPERATIONAL METADATA — no procedure reads or writes a
  // user's private work content (prompts, definitions, outputs), and no read
  // mutates a row.

  // ─── Trusted provider endpoints (spec §8.2) ───────────────────────
  // A protected buyer run may only reach an EXACT enabled row of this table,
  // matched on provider slug + normalized base URL + adapter kind. The table
  // ships empty, which is the only reason the drill stops before the egress
  // gate — so the list below reports each row by the gate's own predicate,
  // including whether the row could ever match at all.

  listTrustedEndpoints: adminQuery
    .input(z.object({
      enabledOnly: z.boolean().optional(),
      provider: z.string().max(80).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      const conditions = [];
      if (input?.enabledOnly) conditions.push(eq(trustedProviderEndpoints.enabled, true));
      if (input?.provider) conditions.push(eq(trustedProviderEndpoints.provider, input.provider.trim().toLowerCase()));
      const rows = await db.select({
        id: trustedProviderEndpoints.id,
        provider: trustedProviderEndpoints.provider,
        baseUrl: trustedProviderEndpoints.baseUrl,
        adapterKind: trustedProviderEndpoints.adapterKind,
        endpointClass: trustedProviderEndpoints.endpointClass,
        loggingDisclosure: trustedProviderEndpoints.loggingDisclosure,
        protectionClass: trustedProviderEndpoints.protectionClass,
        approvedBy: trustedProviderEndpoints.approvedBy,
        approvedByUsername: users.username,
        policyVersion: trustedProviderEndpoints.policyVersion,
        enabled: trustedProviderEndpoints.enabled,
        createdAt: trustedProviderEndpoints.createdAt,
      })
        .from(trustedProviderEndpoints)
        .leftJoin(users, eq(trustedProviderEndpoints.approvedBy, users.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(trustedProviderEndpoints.id));

      return rows.map((r) => {
        // `normalizeEndpointUrl` is the same function the gate runs on both
        // sides of the comparison, so a row that will not normalize here is a
        // row that can never be reached there — reported, not hidden.
        let normalizedBaseUrl: string | null = null;
        let urlUnusable: string | null = null;
        try {
          normalizedBaseUrl = normalizeEndpointUrl(r.baseUrl);
        } catch (err) {
          urlUnusable = (err as Error).message;
        }
        const expectedAdapterKind = resolvedAdapterKind(r.provider);
        const adapterMatchesProvider = r.adapterKind === expectedAdapterKind;
        return {
          ...r,
          normalizedBaseUrl,
          urlUnusable,
          expectedAdapterKind,
          adapterMatchesProvider,
          // The destination, named exactly as a protected run must match it.
          matchKey: normalizedBaseUrl ? `${r.provider} ${normalizedBaseUrl} ${r.adapterKind}` : null,
          liveForGate: !!normalizedBaseUrl && adapterMatchesProvider && r.enabled,
        };
      });
    }),

  approveTrustedEndpoint: adminQuery
    .input(z.object({
      provider: z.string().min(1).max(80).describe("The provider slug the adapter router serves (e.g. openai, anthropic, together)"),
      baseUrl: z.string().min(8).max(512).describe("Stored normalized; https only, no credentials, query or fragment"),
      // Optional: it defaults to the adapter this provider actually builds, and
      // a mismatch is refused, because a row naming the wrong adapter is
      // invisible to the gate and would read as "approved" to a human.
      adapterKind: z.enum(["anthropic", "openai_compatible"]).optional(),
      endpointClass: z.enum(["first_party", "approved_proxy"]).default("first_party"),
      // MANDATORY disclosures (§8.2): the product's promise is that we name the
      // destination AND record its logging posture before the run.
      loggingDisclosure: z.string().min(20).max(2000)
        .describe("What this provider records/retains about protected-run inputs — reviewer-verified, never a placeholder"),
      protectionClass: z.enum(["standard", "reduced"])
        .describe("No default on purpose: an admin must state the protection class for this destination"),
      policyVersion: z.string().min(1).max(40).default(PROTECTED_EGRESS_POLICY_VERSION),
      enabled: z.boolean().default(true),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const provider = input.provider.trim().toLowerCase();
      const expectedAdapterKind = resolvedAdapterKind(provider);
      const adapterKind = input.adapterKind ?? expectedAdapterKind;
      if (adapterKind !== expectedAdapterKind) {
        throw new Error(
          `adapter_kind_mismatch: provider "${provider}" is served by the ${expectedAdapterKind} adapter. `
          + `An approved row naming "${adapterKind}" could never be matched by a protected run, so it is refused.`,
        );
      }
      let baseUrl: string;
      try {
        baseUrl = normalizeEndpointUrl(input.baseUrl);
      } catch (err) {
        throw new Error(`endpoint_refused: ${(err as Error).message}`);
      }

      const [existing] = await db.select({ id: trustedProviderEndpoints.id })
        .from(trustedProviderEndpoints)
        .where(and(eq(trustedProviderEndpoints.provider, provider), eq(trustedProviderEndpoints.baseUrl, baseUrl)))
        .limit(1);
      // Approval never silently rewrites a reviewed disclosure. To change one,
      // a new approval must be an explicit decision, not a side effect.
      if (existing) {
        throw new Error(`already_approved: ${provider} ${baseUrl} is approved as endpoint #${existing.id} — enable/disable that row instead of re-approving it`);
      }

      try {
        await db.insert(trustedProviderEndpoints).values({
          provider, baseUrl, adapterKind,
          endpointClass: input.endpointClass,
          loggingDisclosure: input.loggingDisclosure.trim(),
          protectionClass: input.protectionClass,
          approvedBy: ctx.user.id,
          policyVersion: input.policyVersion.trim(),
          enabled: input.enabled,
        });
      } catch (err) {
        const m = (err as Error).message ?? "";
        if (m.includes("Duplicate entry") || m.includes("ER_DUP_ENTRY")) {
          throw new Error("already_approved: another admin approved this (provider, baseUrl) a moment ago");
        }
        throw err;
      }

      const [saved] = await db.select({ id: trustedProviderEndpoints.id })
        .from(trustedProviderEndpoints)
        .where(and(eq(trustedProviderEndpoints.provider, provider), eq(trustedProviderEndpoints.baseUrl, baseUrl)))
        .limit(1);
      logger.info("Admin: provider endpoint approved", {
        endpointId: saved?.id, provider, baseUrl, adapterKind, protectionClass: input.protectionClass,
      });
      await logAdminAction({
        adminUserId: ctx.user.id, action: "trusted_endpoint.approve",
        targetType: "trusted_provider_endpoint", targetId: saved?.id ?? null,
        detail: {
          provider, baseUrl, adapterKind, endpointClass: input.endpointClass,
          protectionClass: input.protectionClass, policyVersion: input.policyVersion, enabled: input.enabled,
        }, ip: ctx.remoteIp,
      });
      return { success: true, endpointId: saved?.id ?? null, normalizedBaseUrl: baseUrl };
    }),

  setTrustedEndpointEnabled: adminQuery
    .input(z.object({ endpointId: z.number().int().positive(), enabled: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [row] = await db.select({
        id: trustedProviderEndpoints.id, provider: trustedProviderEndpoints.provider,
        baseUrl: trustedProviderEndpoints.baseUrl, enabled: trustedProviderEndpoints.enabled,
      }).from(trustedProviderEndpoints).where(eq(trustedProviderEndpoints.id, input.endpointId)).limit(1);
      if (!row) throw new Error("Endpoint not found");

      await db.update(trustedProviderEndpoints)
        .set({ enabled: input.enabled })
        .where(eq(trustedProviderEndpoints.id, input.endpointId));
      logger.info("Admin: trusted endpoint enabled state changed", { endpointId: input.endpointId, enabled: input.enabled });
      await logAdminAction({
        adminUserId: ctx.user.id, action: "trusted_endpoint.set_enabled",
        targetType: "trusted_provider_endpoint", targetId: input.endpointId,
        detail: { enabled: input.enabled, previousEnabled: row.enabled, provider: row.provider, baseUrl: row.baseUrl },
        ip: ctx.remoteIp,
      });
      return { success: true, enabled: input.enabled };
    }),

  // ─── Model catalog (spec §12.1, D12 vendor attribution) ───────────
  // The reviewed catalog's reads, plus the one lever that was missing: setting
  // or correcting `vendor` (the model's DEVELOPER). Without it the evidence
  // panel's refusal — "ask an admin to record its vendor in the catalog" — was
  // an instruction with no destination. Writing an ENTRY still goes through
  // modelCatalog.recordModel, which keeps its lineage validation and its
  // refresh-instead-of-duplicate behaviour.

  listModelCatalog: adminQuery
    .input(z.object({
      page: z.number().min(1).default(1),
      pageSize: z.number().min(1).max(100).default(20),
      search: z.string().optional(),
      // The operator's actual question after a D12 refusal: which reviewed
      // identities still name no developer?
      missingVendorOnly: z.boolean().optional(),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      const offset = (input.page - 1) * input.pageSize;
      const conditions = [];
      if (input.search) {
        conditions.push(or(
          like(modelCatalog.modelId, `%${input.search}%`),
          like(modelCatalog.provider, `%${input.search}%`),
          like(modelCatalog.vendor, `%${input.search}%`),
          like(modelCatalog.family, `%${input.search}%`),
        ));
      }
      if (input.missingVendorOnly) conditions.push(isNull(modelCatalog.vendor));
      const whereClause = conditions.length ? and(...conditions) : undefined;

      const items = await db.select({
        id: modelCatalog.id,
        provider: modelCatalog.provider,
        modelId: modelCatalog.modelId,
        family: modelCatalog.family,
        vendor: modelCatalog.vendor,
        successorOfModelId: modelCatalog.successorOfModelId,
        availabilitySource: modelCatalog.availabilitySource,
        sourceUrl: modelCatalog.sourceUrl,
        verifiedAt: modelCatalog.verifiedAt,
        availableAt: modelCatalog.availableAt,
        deprecatedAt: modelCatalog.deprecatedAt,
        createdAt: modelCatalog.createdAt,
      }).from(modelCatalog)
        .where(whereClause)
        .orderBy(desc(modelCatalog.id))
        .limit(input.pageSize).offset(offset);

      // Event counts come from a grouped read, not a correlated subquery: inside
      // `(SELECT … FROM model_release_events e WHERE e.model_catalog_id = id)`
      // an unqualified `id` binds to the INNER table, so the count would be
      // "events whose own id happens to equal this row's id" — a number that
      // looks right on the first fixture and is wrong afterwards.
      const catalogIds = items.map((i) => i.id);
      const eventUsage = catalogIds.length
        ? await db.select({ catalogId: modelReleaseEvents.modelCatalogId, used: sql<number>`COUNT(*)` })
            .from(modelReleaseEvents).where(inArray(modelReleaseEvents.modelCatalogId, catalogIds))
            .groupBy(modelReleaseEvents.modelCatalogId)
        : [];
      const eventsById = new Map(eventUsage.map((u) => [u.catalogId, Number(u.used)]));

      const [{ total }] = await db.select({ total: sql<number>`COUNT(*)` })
        .from(modelCatalog).where(whereClause);
      // Catalog-wide, independent of the page: how much of the catalog cannot
      // satisfy the D12 gate yet.
      const [{ vendorless }] = await db.select({ vendorless: sql<number>`COUNT(*)` })
        .from(modelCatalog).where(isNull(modelCatalog.vendor));

      return {
        items: items.map((i) => ({ ...i, releaseEventCount: eventsById.get(i.id) ?? 0 })),
        total: Number(total), vendorMissingTotal: Number(vendorless), page: input.page, pageSize: input.pageSize,
      };
    }),

  setModelVendor: adminQuery
    .input(z.object({
      catalogId: z.number().int().positive(),
      // null clears it back to "unknown", which is the honest answer when no
      // reviewer knows who developed the model — unknown never satisfies the
      // evidence-panel gate, and never collides with another model either.
      vendor: z.string().min(1).max(80).nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [entry] = await db.select({
        id: modelCatalog.id, provider: modelCatalog.provider, modelId: modelCatalog.modelId, vendor: modelCatalog.vendor,
      }).from(modelCatalog).where(eq(modelCatalog.id, input.catalogId)).limit(1);
      if (!entry) throw new Error("catalog_entry_not_found");

      const vendor = input.vendor?.trim().toLowerCase() || null;
      // Only `vendor`. `verifiedAt` records the review of AVAILABILITY and
      // lineage, so touching it here would claim a re-verification that did
      // not happen, and no other reviewed field is in scope for this action.
      await db.update(modelCatalog).set({ vendor }).where(eq(modelCatalog.id, input.catalogId));
      logger.info("Admin: model catalog vendor recorded", { catalogId: input.catalogId, provider: entry.provider, modelId: entry.modelId, vendor });
      await logAdminAction({
        adminUserId: ctx.user.id, action: "model_catalog.set_vendor",
        targetType: "model_catalog", targetId: input.catalogId,
        detail: { provider: entry.provider, modelId: entry.modelId, vendor, previousVendor: entry.vendor },
        ip: ctx.remoteIp,
      });
      return { success: true, vendor };
    }),

  listModelReleaseEvents: adminQuery
    .input(z.object({ page: z.number().min(1).default(1), pageSize: z.number().min(1).max(100).default(20) }))
    .query(async ({ input }) => {
      const db = getDb();
      const offset = (input.page - 1) * input.pageSize;
      const items = await db.select({
        id: modelReleaseEvents.id,
        eventKey: modelReleaseEvents.eventKey,
        relevanceRule: modelReleaseEvents.relevanceRule,
        recordedBy: modelReleaseEvents.recordedBy,
        recordedByUsername: users.username,
        createdAt: modelReleaseEvents.createdAt,
        modelCatalogId: modelReleaseEvents.modelCatalogId,
        provider: modelCatalog.provider,
        modelId: modelCatalog.modelId,
        family: modelCatalog.family,
        vendor: modelCatalog.vendor,
      }).from(modelReleaseEvents)
        .innerJoin(modelCatalog, eq(modelReleaseEvents.modelCatalogId, modelCatalog.id))
        .leftJoin(users, eq(modelReleaseEvents.recordedBy, users.id))
        .orderBy(desc(modelReleaseEvents.id))
        .limit(input.pageSize).offset(offset);
      const [{ total }] = await db.select({ total: sql<number>`COUNT(*)` }).from(modelReleaseEvents);
      return { items, total: Number(total), page: input.page, pageSize: input.pageSize };
    }),

  // ─── Evidence publications (spec §6.2) — READ ONLY ────────────────
  // A withdrawal is the AUTHOR's action (`evidence.withdraw`), never an admin's:
  // an operator who could unpublish someone else's evidence would hold the
  // thing the immutability claim is about. So there is no admin withdraw here.

  listEvidencePublications: adminQuery
    .input(z.object({
      page: z.number().min(1).default(1),
      pageSize: z.number().min(1).max(100).default(20),
      publicationKind: z.enum(["seller", "community"]).optional(),
      state: z.enum(["draft_preview", "published", "withdrawn"]).optional(),
      listingId: z.number().int().positive().optional(),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      const offset = (input.page - 1) * input.pageSize;
      const conditions = [];
      if (input.publicationKind) conditions.push(eq(evidencePublications.publicationKind, input.publicationKind));
      if (input.state) conditions.push(eq(evidencePublications.state, input.state));
      if (input.listingId) conditions.push(eq(evidencePublications.listingId, input.listingId));
      const whereClause = conditions.length ? and(...conditions) : undefined;

      const items = await db.select({
        id: evidencePublications.id,
        authorId: evidencePublications.authorId,
        authorUsername: users.username,
        benchmarkId: evidencePublications.benchmarkId,
        externalReportId: evidencePublications.externalReportId,
        listingId: evidencePublications.listingId,
        listingWorkflowVersionId: evidencePublications.listingWorkflowVersionId,
        publicationKind: evidencePublications.publicationKind,
        provenance: evidencePublications.provenance,
        manifestHash: evidencePublications.manifestHash,
        schemaVersion: evidencePublications.schemaVersion,
        consentVersion: evidencePublications.consentVersion,
        state: evidencePublications.state,
        supersedesPublicationId: evidencePublications.supersedesPublicationId,
        testedAt: evidencePublications.testedAt,
        publishedAt: evidencePublications.publishedAt,
        withdrawnAt: evidencePublications.withdrawnAt,
        withdrawalReason: evidencePublications.withdrawalReason,
        createdAt: evidencePublications.createdAt,
      }).from(evidencePublications)
        .leftJoin(users, eq(evidencePublications.authorId, users.id))
        .where(whereClause)
        .orderBy(desc(evidencePublications.id))
        .limit(input.pageSize).offset(offset);
      const [{ total }] = await db.select({ total: sql<number>`COUNT(*)` })
        .from(evidencePublications).where(whereClause);
      return { items, total: Number(total), page: input.page, pageSize: input.pageSize };
    }),

  evidencePublicationDetail: adminQuery
    .input(z.object({ publicationId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [row] = await db.select({
        id: evidencePublications.id,
        authorId: evidencePublications.authorId,
        authorUsername: users.username,
        benchmarkId: evidencePublications.benchmarkId,
        externalReportId: evidencePublications.externalReportId,
        listingId: evidencePublications.listingId,
        listingWorkflowVersionId: evidencePublications.listingWorkflowVersionId,
        publicationKind: evidencePublications.publicationKind,
        provenance: evidencePublications.provenance,
        publicManifest: evidencePublications.publicManifest,
        manifestHash: evidencePublications.manifestHash,
        schemaVersion: evidencePublications.schemaVersion,
        consentVersion: evidencePublications.consentVersion,
        state: evidencePublications.state,
        supersedesPublicationId: evidencePublications.supersedesPublicationId,
        testedAt: evidencePublications.testedAt,
        publishedAt: evidencePublications.publishedAt,
        withdrawnAt: evidencePublications.withdrawnAt,
        withdrawalReason: evidencePublications.withdrawalReason,
        createdAt: evidencePublications.createdAt,
      }).from(evidencePublications)
        .leftJoin(users, eq(evidencePublications.authorId, users.id))
        .where(eq(evidencePublications.id, input.publicationId))
        .limit(1);
      if (!row) throw new Error("Publication not found");

      const { publicManifest, ...publication } = row;
      // The manifest is the public disclosure document, so reading it is not a
      // private-content read. A row that no longer parses is a server-side
      // fault to name, not bytes to hand over as if they were valid.
      let manifest: unknown = null;
      let manifestError: string | null = null;
      try {
        const parsed = PublicEvidenceManifestSchema.safeParse(JSON.parse(String(publicManifest)));
        if (parsed.success) manifest = parsed.data;
        else manifestError = `stored manifest no longer satisfies the public schema (${parsed.error.issues.length} issue(s))`;
      } catch (err) {
        manifestError = `stored manifest is not valid JSON: ${(err as Error).message}`;
      }
      return { publication, manifest, manifestError };
    }),

  // ─── Spend (spec §6.1/§9) ─────────────────────────────────────────
  // Money discipline, restated because this is the screen most likely to be
  // misread: `estimated_cost_usd IS NULL` means "not priceable", NOT zero, and
  // `cost_completeness = 'unknown'` is a fact about our knowledge. So every
  // figure below is produced by `costDisclosure()` — the same function the
  // user-facing screens use — which turns a partially-priced set into a FLOOR
  // plus an unpriced count instead of "$0.00".

  spendSummary: adminQuery
    .input(z.object({
      page: z.number().min(1).default(1),
      pageSize: z.number().min(1).max(50).default(20),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      const offset = (input.page - 1) * input.pageSize;

      // Per-benchmark: the real helper, once per benchmark on this page. The
      // page bounds the number of computations; it never caps the ledger, and
      // `total` below is the whole population.
      const benchmarkRows = await db.select({
        benchmarkId: benchmarks.id,
        ownerId: benchmarks.ownerId,
        ownerUsername: users.username,
        state: benchmarks.state,
        executionMode: benchmarks.executionMode,
        listingId: benchmarks.listingId,
        spendApprovalId: benchmarks.spendApprovalId,
        purpose: spendApprovals.purpose,
        createdAt: benchmarks.createdAt,
      }).from(benchmarks)
        .leftJoin(users, eq(benchmarks.ownerId, users.id))
        .leftJoin(spendApprovals, eq(benchmarks.spendApprovalId, spendApprovals.id))
        .orderBy(desc(benchmarks.id))
        .limit(input.pageSize).offset(offset);

      const perBenchmark = [];
      for (const b of benchmarkRows) {
        const totals = await benchmarkLedgerTotals(b.benchmarkId);
        perBenchmark.push({ ...b, totals, cost: costDisclosure(totals) });
      }

      // Per-account and per-purpose: one grouped query each, reduced through the
      // SAME `costDisclosure()`. `CostDisclosureInput` exists precisely so a
      // grouped query can produce the same sentence as the per-benchmark totals
      // instead of a second, subtly different aggregation.
      const aggregates = {
        totalCalls: sql<number>`COUNT(*)`,
        pricedOperations: sql<number>`COUNT(${callAttempts.estimatedCostUsd})`,
        uncertainCalls: sql<number>`COALESCE(SUM(CASE WHEN ${callAttempts.outcome} = 'uncertain' THEN 1 ELSE 0 END), 0)`,
        knownCost: sql<string>`COALESCE(SUM(${callAttempts.estimatedCostUsd}), 0)`,
        nonComplete: sql<number>`COALESCE(SUM(CASE WHEN ${callAttempts.costCompleteness} <> 'complete' THEN 1 ELSE 0 END), 0)`,
        bases: sql<string | null>`GROUP_CONCAT(DISTINCT ${callAttempts.costBasis})`,
      };
      type LedgerAggregateRow = {
        totalCalls: number; pricedOperations: number; uncertainCalls: number;
        knownCost: string; nonComplete: number; bases: string | null;
      };
      const disclose = (r: LedgerAggregateRow): CostDisclosureInput => {
        const totalCalls = Number(r.totalCalls);
        return {
          totalCalls,
          uncertainCalls: Number(r.uncertainCalls),
          pricedOperations: Number(r.pricedOperations),
          knownCostUsd: Number(r.knownCost).toFixed(8),
          // The same three-way rule `benchmarkLedgerTotals()` applies row by row.
          costCompleteness: totalCalls === 0 ? "unknown" : Number(r.nonComplete) > 0 ? "partial" : "complete",
          pricingBases: (r.bases ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        };
      };
      const nullPayer = sql<number | null>`NULL`;
      const nullPurpose = sql<string | null>`NULL`;
      const withDisclosure = (r: LedgerAggregateRow & { payerId: number | null; purpose: string | null }) => {
        const totals = disclose(r);
        return { payerId: r.payerId, purpose: r.purpose, ...totals, cost: costDisclosure(totals) };
      };

      const [payerRows, purposeRows, unattachedRows] = await Promise.all([
        db.select({ payerId: callAttempts.payerId, purpose: nullPurpose, ...aggregates })
          .from(callAttempts).groupBy(callAttempts.payerId).orderBy(desc(sql<number>`COUNT(*)`)).limit(100),
        db.select({ payerId: nullPayer, purpose: callAttempts.purpose, ...aggregates })
          .from(callAttempts).groupBy(callAttempts.purpose).orderBy(desc(sql<number>`COUNT(*)`)).limit(100),
        // Ledger rows attached to no benchmark: one bucket, so they cannot be
        // folded silently into some benchmark's floor.
        db.select({ payerId: nullPayer, purpose: nullPurpose, ...aggregates })
          .from(callAttempts).where(isNull(callAttempts.benchmarkId)),
      ]);

      const byPayerRaw = payerRows.map(withDisclosure);
      const byPurpose = purposeRows.map(withDisclosure);
      const unattached = unattachedRows
        .map((r) => withDisclosure({ ...r, payerId: null, purpose: null }))
        .filter((r) => r.totalCalls > 0);

      const payerIds = byPayerRaw.map((r) => r.payerId).filter((id): id is number => typeof id === "number");
      const payerNames = payerIds.length
        ? await db.select({ id: users.id, username: users.username, name: users.name }).from(users).where(inArray(users.id, payerIds))
        : [];
      const nameById = new Map(payerNames.map((u) => [u.id, u]));
      const byPayer = byPayerRaw.map((r) => ({
        ...r,
        username: typeof r.payerId === "number" ? nameById.get(r.payerId)?.username ?? null : null,
        displayName: typeof r.payerId === "number" ? nameById.get(r.payerId)?.name ?? null : null,
      }));

      const [{ benchmarkTotal }] = await db.select({ benchmarkTotal: sql<number>`COUNT(*)` }).from(benchmarks);

      return {
        benchmarks: perBenchmark,
        byPayer,
        byPurpose,
        unattached,
        total: Number(benchmarkTotal),
        page: input.page,
        pageSize: input.pageSize,
      };
    }),

  listSpendApprovals: adminQuery
    .input(z.object({
      page: z.number().min(1).default(1),
      pageSize: z.number().min(1).max(100).default(20),
      status: z.enum(["active", "consumed", "expired", "revoked"]).optional(),
      payerId: z.number().int().positive().optional(),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      const offset = (input.page - 1) * input.pageSize;
      const conditions = [];
      if (input.status) conditions.push(eq(spendApprovals.status, input.status));
      if (input.payerId) conditions.push(eq(spendApprovals.payerId, input.payerId));
      const whereClause = conditions.length ? and(...conditions) : undefined;

      const items = await db.select({
        id: spendApprovals.id,
        actorId: spendApprovals.actorId,
        payerId: spendApprovals.payerId,
        purpose: spendApprovals.purpose,
        planHash: spendApprovals.planHash,
        bindings: spendApprovals.bindings,
        limits: spendApprovals.limits,
        spendCeilingUsd: spendApprovals.spendCeilingUsd,
        status: spendApprovals.status,
        policyVersion: spendApprovals.policyVersion,
        approvedAt: spendApprovals.approvedAt,
        expiresAt: spendApprovals.expiresAt,
        revokedAt: spendApprovals.revokedAt,
      }).from(spendApprovals)
        .where(whereClause)
        .orderBy(desc(spendApprovals.id))
        .limit(input.pageSize).offset(offset);

      // Actor and payer are both users, and "how many benchmarks ran under this
      // frozen plan" is a second grouped read. Both are resolved by explicit
      // queries instead of correlated subqueries so the numbers cannot be
      // mis-scoped by a name that resolves in the wrong query level.
      const approvalIds = items.map((i) => i.id);
      const userIds = [...new Set(items.flatMap((i) => [i.actorId, i.payerId]))];
      const [usage, people] = await Promise.all([
        approvalIds.length
          ? db.select({ approvalId: benchmarks.spendApprovalId, used: sql<number>`COUNT(*)` })
              .from(benchmarks).where(inArray(benchmarks.spendApprovalId, approvalIds))
              .groupBy(benchmarks.spendApprovalId)
          : Promise.resolve([]),
        userIds.length
          ? db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds))
          : Promise.resolve([]),
      ]);
      const usedById = new Map(usage.filter((u) => u.approvalId !== null).map((u) => [u.approvalId as number, Number(u.used)]));
      const byId = new Map(people.map((p) => [p.id, p.username]));

      const [{ total }] = await db.select({ total: sql<number>`COUNT(*)` })
        .from(spendApprovals).where(whereClause);
      return {
        items: items.map((i) => ({
          ...i,
          actorUsername: byId.get(i.actorId) ?? null,
          payerUsername: byId.get(i.payerId) ?? null,
          benchmarkCount: usedById.get(i.id) ?? 0,
        })),
        total: Number(total), page: input.page, pageSize: input.pageSize,
      };
    }),

  /**
   * Price the ledger rows that were never priced. A row gets one rate lookup at
   * insert, and a provider list that was briefly unreachable made that lookup
   * return nothing — so the row has sat at UNKNOWN ever since while the tokens
   * it needs to be priced are stored right beside it. This is the only path that
   * revisits one, which makes the payer-facing floor the honest highest-known
   * figure rather than an artefact of an old timeout.
   */
  repriceUnpricedOperations: adminQuery.mutation(async ({ ctx }) => {
    const result = await repriceUnpricedOperations();
    logger.info("Admin: re-priced unpriced ledger operations", {
      adminUserId: ctx.user.id, priced: result.priced, addedUsd: result.addedUsd,
    });
    await logAdminAction({
      adminUserId: ctx.user.id, action: "call_attempt.reprice_unpriced",
      targetType: "ledger",
      detail: { ...result },
      ip: ctx.remoteIp,
    });
    return result;
  }),
});
