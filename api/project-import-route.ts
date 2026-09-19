/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROJECT IMPORT ROUTE (Raw HTTP POST)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dedicated endpoint for uploading project ZIP files.
 * Bypasses tRPC entirely to handle large binary files without
 * JSON serialization overhead or payload limits.
 *
 * POST /api/import-project
 *   Body: multipart/form-data { projectId: "1", zipFile: <File> }
 *   Returns: { success: true, filesImported: N, intelligenceCard: {...} }
 */

import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { verifyLocalToken } from "./routers/localAuth";
import { getDb } from "./queries/connection";
import { projects, users } from "@db/schema";
import { eq } from "drizzle-orm";
import { generateIntelligenceCard } from "./services/projectIntelligence";
import * as giteeService from "./services/giteeService";
import * as disk from "./services/projectFilesDisk";
import { logger } from "./lib/logger";

const MAX_ZIP_SIZE = 50 * 1024 * 1024; // 50MB

// ─── Auth helper ──────────────────────────────────────────────────
async function getAuthUser(req: Request) {
  const localToken = req.headers.get("x-local-auth-token");
  if (localToken) {
    const claim = await verifyLocalToken(localToken);
    if (claim) {
      const [user] = await getDb()
        .select()
        .from(users)
        .where(eq(users.id, claim.userId))
        .limit(1);
      if (user) return user;
    }
  }
  return null;
}

// ─── Excluded patterns for ZIP extraction ─────────────────────────
const EXCLUDED_PATTERNS = [
  /^node_modules\//, /^\.git\//, /^dist\//, /^build\//,
  /^\.next\//, /^__pycache__\//, /\.pyc$/, /^\.DS_Store/,
  /^__MACOSX\//,
  /^\.env/, /\.lock$/, /^package-lock\.json/, /^yarn\.lock/,
  /\.min\.(js|css)$/, /\.map$/, /\.log$/,
];

export function registerProjectImportRoute(app: Hono<{ Bindings: HttpBindings }>) {
  app.post("/api/import-project", async (c) => {
    // ─── Auth ───
    const user = await getAuthUser(c.req.raw);
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // ─── Parse multipart ───
    let zipFile: File | undefined;
    let projectId: number | undefined;
    let giteeToken: string | undefined;
    try {
      const body = await c.req.parseBody({ all: false });

      const uploaded = body.zipFile;
      if (!uploaded) {
        return c.json({ error: "No zipFile provided" }, 400);
      }
      zipFile = uploaded as File;

      const pid = body.projectId;
      if (pid) {
        projectId = parseInt(pid as string, 10);
      }

      const gt = body.giteeToken;
      if (gt) {
        giteeToken = gt as string;
      }
    } catch (err) {
      logger.error("Import parse failed", { error: (err as Error).message });
      return c.json({ error: `Failed to parse upload: ${(err as Error).message}` }, 400);
    }

    if (!zipFile || zipFile.size === 0) {
      return c.json({ error: "Empty file" }, 400);
    }

    if (zipFile.size > MAX_ZIP_SIZE) {
      return c.json({ error: `ZIP too large. Max: ${MAX_ZIP_SIZE / 1024 / 1024}MB` }, 413);
    }

    if (!projectId || isNaN(projectId)) {
      return c.json({ error: "projectId is required" }, 400);
    }

    logger.info("Import uploading ZIP", { userId: user.id, projectId, sizeKB: (zipFile.size / 1024).toFixed(1) });

    // ─── Verify project ownership ───
    const db = getDb();
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    if (project.userId !== user.id) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    try {
      // ─── Read ZIP buffer ───
      const arrayBuffer = await zipFile.arrayBuffer();
      const zipBuffer = Buffer.from(arrayBuffer);

      // ─── Generate Intelligence Card ───
      const card = await generateIntelligenceCard(zipBuffer);

      // ─── Extract file contents ───
      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip(zipBuffer);
      const entries = zip.getEntries();
      const fileContents: Array<{ path: string; content: string }> = [];
      const MAX_FILE_CONTENT_SIZE = 100 * 1024; // 100KB per file
      let skippedLarge = 0;

      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const path = entry.entryName;
        if (EXCLUDED_PATTERNS.some((p) => p.test(path))) continue;

        const data = entry.getData();
        if (!data || data.length === 0) continue;

        const isBinary = data.includes(0) || data.length > 5 * 1024 * 1024;
        if (isBinary) continue;

        try {
          const text = data.toString("utf-8");
          if (!text.includes("\uFFFD")) {
            if (text.length > MAX_FILE_CONTENT_SIZE) {
              // Truncate large files — keep first 100KB, add truncation notice
              fileContents.push({
                path,
                content: text.substring(0, MAX_FILE_CONTENT_SIZE) +
                  `\n\n[... FILE TRUNCATED: ${path} is ${(text.length / 1024).toFixed(1)}KB total. Only first 100KB stored.]`,
              });
              skippedLarge++;
            } else {
              fileContents.push({ path, content: text });
            }
          }
        } catch {
          // Skip files that can't be decoded
        }
      }

      logger.info("Import extracted text files from ZIP", { count: fileContents.length, truncated: skippedLarge });

      // ─── Store file contents on DISK (not MySQL) ───
      // Delete old files first
      await disk.deleteProjectFiles(projectId);

      if (fileContents.length > 0) {
        const { saved, failed } = await disk.saveProjectFiles(
          projectId,
          fileContents.map((f) => ({ path: f.path, content: f.content }))
        );
        logger.info("Import stored files on disk", { saved, total: fileContents.length, failed });
      }

      // ─── Build card data ───
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
      };

      // ─── Store Intelligence Card in project ───
      await db
        .update(projects)
        .set({
          intelligenceCard: cardData,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId));

      logger.info("Import Intelligence Card stored", { projectId });

      // ─── Push files to Gitee for cross-device sync + team sharing (async, non-blocking) ───
      if (giteeToken && project.giteeOwner && project.giteeRepo) {
        (async () => {
          try {
            const branch = project.giteeBranch || "master";
            const owner = project.giteeOwner!;
            const repo = project.giteeRepo!;

            // Push ZIP as backup (single reliable operation)
            const base64Content = zipBuffer.toString("base64");
            await giteeService.createOrUpdateFile(
              giteeToken, owner, repo,
              "project-source/project.zip",
              base64Content,
              "Backup project ZIP from import",
              branch
            );
            logger.info("Import ZIP synced to Gitee", { owner, repo });
          } catch (giteeErr) {
            // Gitee sync is best-effort, don't fail the import
            logger.error("Import Gitee sync failed (non-critical)", { error: (giteeErr as Error).message });
          }
        })();
      }

      return c.json({
        success: true,
        filesImported: card.totalFiles,
        intelligenceCard: cardData,
      });
    } catch (err) {
      logger.error("Import processing failed", { error: (err as Error).message });
      return c.json({ error: `Import failed: ${(err as Error).message}` }, 500);
    }
  });
}
