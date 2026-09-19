import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { projects, teamMembers, teamProjects } from "@db/schema";
import { eq, and, inArray } from "drizzle-orm";
import * as giteeService from "../services/giteeService";
import { TRPCError } from "@trpc/server";
import { isFeatureEnabled } from "../plugins/featureFlags";
import { logger } from "../lib/logger";

// Helper: check if user can access a project (owner or team member)
async function canAccessProject(userId: number, projectId: number): Promise<boolean> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return false;
  if (project.userId === userId) return true;

  const memberships = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId));
  const teamIds = memberships.map((m) => m.teamId);
  if (teamIds.length === 0) return false;

  const shared = await db
    .select()
    .from(teamProjects)
    .where(and(eq(teamProjects.projectId, projectId), inArray(teamProjects.teamId, teamIds)))
    .limit(1);
  return shared.length > 0;
}

export const giteeRouter = createRouter({
  validateToken: authedQuery
    .input(z.object({ token: z.string() }))
    .mutation(async ({ input, ctx }) => {
      if (!(await isFeatureEnabled("gitee_sync", ctx.user.id))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Gitee sync is not enabled" });
      }
      return giteeService.validateToken(input.token);
    }),

  listRepos: authedQuery
    .input(z.object({ token: z.string() }))
    .query(async ({ input, ctx }) => {
      if (!(await isFeatureEnabled("gitee_sync", ctx.user.id))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Gitee sync is not enabled" });
      }
      return giteeService.listRepos(input.token);
    }),

  syncProject: authedQuery
    .input(z.object({ projectId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      if (!(await isFeatureEnabled("gitee_sync", ctx.user.id))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Gitee sync is not enabled" });
      }
      const [project] = await getDb()
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));

      if (!project?.giteeOwner || !project?.giteeRepo) {
        throw new Error("Project not connected to Gitee");
      }

      // TODO: Implement two-way sync
      await getDb()
        .update(projects)
        .set({ lastSyncedAt: new Date() })
        .where(eq(projects.id, input.projectId));

      return { success: true, lastSyncedAt: new Date() };
    }),

  getFile: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        path: z.string(),
        ref: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      if (!(await isFeatureEnabled("gitee_sync", ctx.user.id))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Gitee sync is not enabled" });
      }
      const hasAccess = await canAccessProject(ctx.user.id, input.projectId);
      if (!hasAccess) throw new Error("Project not found");

      const [project] = await getDb()
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);

      if (!project?.giteeOwner || !project?.giteeRepo) {
        throw new Error("Project not connected to Gitee");
      }

      // TODO: Get Gitee token from user settings
      throw new Error("Gitee token not configured");
    }),

  getFileTree: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        path: z.string().default(""),
        token: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      if (!(await isFeatureEnabled("gitee_sync", ctx.user.id))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Gitee sync is not enabled" });
      }
      const hasAccess = await canAccessProject(ctx.user.id, input.projectId);
      if (!hasAccess) throw new Error("Project not found");

      const [project] = await getDb()
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);

      if (!project?.giteeOwner || !project?.giteeRepo) {
        throw new Error("Project not connected to Gitee");
      }

      return giteeService.getFileTree(
        input.token,
        project.giteeOwner,
        project.giteeRepo,
        input.path,
        project.giteeBranch ?? "master"
      );
    }),

  createOrUpdateFile: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        path: z.string(),
        content: z.string(),
        message: z.string(),
        token: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!(await isFeatureEnabled("gitee_sync", ctx.user.id))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Gitee sync is not enabled" });
      }
      const [project] = await getDb()
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));

      if (!project?.giteeOwner || !project?.giteeRepo) {
        throw new Error("Project not connected to Gitee");
      }

      return giteeService.createOrUpdateFile(
        input.token,
        project.giteeOwner,
        project.giteeRepo,
        input.path,
        input.content,
        input.message,
        project.giteeBranch ?? "master"
      );
    }),

  // ── My Data: List user's swarm-studio repo folders ─────────────
  getMyDataTree: authedQuery
    .input(z.object({ token: z.string(), path: z.string().default("") }))
    .query(async ({ input, ctx }) => {
      if (!(await isFeatureEnabled("gitee_sync", ctx.user.id))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Gitee sync is not enabled" });
      }
      // Find the swarm-studio repo
      const repos = await giteeService.listRepos(input.token, 1, 20);
      const repo = repos.find((r: Record<string, unknown>) => r.name === "swarm-studio" || (r.path && r.path === "swarm-studio"));
      if (!repo) return { owner: null, repo: null, tree: [] };

      const owner = (repo.owner as { login: string }).login;
      const repoName = repo.name as string;

      // Try master branch first, then main
      for (const branch of ["master", "main"]) {
        try {
          const tree = await giteeService.getFileTree(input.token, owner, repoName, input.path, branch);
          return { owner, repo: repoName, tree };
        } catch {
          // Try next branch
        }
      }
      return { owner, repo: repoName, tree: [] };
    }),

  // ── My Data: Get file content ──────────────────────────────────
  getMyDataFile: authedQuery
    .input(z.object({ token: z.string(), path: z.string() }))
    .query(async ({ input, ctx }) => {
      if (!(await isFeatureEnabled("gitee_sync", ctx.user.id))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Gitee sync is not enabled" });
      }
      const repos = await giteeService.listRepos(input.token, 1, 20);
      const repo = repos.find((r: Record<string, unknown>) => r.name === "swarm-studio" || (r.path && r.path === "swarm-studio"));
      if (!repo) return { content: null, error: "No swarm-studio repo found" };

      const owner = (repo.owner as { login: string }).login;
      const repoName = repo.name as string;

      // Try master branch first, then main (Gitee default changed over time)
      for (const branch of ["master", "main"]) {
        try {
          const result = await giteeService.getFileContent(input.token, owner, repoName, input.path, branch);
          return { content: result.content, error: null };
        } catch (err) {
          logger.info("MyData failed to load file on branch", { path: input.path, branch, error: (err as Error).message });
          // Try next branch
        }
      }
      return { content: null, error: `Failed to load ${input.path} on master or main` };
    }),

  // ── My Data: Load folder contents (mutation for on-demand loading) ─
  loadFolder: authedQuery
    .input(z.object({ token: z.string(), path: z.string() }))
    .mutation(async ({ input, ctx }) => {
      if (!(await isFeatureEnabled("gitee_sync", ctx.user.id))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Gitee sync is not enabled" });
      }
      logger.info("loadFolder loading path", { path: input.path });
      const repos = await giteeService.listRepos(input.token, 1, 20);
      const repo = repos.find((r: Record<string, unknown>) => r.name === "swarm-studio" || (r.path && r.path === "swarm-studio"));
      if (!repo) {
        logger.info("loadFolder no swarm-studio repo found");
        return { items: [] };
      }

      const owner = (repo.owner as { login: string }).login;
      const repoName = repo.name as string;
      logger.info("loadFolder repo", { owner, repo: repoName, path: input.path });

      for (const branch of ["master", "main"]) {
        try {
          const tree = await giteeService.getFileTree(input.token, owner, repoName, input.path, branch);
          const items = tree as Array<{ path: string; type: string; name?: string }>;
          logger.info("loadFolder branch returned items", { branch, count: items.length, items: items.map((i) => `${i.name ?? i.path}(${i.type})`).join(", ") });
          return { items };
        } catch (err) {
          logger.info("loadFolder branch failed", { branch, error: (err as Error).message });
          // Try next branch
        }
      }
      logger.info("loadFolder all branches failed, returning empty");
      return { items: [] };
    }),

  // ── Debug: Raw Gitee API call ────────────────────────────────────
  debugGitee: authedQuery
    .input(z.object({ token: z.string(), path: z.string().default("") }))
    .query(async ({ input, ctx }) => {
      if (!(await isFeatureEnabled("gitee_sync", ctx.user.id))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Gitee sync is not enabled" });
      }
      const repos = await giteeService.listRepos(input.token, 1, 20);
      const repo = repos.find((r: Record<string, unknown>) => r.name === "swarm-studio" || (r.path && r.path === "swarm-studio"));
      if (!repo) return { error: "No swarm-studio repo found", raw: null };

      const owner = (repo.owner as { login: string }).login;
      const repoName = repo.name as string;

      const results: Record<string, unknown> = { owner, repo: repoName };

      for (const branch of ["master", "main"]) {
        try {
          const tree = await giteeService.getFileTree(input.token, owner, repoName, input.path, branch);
          results[branch] = tree;
        } catch (err) {
          results[branch + "_error"] = (err as Error).message;
        }
      }

      return { error: null, raw: results };
    }),
});
