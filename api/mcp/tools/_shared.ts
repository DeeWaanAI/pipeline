// Shared helpers for MCP tools: project access checks + output compaction.
// canAccessProject mirrors api/routers/swarm.ts (owner OR team member via a
// single teamMembers⨯teamProjects join). MCP tokens are bearer credentials, so
// every tool must call this BEFORE returning any data.

import { eq, and } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { projects, pipelineSteps, teamMembers, teamProjects } from "@db/schema";
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
      temperature: s.temperature ?? "0.7",
      maxTokens: s.maxTokens ?? 4096,
      ifConfig: s.stepType === "if" ? (s.ifConfig ?? null) : null,
      whileConfig: s.stepType === "while" ? (s.whileConfig ?? null) : null,
      isEnabled: true,
    });
  }
}

/** Owner or team-member access to a project. */
export async function canAccessProject(userId: number, projectId: number): Promise<boolean> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return false;
  if (project.userId === userId) return true;

  const [teamAccess] = await db
    .select({ id: teamMembers.userId })
    .from(teamMembers)
    .innerJoin(teamProjects, eq(teamProjects.teamId, teamMembers.teamId))
    .where(and(
      eq(teamMembers.userId, userId),
      eq(teamProjects.projectId, projectId),
    ))
    .limit(1);

  return !!teamAccess;
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
