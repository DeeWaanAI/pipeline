import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { projects } from "@db/schema";
import { eq, and } from "drizzle-orm";
import * as githubService from "../services/githubService";

export const githubRouter = createRouter({
  validateToken: authedQuery
    .input(z.object({ token: z.string() }))
    .mutation(async ({ input }) => {
      return githubService.validateToken(input.token);
    }),

  listRepos: authedQuery
    .input(z.object({ token: z.string() }))
    .query(async ({ input }) => {
      return githubService.listRepos(input.token);
    }),

  connectProject: authedQuery
    .input(z.object({
      projectId: z.number(),
      token: z.string(),
      owner: z.string(),
      repo: z.string(),
      branch: z.string().default("main"),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [project] = await db.select().from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));

      if (!project) throw new Error("Project not found");

      // Verify the repo exists and user has access
      await githubService.getRepo(input.token, input.owner, input.repo);

      await db.update(projects).set({
        githubOwner: input.owner,
        githubRepo: input.repo,
        githubBranch: input.branch,
      }).where(eq(projects.id, input.projectId));

      return { success: true };
    }),

  disconnectProject: authedQuery
    .input(z.object({ projectId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [project] = await db.select().from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));

      if (!project) throw new Error("Project not found");

      await db.update(projects).set({
        githubOwner: null,
        githubRepo: null,
        githubBranch: null,
      }).where(eq(projects.id, input.projectId));

      return { success: true };
    }),

  syncProject: authedQuery
    .input(z.object({ projectId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [project] = await db.select().from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));

      if (!project?.githubOwner || !project?.githubRepo) {
        throw new Error("Project not connected to GitHub");
      }

      await db.update(projects)
        .set({ lastSyncedAt: new Date() })
        .where(eq(projects.id, input.projectId));

      return { success: true, lastSyncedAt: new Date() };
    }),

  getFileTree: authedQuery
    .input(z.object({
      projectId: z.number(),
      path: z.string().default(""),
      token: z.string(),
    }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const [project] = await db.select().from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));

      if (!project?.githubOwner || !project?.githubRepo) {
        throw new Error("Project not connected to GitHub");
      }

      return githubService.getFileTree(
        input.token,
        project.githubOwner,
        project.githubRepo,
        input.path,
        project.githubBranch ?? "main"
      );
    }),

  createOrUpdateFile: authedQuery
    .input(z.object({
      projectId: z.number(),
      path: z.string(),
      content: z.string(),
      message: z.string(),
      token: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [project] = await db.select().from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));

      if (!project?.githubOwner || !project?.githubRepo) {
        throw new Error("Project not connected to GitHub");
      }

      return githubService.createOrUpdateFile(
        input.token,
        project.githubOwner,
        project.githubRepo,
        input.path,
        input.content,
        input.message,
        project.githubBranch ?? "main"
      );
    }),
});
