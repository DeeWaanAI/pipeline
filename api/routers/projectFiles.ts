import { z } from "zod";
import { eq, and, sql, inArray } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { projectFiles, fileDependencies } from "@db/schema";
import { createRouter, authedQuery } from "../middleware";

// Parse TypeScript/JavaScript imports from file content
function extractImports(content: string): Array<{ path: string; type: string; line: number }> {
  const imports: Array<{ path: string; type: string; line: number }> = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ES6 imports: import { x } from "./file" or import x from "@/lib/x"
    const es6Match = line.match(/import\s+.*?\s+from\s+['"]([^'"]+)['"]/);
    if (es6Match) {
      imports.push({ path: es6Match[1], type: "import", line: i + 1 });
      continue;
    }

    // CommonJS: require("./file")
    const cjsMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (cjsMatch) {
      imports.push({ path: cjsMatch[1], type: "require", line: i + 1 });
      continue;
    }

    // Dynamic import: import("./file")
    const dynMatch = line.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (dynMatch) {
      imports.push({ path: dynMatch[1], type: "dynamic", line: i + 1 });
    }
  }

  return imports;
}

// Resolve import path to actual file path
function resolveImportPath(importPath: string, currentFilePath: string): string | null {
  // Skip external packages (no ./ or ../ or @/)
  if (!importPath.startsWith(".") && !importPath.startsWith("@/")) return null;

  // Handle @/ alias (common in Vite/Webpack projects)
  if (importPath.startsWith("@/")) {
    // Convert @/api/routers/swarm -> api/routers/swarm
    return importPath.slice(2);
  }

  // Handle relative imports
  if (importPath.startsWith("./") || importPath.startsWith("../")) {
    const currentDir = currentFilePath.split("/").slice(0, -1).join("/");
    const resolved = currentDir + "/" + importPath;
    // Normalize .. and .
    const parts = resolved.split("/");
    const normalized: string[] = [];
    for (const part of parts) {
      if (part === "..") normalized.pop();
      else if (part !== "." && part !== "") normalized.push(part);
    }
    return normalized.join("/");
  }

  return null;
}

export const projectFilesRouter = createRouter({
  // ── Upload a file ────────────────────────────────────────────────
  upload: authedQuery
    .input(
      z.object({
        projectId: z.number(),
        path: z.string(),
        name: z.string(),
        mimeType: z.string().optional(),
        content: z.string().optional(), // Text content
        base64: z.string().optional(), // For binary files (images etc.)
        size: z.number(),
        isDirectory: z.boolean().optional(),
        parentPath: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify project ownership
      const { projects } = await import("@db/schema");
      const [project] = await getDb()
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));

      if (!project) throw new Error("Project not found");

      // Check if file already exists
      const [existing] = await getDb()
        .select()
        .from(projectFiles)
        .where(and(eq(projectFiles.projectId, input.projectId), eq(projectFiles.path, input.path)));

      const now = new Date();
      let fileContent = input.content ?? null;

      // For binary files, store a reference marker
      if (input.base64 && !fileContent) {
        fileContent = `[Binary file: ${input.name}]`;
      }

      if (existing) {
        // Update existing
        await getDb()
          .update(projectFiles)
          .set({
            content: fileContent,
            mimeType: input.mimeType ?? existing.mimeType,
            sizeBytes: input.size,
            updatedAt: now,
          })
          .where(eq(projectFiles.id, existing.id));

        // Re-scan dependencies
        if (fileContent && input.path.match(/\.(ts|tsx|js|jsx)$/)) {
          await scanFileDependencies(input.projectId, existing.id, input.path, fileContent);
        }

        return { id: existing.id, message: "File updated" };
      }

      // Insert new
      const [file] = await getDb().insert(projectFiles).values({
        projectId: input.projectId,
        path: input.path,
        name: input.name,
        mimeType: input.mimeType ?? null,
        sizeBytes: input.size,
        content: fileContent,
        isDirectory: input.isDirectory ?? false,
        parentPath: input.parentPath ?? null,
        createdAt: now,
        updatedAt: now,
      });

      // Scan dependencies for code files
      if (fileContent && input.path.match(/\.(ts|tsx|js|jsx)$/)) {
        await scanFileDependencies(input.projectId, file.insertId ?? 0, input.path, fileContent);
      }

      return { id: file.insertId, message: "File uploaded" };
    }),

  // ── List files for a project ─────────────────────────────────────
  list: authedQuery
    .input(z.object({ projectId: z.number() }))
    .query(async ({ input, ctx }) => {
      const { projects } = await import("@db/schema");
      const [project] = await getDb()
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));

      if (!project) throw new Error("Project not found");

      const files = await getDb()
        .select()
        .from(projectFiles)
        .where(eq(projectFiles.projectId, input.projectId))
        .orderBy(projectFiles.path);

      return files;
    }),

  // ── Read file content ────────────────────────────────────────────
  read: authedQuery
    .input(z.object({ projectId: z.number(), fileId: z.number() }))
    .query(async ({ input, ctx }) => {
      const { projects } = await import("@db/schema");
      const [project] = await getDb()
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));

      if (!project) throw new Error("Project not found");

      const [file] = await getDb()
        .select()
        .from(projectFiles)
        .where(and(eq(projectFiles.id, input.fileId), eq(projectFiles.projectId, input.projectId)));

      if (!file) throw new Error("File not found");

      return file;
    }),

  // ── Delete a file ────────────────────────────────────────────────
  delete: authedQuery
    .input(z.object({ projectId: z.number(), fileId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const { projects } = await import("@db/schema");
      const [project] = await getDb()
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));

      if (!project) throw new Error("Project not found");

      // Delete dependencies first
      await getDb()
        .delete(fileDependencies)
        .where(
          sql`source_file_id = ${input.fileId} OR target_file_id = ${input.fileId}`
        );

      await getDb()
        .delete(projectFiles)
        .where(and(eq(projectFiles.id, input.fileId), eq(projectFiles.projectId, input.projectId)));

      return { message: "File deleted" };
    }),

  // ── Get file dependencies (cross-file awareness) ─────────────────
  getDependencies: authedQuery
    .input(z.object({ projectId: z.number(), fileId: z.number() }))
    .query(async ({ input, ctx }) => {
      const { projects } = await import("@db/schema");
      const [project] = await getDb()
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));

      if (!project) throw new Error("Project not found");

      // Files this file imports (outgoing)
      const outgoing = await getDb()
        .select({
          targetId: fileDependencies.targetFileId,
          targetPath: projectFiles.path,
          targetName: projectFiles.name,
          importType: fileDependencies.importType,
        })
        .from(fileDependencies)
        .innerJoin(projectFiles, eq(projectFiles.id, fileDependencies.targetFileId))
        .where(eq(fileDependencies.sourceFileId, input.fileId));

      // Files that import this file (incoming)
      const incoming = await getDb()
        .select({
          sourceId: fileDependencies.sourceFileId,
          sourcePath: projectFiles.path,
          sourceName: projectFiles.name,
          importType: fileDependencies.importType,
        })
        .from(fileDependencies)
        .innerJoin(projectFiles, eq(projectFiles.id, fileDependencies.sourceFileId))
        .where(eq(fileDependencies.targetFileId, input.fileId));

      return { outgoing, incoming };
    }),

  // ── Find affected files (impact analysis) ────────────────────────
  getAffectedFiles: authedQuery
    .input(z.object({ projectId: z.number(), fileId: z.number() }))
    .query(async ({ input, ctx }) => {
      const { projects } = await import("@db/schema");
      const [project] = await getDb()
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.userId, ctx.user.id)));

      if (!project) throw new Error("Project not found");

      // Batched BFS: query all files at each level instead of one-by-one
      const visited = new Set<number>();
      let currentLevel: number[] = [input.fileId];
      const affected: Array<{ id: number; path: string; name: string }> = [];

      while (currentLevel.length > 0) {
        for (const id of currentLevel) visited.add(id);

        // Single batch query: find all importers for the current level
        const importers = await getDb()
          .select({
            sourceId: fileDependencies.sourceFileId,
            sourcePath: projectFiles.path,
            sourceName: projectFiles.name,
          })
          .from(fileDependencies)
          .innerJoin(projectFiles, eq(projectFiles.id, fileDependencies.sourceFileId))
          .where(inArray(fileDependencies.targetFileId, currentLevel));

        const nextLevel: number[] = [];
        for (const imp of importers) {
          if (!visited.has(imp.sourceId)) {
            visited.add(imp.sourceId);
            nextLevel.push(imp.sourceId);
            affected.push({ id: imp.sourceId, path: imp.sourcePath, name: imp.sourceName });
          }
        }

        currentLevel = nextLevel;
      }

      return affected;
    }),
});

// ─── Scan file and build dependency graph ──────────────────────────
async function scanFileDependencies(
  projectId: number,
  fileId: number,
  filePath: string,
  content: string,
) {
  // Clear existing dependencies for this file
  await getDb()
    .delete(fileDependencies)
    .where(eq(fileDependencies.sourceFileId, fileId));

  const imports = extractImports(content);

  // Collect ALL possible paths for ALL imports (batch instead of 7 queries per import)
  const importPathMap = new Map<string, { type: string; resolvedPath: string }>();
  const allPossiblePaths: string[] = [];

  for (const imp of imports) {
    const resolvedPath = resolveImportPath(imp.path, filePath);
    if (!resolvedPath) continue;

    const possiblePaths = [
      resolvedPath,
      resolvedPath + ".ts",
      resolvedPath + ".tsx",
      resolvedPath + ".js",
      resolvedPath + ".jsx",
      resolvedPath + "/index.ts",
      resolvedPath + "/index.tsx",
      resolvedPath + "/index.js",
    ];

    importPathMap.set(resolvedPath, { type: imp.type, resolvedPath });
    allPossiblePaths.push(...possiblePaths);
  }

  if (allPossiblePaths.length === 0) return;

  // Single batch query: find all matching files at once
  const existingFiles = await getDb()
    .select({ id: projectFiles.id, path: projectFiles.path })
    .from(projectFiles)
    .where(and(
      eq(projectFiles.projectId, projectId),
      inArray(projectFiles.path, allPossiblePaths),
    ));

  const pathToFileId = new Map(existingFiles.map((f) => [f.path, f.id]));

  // Match each import to its target file (first matching path wins)
  for (const [resolvedPath, info] of importPathMap) {
    const possiblePaths = [
      resolvedPath,
      resolvedPath + ".ts",
      resolvedPath + ".tsx",
      resolvedPath + ".js",
      resolvedPath + ".jsx",
      resolvedPath + "/index.ts",
      resolvedPath + "/index.tsx",
      resolvedPath + "/index.js",
    ];

    for (const tryPath of possiblePaths) {
      const targetId = pathToFileId.get(tryPath);
      if (targetId) {
        await getDb().insert(fileDependencies).values({
          projectId,
          sourceFileId: fileId,
          targetFileId: targetId,
          importType: info.type,
        });
        break;
      }
    }
  }
}
