// MCP tools (Phase 2 — TeamSync): team_skills_list + team_skill_use.
// Discover reusable skills across the team — shared pipeline steps, shared
// custom agents, and the caller's marketplace-licensed pipelines — then
// import one into a project you own (inserted copy disabled by default).

import { z } from "zod";
import { eq, and, inArray, asc } from "drizzle-orm";
import type { McpTool, McpAuthContext } from "../../types";
import { getDb } from "../../../queries/connection";
import {
  customAgents, pipelineSteps, projects, teamMembers, teamProjects, users,
} from "@db/schema";
import { getActiveEntitlements } from "../../../services/entitlements";
import { logger } from "../../../lib/logger";
import { truncate } from "../_shared";

const MARKETPLACE_CAPABILITY_PREFIX = "pipeline:run:";
const MAX_ITEMS_PER_KIND = 100;

const listInputSchema = z.object({
  teamId: z.number().int().positive(),
});

const useInputSchema = z.object({
  teamId: z.number().int().positive(),
  kind: z.enum(["pipeline", "agent"]),
  id: z.number().int().positive(),
  targetProjectId: z.number().int().positive(),
});

async function requireTeamMembership(userId: number, teamId: number): Promise<void> {
  const db = getDb();
  const [membership] = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  if (!membership) throw new Error("Team not found");
}

export const teamSkillsList: McpTool = {
  name: "team_skills_list",
  description:
    "List skills available to you through a team: pipeline steps from team-shared projects, custom agents from teammates, and your marketplace-licensed pipelines. Use team_skill_use to import one into your own project.",
  inputSchema: listInputSchema,
  requiredScopes: ["team:read"],
  featureFlag: "teamsync",
  annotations: { readOnlyHint: true },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = listInputSchema.parse(args);

    // Access check BEFORE any data is returned.
    await requireTeamMembership(ctx.userId, input.teamId);

    const db = getDb();
    const skills: Array<Record<string, unknown>> = [];

    // (1) Shared pipelines — mirror team.getSharedPipelines: steps from all
    // projects shared with the team, with their project name.
    const shared = await db
      .select({ projectId: teamProjects.projectId })
      .from(teamProjects)
      .where(eq(teamProjects.teamId, input.teamId));
    const projectIds = shared.map((s) => s.projectId);

    if (projectIds.length > 0) {
      const steps = await db
        .select({
          id: pipelineSteps.id,
          projectId: pipelineSteps.projectId,
          name: pipelineSteps.name,
          role: pipelineSteps.role,
          stepType: pipelineSteps.stepType,
        })
        .from(pipelineSteps)
        .where(inArray(pipelineSteps.projectId, projectIds))
        .orderBy(asc(pipelineSteps.stepOrder))
        .limit(MAX_ITEMS_PER_KIND);

      const projectList = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(inArray(projects.id, projectIds));
      const nameMap = new Map(projectList.map((p) => [p.id, p.name]));

      for (const s of steps) {
        skills.push({
          kind: "pipeline",
          id: s.id,
          name: truncate(s.name, 100),
          role: s.role,
          stepType: s.stepType,
          project: { id: s.projectId, name: truncate(nameMap.get(s.projectId) ?? `Project #${s.projectId}`, 100) },
        });
      }
    }

    // (2) Shared agents — mirror team.getSharedAgents: custom agents owned
    // by OTHER team members, with the owner's username.
    const members = await db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, input.teamId));
    const otherIds = members.map((m) => m.userId).filter((id) => id !== ctx.userId);

    if (otherIds.length > 0) {
      const agents = await db
        .select({
          id: customAgents.id,
          userId: customAgents.userId,
          name: customAgents.name,
          role: customAgents.role,
        })
        .from(customAgents)
        .where(inArray(customAgents.userId, otherIds))
        .limit(MAX_ITEMS_PER_KIND);

      const agentUsers = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, otherIds));
      const userMap = new Map(agentUsers.map((u) => [u.id, u.username]));

      for (const a of agents) {
        skills.push({
          kind: "agent",
          id: a.id,
          name: truncate(a.name, 100),
          role: a.role,
          owner: { id: a.userId, name: truncate(userMap.get(a.userId) ?? `User #${a.userId}`, 100) },
        });
      }
    }

    // (3) Marketplace-licensed pipelines — the caller's active entitlements
    // with the pipeline:run: capability prefix.
    const entitlements = await getActiveEntitlements("user", ctx.userId);
    for (const e of entitlements) {
      if (!e.capability.startsWith(MARKETPLACE_CAPABILITY_PREFIX)) continue;
      skills.push({
        kind: "marketplace",
        id: e.sourceRef ?? e.capability,
        name: e.capability.slice(MARKETPLACE_CAPABILITY_PREFIX.length),
        source: e.source,
        expiresAt: e.expiresAt,
      });
    }

    logger.info("[mcp:team_skills_list] listed", {
      teamId: input.teamId, skillCount: skills.length, userId: ctx.userId,
      clientId: ctx.clientId, requestId: ctx.requestId,
    });

    return { teamId: input.teamId, skills };
  },
};

export const teamSkillUse: McpTool = {
  name: "team_skill_use",
  description:
    "Import a team skill (a shared pipeline step or a teammate's custom agent) into a project you own. The imported copy is disabled by default — enable it in the project before running it.",
  inputSchema: useInputSchema,
  requiredScopes: ["team:write"],
  featureFlag: "teamsync",
  annotations: { readOnlyHint: false, destructiveHint: false },
  handler: async (args: unknown, ctx: McpAuthContext) => {
    const input = useInputSchema.parse(args);

    const db = getDb();

    // Access checks BEFORE any mutation: team membership + target ownership.
    await requireTeamMembership(ctx.userId, input.teamId);

    const [targetProject] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, input.targetProjectId), eq(projects.userId, ctx.userId)))
      .limit(1);
    if (!targetProject) throw new Error("Target project not found");

    if (input.kind === "pipeline") {
      // Mirror team.importPipeline: copy the step to the end of the target
      // project's pipeline, disabled by default.
      const [sourceStep] = await db
        .select()
        .from(pipelineSteps)
        .where(eq(pipelineSteps.id, input.id))
        .limit(1);
      if (!sourceStep) throw new Error("Pipeline step not found");

      const existingSteps = await db
        .select({ stepOrder: pipelineSteps.stepOrder })
        .from(pipelineSteps)
        .where(eq(pipelineSteps.projectId, input.targetProjectId));
      const nextOrder = existingSteps.length > 0
        ? Math.max(...existingSteps.map((s) => s.stepOrder)) + 1
        : 1;

      await db.insert(pipelineSteps).values({
        projectId: input.targetProjectId,
        stepOrder: nextOrder,
        name: `${sourceStep.name} (imported)`,
        role: sourceStep.role,
        systemPrompt: sourceStep.systemPrompt,
        isEnabled: false, // Disabled by default — user must enable
        stepType: sourceStep.stepType,
        providerId: sourceStep.providerId,
        model: sourceStep.model,
        temperature: sourceStep.temperature,
        maxTokens: sourceStep.maxTokens,
      });

      logger.info("[mcp:team_skill_use] pipeline step imported", {
        teamId: input.teamId, stepId: input.id, targetProjectId: input.targetProjectId,
        userId: ctx.userId, clientId: ctx.clientId, requestId: ctx.requestId,
      });

      return { success: true, kind: "pipeline", name: sourceStep.name, enabled: false };
    }

    // kind === "agent" — mirror team.importAgent: copy the agent for the
    // caller, resolving slug collisions with an -imported suffix.
    const [sourceAgent] = await db
      .select()
      .from(customAgents)
      .where(eq(customAgents.id, input.id))
      .limit(1);
    if (!sourceAgent) throw new Error("Agent not found");

    const [existing] = await db
      .select()
      .from(customAgents)
      .where(and(
        eq(customAgents.userId, ctx.userId),
        eq(customAgents.slug, sourceAgent.slug),
      ))
      .limit(1);

    const slug = existing ? `${sourceAgent.slug}-imported` : sourceAgent.slug;

    await db.insert(customAgents).values({
      userId: ctx.userId,
      name: `${sourceAgent.name} (imported)`,
      slug,
      role: sourceAgent.role,
      description: sourceAgent.description,
      systemPrompt: sourceAgent.systemPrompt,
      defaultModel: sourceAgent.defaultModel,
      temperature: sourceAgent.temperature,
      maxTokens: sourceAgent.maxTokens,
    });

    logger.info("[mcp:team_skill_use] agent imported", {
      teamId: input.teamId, agentId: input.id, targetProjectId: input.targetProjectId,
      userId: ctx.userId, clientId: ctx.clientId, requestId: ctx.requestId,
    });

    return { success: true, kind: "agent", name: sourceAgent.name, enabled: false };
  },
};
