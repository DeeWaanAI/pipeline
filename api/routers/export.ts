import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery, adminQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  customAgents, pipelineSteps, pipelineTemplates, swarmRuns,
  agentRuns, agentResponses, projects, testFixtures, users
} from "@db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { checkRateLimitAsync } from "../lib/rateLimiter";
import {
  AUDIT_EXPORT_RATE_LIMIT,
  buildAuditLedger,
  ledgerToCsvFiles,
  signLedger,
} from "../services/auditExport";
import {
  isProtectedRun, projectRunDetail, redactProtectedAgentRun,
} from "../services/runAccess";
import { exportBenchmarkArchive } from "../services/benchmark/benchmarkExport";

export const PROTECTED_EXPORT_NOTE =
  "Protected marketplace run: the workflow definition belongs to the seller, so step prompts are stored as lengths only and intermediate step outputs are not part of the buyer's export.";

export const exportRouter = createRouter({
  // Export all custom agents for the current user
  exportAgents: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const agents = await db.select().from(customAgents)
      .where(eq(customAgents.userId, ctx.user.id));
    
    logger.info("Agents exported", { userId: ctx.user.id, count: agents.length });
    return { version: 1, exportedAt: new Date().toISOString(), agents };
  }),

  // Export a specific pipeline (steps + agent configs)
  exportPipeline: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();

      // Ownership check — steps embed agent system prompts, so exporting
      // someone else's project must be impossible (also reachable via MCP).
      const [project] = await db.select({ id: projects.id, name: projects.name, description: projects.description })
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)))
        .limit(1);
      if (!project) throw new Error("Project not found");

      const steps = await db.select().from(pipelineSteps)
        .where(eq(pipelineSteps.projectId, input.projectId))
        .orderBy(pipelineSteps.stepOrder);
      
      // Resolve agent details for each step
      const agentIds = steps.map(s => s.agentId).filter(Boolean) as number[];
      const agents = agentIds.length > 0
        ? await db.select().from(customAgents).where(inArray(customAgents.id, agentIds))
        : [];
      
      const agentMap = new Map(agents.map(a => [a.id, a]));
      // A portable artifact carries the WORK, not the wiring. Row ids
      // (`id`, `projectId`, `userId`, `agentId`, `providerId`) mean nothing
      // outside this account, and putting them in a file people share is worse
      // than pointless: a reader would reasonably think `providerId` travels
      // with the pipeline, when execution resolves the credential from the
      // RUNNER's own account every time (api/services/swarmService.ts:479-480)
      // and a foreign id can never be honoured. `format: 2` replaces the old
      // `version: 1`, which read like a workflow version and was a format tag.
      const enrichedSteps = steps.map(step => {
        const agent = step.agentId ? agentMap.get(step.agentId) ?? null : null;
        return {
          stepOrder: step.stepOrder,
          name: step.name,
          role: step.role,
          systemPrompt: step.systemPrompt,
          stepType: step.stepType,
          model: step.model ?? null,
          temperature: step.temperature ?? null,
          maxTokens: step.maxTokens ?? null,
          ifConfig: step.ifConfig ?? null,
          whileConfig: step.whileConfig ?? null,
          isEnabled: step.isEnabled,
          agent: agent
            ? {
                name: agent.name,
                slug: agent.slug,
                role: agent.role,
                description: agent.description ?? null,
                systemPrompt: agent.systemPrompt,
                defaultModel: agent.defaultModel ?? null,
                temperature: agent.temperature ?? null,
                maxTokens: agent.maxTokens ?? null,
              }
            : null,
        };
      });

      logger.info("Pipeline exported", { userId: ctx.user.id, projectId: input.projectId });
      return {
        format: 2,
        exportedAt: new Date().toISOString(),
        pipeline: { name: project.name, description: project.description ?? null },
        note: "A live snapshot of this pipeline as it stands now — not a certified workflow version. A marketplace listing's evidence describes an immutable version and its definition hash; this file describes neither.",
        steps: enrichedSteps,
      };
    }),

  // Export full execution history for a swarm run
  exportRun: authedQuery
    .input(z.object({ runId: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      
      const [run] = await db.select().from(swarmRuns)
        .where(eq(swarmRuns.id, input.runId)).limit(1);
      if (!run || run.userId !== ctx.user.id) throw new Error("Run not found");
      logger.info("Run exported", { userId: ctx.user.id, runId: input.runId });

      // §8.1: a marketplace run's buyer owns the ANSWER, not the workflow's
      // intermediate products — an echo of the seller's instructions can ride
      // along in any of them. The prompt columns are already redacted at the
      // write; dropping them here as well keeps two independent bars. The
      // projection itself lives in `api/services/runAccess.ts` because the
      // consented feedback attachment (D11) reads run detail too, and a second
      // reader must not get to invent its own idea of what "redacted" means.
      const detail = await projectRunDetail(run);
      if (detail.redacted) {
        return {
          version: 1,
          exportedAt: new Date().toISOString(),
          run,
          agentRuns: detail.steps,
          agentResponses: detail.responses,
          protection: PROTECTED_EXPORT_NOTE,
        };
      }
      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        run,
        agentRuns: detail.steps,
        agentResponses: detail.responses,
      };
    }),

  // Export one private evaluation as an exact local archive: the frozen plan, the
  // judging prompts in full, every case input and candidate output, every
  // judgment, and the cost ledger rows. `exportRun` covers a run; a benchmark is
  // where a research program's real work lives, and it had no way out.
  exportBenchmark: authedQuery
    .input(z.object({ benchmarkId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => exportBenchmarkArchive({ userId: ctx.user.id, benchmarkId: input.benchmarkId })),

  // Export all pipeline templates for the current user
  exportTemplates: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const templates = await db.select().from(pipelineTemplates)
      .where(eq(pipelineTemplates.userId, ctx.user.id));
    
    return { version: 1, exportedAt: new Date().toISOString(), templates };
  }),

  // Import agents from JSON export
  importAgents: authedQuery
    .input(z.object({
      agents: z.array(z.object({
        name: z.string(),
        slug: z.string(),
        role: z.string(),
        systemPrompt: z.string(),
        defaultModel: z.string().nullable().optional(),
        temperature: z.string().optional(),
        maxTokens: z.number().optional(),
        description: z.string().nullable().optional(),
      })),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      let imported = 0;
      for (const agent of input.agents) {
        // Skip if slug already exists for this user
        const [existing] = await db.select().from(customAgents)
          .where(and(
            eq(customAgents.userId, ctx.user.id),
            eq(customAgents.slug, agent.slug)
          )).limit(1);
        if (existing) continue;

        await db.insert(customAgents).values({
          userId: ctx.user.id,
          name: agent.name,
          slug: agent.slug,
          role: agent.role,
          systemPrompt: agent.systemPrompt,
          defaultModel: agent.defaultModel ?? null,
          temperature: agent.temperature ?? "0.7",
          maxTokens: agent.maxTokens ?? 4096,
          description: agent.description ?? null,
        });
        imported++;
      }

      logger.info("Agents imported", { userId: ctx.user.id, imported });
      return { imported, skipped: input.agents.length - imported };
    }),

  // Full project backup
  exportProjectBackup: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      
      const [project] = await db.select().from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)))
        .limit(1);
      if (!project) throw new Error("Project not found");

      const steps = await db.select().from(pipelineSteps)
        .where(eq(pipelineSteps.projectId, input.projectId))
        .orderBy(pipelineSteps.stepOrder);

      const runs = await db.select().from(swarmRuns)
        .where(eq(swarmRuns.projectId, input.projectId));
      
      const runIds = runs.map(r => r.id);
      const allAgentRuns = runIds.length > 0
        ? await db.select().from(agentRuns).where(inArray(agentRuns.swarmRunId, runIds))
        : [];
      const allResponses = runIds.length > 0
        ? await db.select().from(agentResponses).where(inArray(agentResponses.swarmRunId, runIds))
        : [];

      logger.info("Project backup exported", { userId: ctx.user.id, projectId: input.projectId });
      // The buyer's marketplace container is project-exportable like any other
      // project, so the same protected-run projection applies here (§8.1).
      const protectedFinals = new Map(runs.filter(isProtectedRun).map((r) => [r.id, r.finalResponseId]));
      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        project,
        pipelineSteps: steps,
        swarmRuns: runs,
        agentRuns: allAgentRuns.map((r) => (protectedFinals.has(r.swarmRunId ?? -1)
          ? redactProtectedAgentRun(r) : r)),
        agentResponses: allResponses.filter((r) =>
          !protectedFinals.has(r.swarmRunId ?? -1) || r.id === protectedFinals.get(r.swarmRunId ?? -1)),
      };
    }),

  // Export ALL user data as a single JSON backup
  exportAllUserData: authedQuery.query(async ({ ctx }) => {
    const db = getDb();

    // All projects for this user
    const userProjects = await db.select().from(projects)
      .where(eq(projects.userId, ctx.user.id));

    // All pipeline steps for those projects
    const projectIds = userProjects.map(p => p.id);
    const allSteps = projectIds.length > 0
      ? await db.select().from(pipelineSteps)
          .where(inArray(pipelineSteps.projectId, projectIds))
          .orderBy(pipelineSteps.projectId, pipelineSteps.stepOrder)
      : [];

    // All custom agents
    const userAgents = await db.select().from(customAgents)
      .where(eq(customAgents.userId, ctx.user.id));

    // All pipeline templates
    const userTemplates = await db.select().from(pipelineTemplates)
      .where(eq(pipelineTemplates.userId, ctx.user.id));

    // User preferences from users table
    const [userRow] = await db.select({ preferences: users.preferences })
      .from(users).where(eq(users.id, ctx.user.id)).limit(1);
    const preferences = userRow?.preferences ?? null;

    // Test fixture metadata only (no ZIP file contents)
    const userFixtures = await db.select({
      id: testFixtures.id,
      name: testFixtures.name,
      description: testFixtures.description,
      complexity: testFixtures.complexity,
      sizeBytes: testFixtures.sizeBytes,
      fileCount: testFixtures.fileCount,
      isPublic: testFixtures.isPublic,
      createdAt: testFixtures.createdAt,
    }).from(testFixtures).where(eq(testFixtures.userId, ctx.user.id));

    logger.info("Full user data exported", {
      userId: ctx.user.id,
      projects: userProjects.length,
      steps: allSteps.length,
      agents: userAgents.length,
      templates: userTemplates.length,
      fixtures: userFixtures.length,
    });

    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      type: "full_backup" as const,
      projects: userProjects,
      pipelineSteps: allSteps,
      customAgents: userAgents,
      pipelineTemplates: userTemplates,
      preferences,
      testFixtures: userFixtures,
    };
  }),

  // Import all user data from a full backup JSON
  importAllUserData: authedQuery
    .input(z.object({
      version: z.number(),
      type: z.string(),
      preferences: z.any().nullable().optional(),
      customAgents: z.array(z.object({
        name: z.string(),
        slug: z.string(),
        role: z.string(),
        systemPrompt: z.string(),
        defaultModel: z.string().nullable().optional(),
        temperature: z.string().optional(),
        maxTokens: z.number().optional(),
        description: z.string().nullable().optional(),
      })).optional(),
      pipelineTemplates: z.array(z.object({
        name: z.string(),
        description: z.string().nullable().optional(),
        steps: z.array(z.object({
          name: z.string(),
          role: z.string(),
          systemPrompt: z.string(),
          stepType: z.string().optional(),
          ifConfig: z.any().optional(),
          whileConfig: z.any().optional(),
          providerId: z.number().nullable().optional(),
          model: z.string().nullable().optional(),
          temperature: z.string().optional(),
          maxTokens: z.number().optional(),
        })),
        isAuto: z.boolean().optional(),
      })).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      let agentsImported = 0;
      let templatesImported = 0;
      let preferencesRestored = false;

      // 1. Restore preferences (merge into existing preferences)
      if (input.preferences != null) {
        const [currentUser] = await db.select({ preferences: users.preferences })
          .from(users).where(eq(users.id, ctx.user.id)).limit(1);

        const existingPrefs = (currentUser?.preferences as Record<string, unknown>) ?? {};
        const incomingPrefs = input.preferences as Record<string, unknown>;
        const mergedPrefs = { ...existingPrefs, ...incomingPrefs };

        await db.update(users)
          .set({ preferences: mergedPrefs })
          .where(eq(users.id, ctx.user.id));
        preferencesRestored = true;
      }

      // 2. Restore custom agents (skip duplicates by slug)
      const agentsToImport = input.customAgents ?? [];
      for (const agent of agentsToImport) {
        const [existing] = await db.select().from(customAgents)
          .where(and(
            eq(customAgents.userId, ctx.user.id),
            eq(customAgents.slug, agent.slug)
          )).limit(1);
        if (existing) continue;

        await db.insert(customAgents).values({
          userId: ctx.user.id,
          name: agent.name,
          slug: agent.slug,
          role: agent.role,
          systemPrompt: agent.systemPrompt,
          defaultModel: agent.defaultModel ?? null,
          temperature: agent.temperature ?? "0.7",
          maxTokens: agent.maxTokens ?? 4096,
          description: agent.description ?? null,
        });
        agentsImported++;
      }

      // 3. Restore pipeline templates (skip duplicates by name + userId)
      const templatesToImport = input.pipelineTemplates ?? [];
      for (const template of templatesToImport) {
        const [existing] = await db.select().from(pipelineTemplates)
          .where(and(
            eq(pipelineTemplates.userId, ctx.user.id),
            eq(pipelineTemplates.name, template.name)
          )).limit(1);
        if (existing) continue;

        await db.insert(pipelineTemplates).values({
          userId: ctx.user.id,
          name: template.name,
          description: template.description ?? null,
          steps: template.steps,
          isAuto: template.isAuto ?? false,
        });
        templatesImported++;
      }

      logger.info("Full user data imported", {
        userId: ctx.user.id,
        agents: agentsImported,
        templates: templatesImported,
        preferences: preferencesRestored,
      });

      return {
        restored: {
          agents: agentsImported,
          templates: templatesImported,
          preferences: preferencesRestored,
        },
      };
    }),

  // ─── Enterprise compliance exports (Phase 3) — signed audit ledger ───

  // Full audit ledger as a signed JSON envelope (HMAC-SHA256 over canonical JSON)
  auditLedgerJson: adminQuery
    .input(z.object({ from: z.date().optional(), to: z.date().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const rl = await checkRateLimitAsync(`audit-export:${ctx.user.id}`, AUDIT_EXPORT_RATE_LIMIT);
      if (!rl.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `Rate limit exceeded. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
        });
      }
      const ledger = await buildAuditLedger({ from: input?.from, to: input?.to });
      const signed = signLedger(ledger);
      logger.info("Audit ledger exported (JSON)", { userId: ctx.user.id, counts: ledger.counts });
      return { ...signed, counts: ledger.counts };
    }),

  // Same ledger rendered as one CSV per section; signature covers the ledger JSON
  auditLedgerCsv: adminQuery
    .input(z.object({ from: z.date().optional(), to: z.date().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const rl = await checkRateLimitAsync(`audit-export:${ctx.user.id}`, AUDIT_EXPORT_RATE_LIMIT);
      if (!rl.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `Rate limit exceeded. Try again in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
        });
      }
      const ledger = await buildAuditLedger({ from: input?.from, to: input?.to });
      const signed = signLedger(ledger);
      const files = ledgerToCsvFiles(ledger);
      logger.info("Audit ledger exported (CSV)", { userId: ctx.user.id, counts: ledger.counts });
      return {
        files,
        signature: signed.signature,
        algorithm: signed.algorithm,
        signedAt: signed.signedAt,
        keyId: signed.keyId,
        counts: ledger.counts,
      };
    }),
});
