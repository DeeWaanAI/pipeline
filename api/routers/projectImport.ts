/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROJECT IMPORT ROUTER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles importing project folders (as ZIP files), generating Intelligence
 * Cards, and syncing files to Gitee for privacy-first storage.
 */

import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { logger } from "../lib/logger";
import { projects } from "@db/schema";
import { eq } from "drizzle-orm";
/// <reference path="../../contracts/adm-zip.d.ts" />
import { generateIntelligenceCard, findRelevantFiles } from "../services/projectIntelligence";
import { syncProjectToGitee, fetchFilesFromGitee } from "../services/giteeSync";
import * as disk from "../services/projectFilesDisk";
import { getFileContent } from "../services/giteeService";

// Helper: detect language from file extension
function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript",
    py: "python", pyw: "python",
    java: "java", kt: "kotlin",
    go: "go", rs: "rust",
    rb: "ruby", php: "php",
    cs: "csharp", fs: "fsharp",
    swift: "swift", scala: "scala",
    r: "r", m: "objectivec",
    cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
    c: "c", h: "c",
    sh: "bash", bash: "bash", zsh: "bash",
    ps1: "powershell",
    sql: "sql",
    html: "html", htm: "html",
    css: "css", scss: "scss", sass: "scss", less: "less",
    xml: "xml", svg: "xml",
    yaml: "yaml", yml: "yaml",
    json: "json",
    md: "markdown", mdx: "markdown",
    dockerfile: "dockerfile",
    env: "env", gitignore: "git",
  };
  return map[ext] || "unknown";
}

// Helper: OWNER-ONLY project access (team sharing was removed with #26).
async function canAccessProject(userId: number, projectId: number): Promise<boolean> {
  const db = getDb();
  const [project] = await db
    .select({ userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return !!project && project.userId === userId;
}

export const projectImportRouter = createRouter({
  /**
   * Import a project from a ZIP file.
   * 1. Accepts base64-encoded ZIP
   * 2. Generates Intelligence Card
   * 3. Pushes files to Gitee (if token available)
   * 4. Stores card in project record
   */
  importFromZip: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        zipBase64: z.string().min(1), // Base64-encoded ZIP file
        projectName: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      // Verify project ownership
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);

      if (!project) throw new Error("Project not found");
      if (project.userId !== ctx.user.id) throw new Error("Unauthorized");

      // Decode ZIP
      const zipBuffer = Buffer.from(input.zipBase64, "base64");
      if (zipBuffer.length > 50 * 1024 * 1024) {
        throw new Error("ZIP file too large. Max: 50MB");
      }

      logger.info("Import processing ZIP", { projectId: input.projectId, sizeKB: (zipBuffer.length / 1024).toFixed(1) });

      // Generate Intelligence Card
      const card = await generateIntelligenceCard(zipBuffer);

      // Extract file contents for Gitee push
      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip(zipBuffer);
      const entries = zip.getEntries();
      const fileContents: Array<{ path: string; content: string }> = [];

      const excludedPatterns = [
        /^node_modules\//, /^\.git\//, /^dist\//, /^build\//,
        /^\.next\//, /^__pycache__\//, /\.pyc$/, /^\.DS_Store/,
        /^__MACOSX\//,
        /^\.env/, /\.lock$/, /^package-lock\.json/, /^yarn\.lock/,
        /\.min\.(js|css)$/, /\.map$/, /\.log$/,
      ];

      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const path = entry.entryName;
        if (excludedPatterns.some((p) => p.test(path))) continue;

        const data = entry.getData();
        if (!data || data.length === 0) continue;

        // Only push text files to Gitee
        const isBinary = data.includes(0) || data.length > 5 * 1024 * 1024;
        if (isBinary) continue;

        try {
          const text = data.toString("utf-8");
          if (!text.includes("\uFFFD")) {
            fileContents.push({ path, content: text });
          }
        } catch {
          // Skip files that can't be decoded as text
        }
      }

      logger.info("Import extracted text files from ZIP", { count: fileContents.length });

      // Push to Gitee if user has a token
      let giteeResult: { owner: string; repo: string; commitSha: string } | null = null;
      const giteeToken = ctx.giteeToken;

      if (giteeToken) {
        try {
          const result = await syncProjectToGitee(
            giteeToken,
            input.projectName,
            fileContents,
            `Project files for ${input.projectName}`,
          );
          giteeResult = {
            owner: result.owner,
            repo: result.repo,
            commitSha: result.commitSha,
          };
          logger.info("Import synced to Gitee", { owner: result.owner, repo: result.repo });
        } catch (err) {
          logger.error("Import Gitee sync failed", { error: (err as Error).message });
          // Continue without Gitee — card still stored locally
        }
      }

      // Store file contents on DISK for fast LLM access (Phase 2)
      await disk.deleteProjectFiles(input.projectId);
      if (fileContents.length > 0) {
        const { saved, failed } = await disk.saveProjectFiles(
          input.projectId,
          fileContents.map((f) => ({ path: f.path, content: f.content }))
        );
        logger.info("Import stored files on disk", { saved, total: fileContents.length, failed });
      }

      // Store Intelligence Card in project
      const cardData = {
        version: card.version,
        generatedAt: card.generatedAt,
        projectType: card.projectType,
        primaryLanguage: card.primaryLanguage,
        framework: card.framework,
        totalFiles: card.totalFiles,
        totalSize: card.totalSize,
        fileTree: card.fileTree.map((f) => ({
          path: f.path,
          name: f.name,
          size: f.size,
          language: f.language,
          category: f.category,
          exports: f.exports,
          description: f.description,
          isEntryPoint: f.isEntryPoint,
        })),
        entryPoints: card.entryPoints,
        architecture: card.architecture,
        entities: card.entities.map((e) => ({ name: e.name, type: e.type, context: e.context })),
        databaseTables: card.databaseTables,
        apiEndpoints: card.apiEndpoints,
        todos: card.todos,
        ...(giteeResult ? {
          giteeOwner: giteeResult.owner,
          giteeRepo: giteeResult.repo,
          giteeCommitSha: giteeResult.commitSha,
        } : {}),
      };

      await db
        .update(projects)
        .set({
          intelligenceCard: cardData,
          ...(giteeResult ? {
            giteeOwner: giteeResult.owner,
            giteeRepo: giteeResult.repo,
          } : {}),
          updatedAt: new Date(),
        })
        .where(eq(projects.id, input.projectId));

      return {
        success: true,
        filesImported: card.totalFiles,
        intelligenceCard: cardData,
        giteeSynced: !!giteeResult,
        giteeUrl: giteeResult ? `https://gitee.com/${giteeResult.owner}/${giteeResult.repo}` : null,
      };
    }),

  /**
   * Fetch file contents by path.
   * HYBRID ARCHITECTURE:
   *   1. Read from local disk (fastest, primary)
   *   2. Fall back to Gitee (cross-device sync of your own project)
   *   3. Return whatever we found
   */
  fetchFileContents: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        paths: z.array(z.string()).min(1).max(20),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const hasAccess = await canAccessProject(ctx.user.id, input.projectId);
      if (!hasAccess) throw new Error("Project not found");

      const db = getDb();
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);

      const results: Array<{ path: string; content: string; sizeBytes: number; language: string }> = [];
      const missingPaths: string[] = [];

      // ─── Step 1: Try disk first ───
      for (const filePath of input.paths) {
        const content = await disk.readProjectFile(input.projectId, filePath);
        if (content !== null) {
          results.push({
            path: filePath,
            content,
            sizeBytes: content.length,
            language: detectLanguage(filePath),
          });
        } else {
          missingPaths.push(filePath);
        }
      }

      // ─── Step 2: Gitee fallback for missing files ───
      if (missingPaths.length > 0 && project?.giteeOwner && project?.giteeRepo && ctx.giteeToken) {
        for (const filePath of missingPaths) {
          try {
            const { content } = await getFileContent(
              ctx.giteeToken,
              project.giteeOwner,
              project.giteeRepo,
              `project-files/${filePath}`,
              project.giteeBranch || "master"
            );
            results.push({
              path: filePath,
              content,
              sizeBytes: content.length,
              language: detectLanguage(filePath),
            });
            // Also save to disk for next time
            await disk.saveFile(input.projectId, filePath, content).catch(() => {});
          } catch {
            // Gitee doesn't have this file either
          }
        }
      }

      return results;
    }),

  /**
   * Smart fetch: find relevant files for a query, then return their contents.
   */
  fetchRelevantFileContents: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        query: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const hasAccess = await canAccessProject(ctx.user.id, input.projectId);
      if (!hasAccess) throw new Error("Project not found");

      const db = getDb();
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);

      if (!project?.intelligenceCard) {
        throw new Error("No Intelligence Card for this project. Import a project folder first.");
      }

      // Find relevant file paths using the Intelligence Card
      const card = project.intelligenceCard;
      const relevantPaths = findRelevantFiles(
        {
          version: card.version || 1,
          generatedAt: card.generatedAt || "",
          projectType: card.projectType as "code" | "business" | "mixed" | "data" | "unknown",
          primaryLanguage: card.primaryLanguage || "unknown",
          framework: card.framework || "custom",
          totalFiles: card.totalFiles || 0,
          totalSize: card.totalSize || 0,
          fileTree: card.fileTree.map((f: Record<string, unknown>) => ({
            path: String(f.path),
            name: String(f.name),
            size: Number(f.size),
            language: String(f.language),
            category: String(f.category) as "code" | "document" | "data" | "config" | "image" | "binary",
            exports: Array.isArray(f.exports) ? f.exports as string[] : [],
            description: String(f.description || ""),
            isEntryPoint: Boolean(f.isEntryPoint),
          })),
          dependencyGraph: [],
          entities: [],
          databaseTables: [],
          apiEndpoints: [],
          entryPoints: card.entryPoints || [],
          architecture: card.architecture || "flat",
          todos: card.todos || [],
          crossReferences: [],
          toLLMContext: () => "",
        },
        input.query,
      );

      if (relevantPaths.length === 0) {
        return { files: [], paths: [], note: "No relevant files found for this query" };
      }

      // Fetch contents for relevant files: disk first, Gitee fallback
      const files: Array<{ path: string; content: string; sizeBytes: number; language: string }> = [];
      const missingPaths: string[] = [];

      for (const filePath of relevantPaths) {
        const content = await disk.readProjectFile(input.projectId, filePath);
        if (content !== null) {
          files.push({ path: filePath, content, sizeBytes: content.length, language: detectLanguage(filePath) });
        } else {
          missingPaths.push(filePath);
        }
      }

      // Gitee fallback for missing files
      if (missingPaths.length > 0 && project?.giteeOwner && project?.giteeRepo && ctx.giteeToken) {
        for (const filePath of missingPaths) {
          try {
            const { content } = await getFileContent(
              ctx.giteeToken,
              project.giteeOwner,
              project.giteeRepo,
              `project-files/${filePath}`,
              project.giteeBranch || "master"
            );
            files.push({ path: filePath, content, sizeBytes: content.length, language: detectLanguage(filePath) });
            // Cache to disk for next time
            await disk.saveFile(input.projectId, filePath, content).catch(() => {});
          } catch {
            // Not on Gitee either
          }
        }
      }

      return {
        files,
        paths: relevantPaths,
        note: `Found ${relevantPaths.length} relevant files, retrieved ${files.length} contents (${missingPaths.length - (files.length - (relevantPaths.length - missingPaths.length))} from Gitee)`,
      };
    }),

  /**
   * Sync project files from Gitee to local disk.
   * Used when:
   *   - The owner opens their own project on a new device for the first time
   *   - A user logs in from a new computer (no local files)
   *   - Local files were deleted and need to be restored
   */
  syncFromGitee: authedQuery
    .input(z.object({ projectId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const hasAccess = await canAccessProject(ctx.user.id, input.projectId);
      if (!hasAccess) throw new Error("Project not found");
      if (!ctx.giteeToken) throw new Error("Gitee token required. Connect Gitee in Settings first.");
      const giteeToken = ctx.giteeToken; // narrowed to string

      const db = getDb();
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);

      if (!project?.giteeOwner || !project?.giteeRepo) {
        throw new Error("Project not synced to Gitee");
      }

      // Get file tree from Gitee
      const { getFileTree, getFileContent } = await import("../services/giteeService");
      const branch = project.giteeBranch || "master";
      const tree = await getFileTree(giteeToken, project.giteeOwner, project.giteeRepo, "project-files", branch);

      if (!Array.isArray(tree) || tree.length === 0) {
        return { synced: 0, message: "No files found on Gitee" };
      }

      // Download each file and save to disk
      let synced = 0;
      let failed = 0;
      const batchSize = 10;

      for (let i = 0; i < tree.length; i += batchSize) {
        const batch = tree.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (item: Record<string, unknown>) => {
            const filePath = String(item.path || "").replace(/^project-files\//, "");
            if (!filePath) return;

            try {
              const { content } = await getFileContent(
                giteeToken,
                project.giteeOwner!,
                project.giteeRepo!,
                String(item.path),
                branch
              );
              await disk.saveFile(input.projectId, filePath, content);
              synced++;
            } catch {
              failed++;
            }
          })
        );
      }

      return {
        synced,
        failed,
        message: `Synced ${synced} files from Gitee (${failed} failed)`,
      };
    }),

  /**
   * Get the Intelligence Card for a project.
   */
  getIntelligenceCard: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ input, ctx }) => {
      const hasAccess = await canAccessProject(ctx.user.id, input.projectId);
      if (!hasAccess) throw new Error("Project not found");

      const db = getDb();
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);

      return project?.intelligenceCard ?? null;
    }),

  /**
   * Fetch specific files from Gitee for LLM context.
   */
  fetchFilesFromGitee: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        filePaths: z.array(z.string()).min(1).max(20),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const hasAccess = await canAccessProject(ctx.user.id, input.projectId);
      if (!hasAccess) throw new Error("Project not found");

      const db = getDb();
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);

      if (!project?.giteeOwner || !project?.giteeRepo) {
        throw new Error("Project not synced to Gitee");
      }

      const giteeToken = ctx.giteeToken;
      if (!giteeToken) throw new Error("Gitee token required");

      const files = await fetchFilesFromGitee(
        giteeToken,
        project.giteeOwner,
        project.giteeRepo,
        input.filePaths,
      );

      return files;
    }),

  /**
   * Find relevant files for a query using the Intelligence Card.
   */
  findRelevantFiles: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        query: z.string().min(1),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);

      if (!project?.intelligenceCard) {
        throw new Error("No Intelligence Card for this project. Import a project folder first.");
      }

      // Reconstruct the card (need the dependency graph and full entities)
      // For now, return file paths that match the query
      const card = project.intelligenceCard;
      const queryLower = input.query.toLowerCase();

      const matches = card.fileTree.filter((f) => {
        const searchText = `${f.path} ${f.name} ${f.exports.join(" ")} ${f.description}`.toLowerCase();
        return queryLower.split(/\s+/).some((word) => searchText.includes(word) && word.length > 2);
      });

      return matches.slice(0, 15).map((f) => ({
        path: f.path,
        name: f.name,
        language: f.language,
        description: f.description,
        isEntryPoint: f.isEntryPoint,
        exports: f.exports.slice(0, 5),
      }));
    }),

  /**
   * Load file contents provided by the client (from local folder).
   * Used in the Hybrid Architecture: client reads files from local folder,
   * sends contents to server, which formats them for LLM context.
   */
  loadFileContents: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        files: z.array(
          z.object({
            path: z.string(),
            content: z.string(),
          })
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const hasAccess = await canAccessProject(ctx.user.id, input.projectId);
      if (!hasAccess) throw new Error("Project not found");

      // Format for LLM context (same format as fetchFileContents)
      const formatted = input.files
        .map((f) => `--- FILE: ${f.path} ---\n${f.content.substring(0, 50000)}`)
        .join("\n\n");

      const totalSize = input.files.reduce((sum, f) => sum + f.content.length, 0);

      return {
        files: input.files.map((f) => ({
          path: f.path,
          content: f.content.substring(0, 50000),
          sizeBytes: f.content.length,
        })),
        formatted,
        totalSize,
        fileCount: input.files.length,
      };
    }),

  /**
   * Clear the Intelligence Card (remove imported project data).
   */
  clearIntelligenceCard: authedQuery
    .input(z.object({ projectId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);

      if (!project) throw new Error("Project not found");
      if (project.userId !== ctx.user.id) throw new Error("Unauthorized");

      await db
        .update(projects)
        .set({ intelligenceCard: null })
        .where(eq(projects.id, input.projectId));

      // Clean up local disk files
      try {
        await disk.deleteProjectFiles(input.projectId);
      } catch { /* non-critical */ }

      return { success: true };
    }),
});
