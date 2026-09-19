// Shared pipeline creation helper: after a project and its steps exist,
// this creates the customAgents and pipelineTemplate that the web UI
// (My Pipelines / My Agents) expects. Used by both the MCP create_pipeline
// tool and the web template router.

import { and, eq, asc } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { projects, pipelineSteps, customAgents, pipelineTemplates } from "@db/schema";

/**
 * After pipelineSteps have been inserted for a project, create the
 * corresponding customAgents (one per unique non-approval role) and a
 * reusable pipelineTemplate, then link everything together.
 *
 * @param userId        Owner of the project
 * @param projectId     The project that already has pipelineSteps
 * @param templateName  Name for the template (e.g. project.name + " Pipeline")
 * @param templateDesc  Description for the template
 */
export async function finalizePipelineCreation(
  userId: number,
  projectId: number,
  templateName: string,
  templateDesc: string,
): Promise<void> {
  const db = getDb();

  // 1. Fetch the freshly inserted steps
  const steps = await db.select().from(pipelineSteps)
    .where(eq(pipelineSteps.projectId, projectId))
    .orderBy(asc(pipelineSteps.stepOrder));

  if (steps.length === 0) return; // nothing to finalize

  // 2. Create / reuse customAgents for each unique non-approval step
  const agentMap = new Map<string, number>(); // role -> agentId

  for (const s of steps) {
    if (s.stepType === "approval" || !s.role) continue;

    const key = `${s.role}-${s.name}`;
    if (agentMap.has(key)) continue;

    const slug = `${s.role}-${s.name.toLowerCase().replace(/[^a-z0-9_-]/g, "").substring(0, 30)}`;

    // Check if this agent already exists for the user
    const [existing] = await db.select().from(customAgents)
      .where(and(
        eq(customAgents.userId, userId),
        eq(customAgents.slug, slug),
      )).limit(1);

    if (existing) {
      agentMap.set(key, existing.id);
      continue;
    }

    // Create the agent
    const [agentResult] = await db.insert(customAgents).values({
      userId,
      name: s.name,
      slug,
      role: s.role,
      systemPrompt: s.systemPrompt ?? `Auto-created ${s.role} agent for pipeline execution.`,
      description: `Created for pipeline: ${templateName}`,
      defaultProviderId: s.providerId ?? null,
      temperature: s.temperature ?? "0.7",
      maxTokens: s.maxTokens ?? 4096,
    });

    agentMap.set(key, Number(agentResult.insertId));
  }

  // 3. Update pipelineSteps with agentIds
  for (const s of steps) {
    if (s.stepType === "approval" || !s.role) continue;
    const agentId = agentMap.get(`${s.role}-${s.name}`) ?? null;
    if (agentId) {
      await db.update(pipelineSteps)
        .set({ agentId })
        .where(eq(pipelineSteps.id, s.id));
    }
  }

  // 4. Build template steps from the saved steps
  const templateSteps = steps.map((s) => ({
    name: s.name,
    role: s.role,
    systemPrompt: s.systemPrompt,
    stepType: s.stepType ?? "agent",
    ifConfig: s.ifConfig ?? null,
    whileConfig: s.whileConfig ?? null,
    providerId: s.providerId,
    model: s.model,
    temperature: s.temperature ?? "0.7",
    maxTokens: s.maxTokens ?? 4096,
  }));

  // 5. Create the pipelineTemplate
  const [tplResult] = await db.insert(pipelineTemplates).values({
    userId,
    name: templateName,
    description: templateDesc,
    steps: templateSteps,
    isAuto: false,
    sourceProjectId: projectId,
  });

  const templateId = Number(tplResult.insertId);

  // 6. Update project to reference the template
  await db.update(projects)
    .set({ pipelineTemplateId: templateId })
    .where(eq(projects.id, projectId));
}
