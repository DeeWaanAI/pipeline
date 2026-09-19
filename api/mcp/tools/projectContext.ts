// MCP tool: project_context — the project's Intelligence Card plus,
// optionally, the most relevant file contents for a query. Reuses the
// relevance scoring from api/services/projectIntelligence.findRelevantFiles
// and disk file storage from api/services/projectFilesDisk (same sources as
// api/routers/projectImport.ts fetchRelevantFileContents).

import { z } from "zod";
import { eq } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../types";
import { getDb } from "../../queries/connection";
import { projects } from "@db/schema";
import { findRelevantFiles } from "../../services/projectIntelligence";
import { readProjectFile } from "../../services/projectFilesDisk";
import { requireProjectAccess, truncate } from "./_shared";

const inputSchema = z.object({
  projectId: z.number().int().positive(),
  query: z.string().min(1).max(2000).optional(),
});

const MAX_FILES = 3;
const MAX_FILE_CHARS = 4000;
const MAX_TREE_ENTRIES = 100;

export const projectContext: McpTool = {
  name: "project_context",
  description:
    "Get a project's Intelligence Card (type, framework, file tree, entities, endpoints, TODOs). When a query is provided, also returns the contents of the up to 3 most relevant files.",
  inputSchema,
  requiredScopes: ["mcp:read"],
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = inputSchema.parse(args);

    // Access check BEFORE any data is returned.
    await requireProjectAccess(ctx.userId, input.projectId);

    const db = getDb();
    const [project] = await db.select().from(projects)
      .where(eq(projects.id, input.projectId)).limit(1);
    if (!project) throw new Error("Project not found");

    const card = project.intelligenceCard;
    if (!card) {
      return {
        projectId: input.projectId,
        projectName: project.name,
        intelligenceCard: null,
        hint: "Intelligence Card not generated — import a project folder first.",
        files: [],
      };
    }

    // Compact card output: cap the large arrays.
    const compactCard = {
      version: card.version,
      generatedAt: card.generatedAt,
      projectType: card.projectType,
      primaryLanguage: card.primaryLanguage,
      framework: card.framework,
      totalFiles: card.totalFiles,
      architecture: card.architecture,
      entryPoints: (card.entryPoints ?? []).slice(0, 20),
      entities: (card.entities ?? []).slice(0, 50),
      databaseTables: (card.databaseTables ?? []).slice(0, 50),
      apiEndpoints: (card.apiEndpoints ?? []).slice(0, 50),
      todos: (card.todos ?? []).slice(0, 20),
      fileTree: (card.fileTree ?? []).slice(0, MAX_TREE_ENTRIES),
      ...(card.fileTree && card.fileTree.length > MAX_TREE_ENTRIES
        ? { fileTreeTruncated: card.fileTree.length - MAX_TREE_ENTRIES }
        : {}),
    };

    // Optional: up to 3 most relevant file contents for the query.
    const files: Array<{ path: string; language: string; content: string; truncated: boolean }> = [];
    if (input.query) {
      // Reconstruct the minimal card shape expected by findRelevantFiles
      // (same projection as projectImport.fetchRelevantFileContents).
      const miniCard = {
        version: card.version || 1,
        generatedAt: card.generatedAt || "",
        projectType: (card.projectType || "unknown") as "code" | "business" | "mixed" | "data" | "unknown",
        primaryLanguage: card.primaryLanguage || "unknown",
        framework: card.framework || "custom",
        totalFiles: card.totalFiles || 0,
        totalSize: card.totalSize || 0,
        fileTree: (card.fileTree ?? []).map((f) => ({
          path: String(f.path),
          name: String(f.name),
          size: Number(f.size),
          language: String(f.language),
          category: String(f.category || "unknown") as "code" | "document" | "data" | "config" | "image" | "binary",
          exports: Array.isArray(f.exports) ? f.exports : [],
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
      };

      const relevantPaths = findRelevantFiles(miniCard, input.query).slice(0, MAX_FILES);
      const langByPath = new Map((card.fileTree ?? []).map((f) => [f.path, f.language]));
      for (const filePath of relevantPaths) {
        const content = await readProjectFile(input.projectId, filePath);
        if (content === null) continue;
        files.push({
          path: filePath,
          language: langByPath.get(filePath) ?? "unknown",
          content: truncate(content, MAX_FILE_CHARS),
          truncated: content.length > MAX_FILE_CHARS,
        });
      }
    }

    return {
      projectId: input.projectId,
      projectName: project.name,
      intelligenceCard: compactCard,
      files,
    };
  },
};
