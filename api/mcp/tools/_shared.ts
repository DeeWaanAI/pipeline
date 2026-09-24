// Shared helpers for MCP tools: project access checks + output compaction.
// canAccessProject is OWNER-ONLY: team sharing was removed (ticket #26), so a
// project is reachable by the account that owns it and by nobody else. MCP
// tokens are bearer credentials, so every tool must call this BEFORE
// returning any data.

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { llmProviders, projects, pipelineSteps } from "@db/schema";
import type { PipelineStepInput } from "./pipelineValidation";

/** Insert validated steps as pipeline_steps rows (stepOrder = 1-based index). */
export async function insertProjectSteps(
  projectId: number,
  steps: PipelineStepInput[],
): Promise<void> {
  const db = getDb();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await db.insert(pipelineSteps).values({
      projectId,
      stepOrder: i + 1,
      stepType: s.stepType,
      name: s.name,
      role: s.stepType === "approval" ? "approval" : (s.role ?? "custom"),
      systemPrompt: s.stepType === "approval" ? (s.systemPrompt ?? "Human review required") : (s.systemPrompt ?? "Process the input"),
      model: s.model ?? null,
      providerId: s.providerId ?? null,
      temperature: s.temperature ?? "0.7",
      maxTokens: s.maxTokens ?? 4096,
      ifConfig: s.stepType === "if" ? (s.ifConfig ?? null) : null,
      whileConfig: s.stepType === "while" ? (s.whileConfig ?? null) : null,
      isEnabled: true,
    });
  }
}

export async function requireOwnedProviders(userId: number, ids: Array<number | null | undefined>): Promise<void> {
  const providerIds = [...new Set(ids.filter((id): id is number => id != null))];
  if (!providerIds.length) return;
  const owned = await getDb().select({ id: llmProviders.id }).from(llmProviders)
    .where(and(eq(llmProviders.userId, userId), inArray(llmProviders.id, providerIds)));
  const ownedIds = new Set(owned.map((p) => p.id));
  const missing = providerIds.find((id) => !ownedIds.has(id));
  if (missing !== undefined) {
    throw new Error(`Provider ${missing} is not one of your configured providers. Call get_settings to list your provider ids.`);
  }
}

/** Owner-only access to a project. */
export async function canAccessProject(userId: number, projectId: number): Promise<boolean> {
  const db = getDb();
  const [project] = await db
    .select({ userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return !!project && project.userId === userId;
}

/** Throw a uniform, non-leaky error when access is denied. */
export async function requireProjectAccess(userId: number, projectId: number): Promise<void> {
  const ok = await canAccessProject(userId, projectId);
  if (!ok) throw new Error("Project not found");
}

/** Truncate long text for compact MCP output (JSON-serializable, bounded). */
export function truncate(text: string | null | undefined, max: number): string {
  const s = text ?? "";
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}
