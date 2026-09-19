/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TEAM ROUTER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Team management: create, invite, join, manage members, shared projects.
 */

import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { teams, teamMembers, teamProjects, teamSeats, users, projects, pipelineSteps, customAgents } from "@db/schema";
import { eq, and, sql, inArray, asc } from "drizzle-orm";
import { syncTeamSeatQuantity, cancelTeamSeatSubscription } from "../services/billingService";

export function generateInviteCode(): string {
  return Array.from({ length: 16 }, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
      Math.floor(Math.random() * 62),
    ),
  ).join("");
}


export const teamRouter = createRouter({
  /**
   * Create a new team.
   */
  create: authedQuery
    .input(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const inviteCode = generateInviteCode();

      // Wrap team insert + owner membership in a transaction for atomicity
      let teamId: number;
      await db.transaction(async (tx) => {
        const [team] = await tx.insert(teams).values({
          name: input.name,
          description: input.description || null,
          ownerId: ctx.user.id,
          inviteCode,
        });

        teamId = team.insertId;

        // Owner joins as owner
        await tx.insert(teamMembers).values({
          teamId: team.insertId,
          userId: ctx.user.id,
          role: "owner",
        });

        // Seat-billing baseline: 1 seat (owner), no Stripe refs yet (Phase 2)
        await tx.insert(teamSeats).values({
          teamId: team.insertId,
          seats: 1,
        });
      });

      return { id: teamId!, name: input.name, inviteCode };
    }),

  /**
   * Join a team by invite code.
   */
  joinByCode: authedQuery
    .input(z.object({ inviteCode: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      const [team] = await db
        .select()
        .from(teams)
        .where(eq(teams.inviteCode, input.inviteCode))
        .limit(1);

      if (!team) throw new Error("Invalid invite code");

      // Check not already a member
      const [existing] = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, team.id),
            eq(teamMembers.userId, ctx.user.id),
          ),
        )
        .limit(1);

      if (existing) throw new Error("Already a member of this team");

      // Tolerate race-condition duplicates (P0-4: unique index)
      try {
        await db.insert(teamMembers).values({
          teamId: team.id,
          userId: ctx.user.id,
          role: "tester",
        });
      } catch (err: any) {
        if (err.cause?.code === 'ER_DUP_ENTRY' || err.code === 'ER_DUP_ENTRY' || err.message?.includes("Duplicate entry") || err.sqlMessage?.includes("Duplicate entry")) {
          throw new Error("Already a member of this team");
        }
        throw err;
      }

      // Seat count changed — reconcile billing (Phase 2; never throws on Stripe errors)
      await syncTeamSeatQuantity(team.id);

      return { teamId: team.id, name: team.name, role: "tester" };
    }),

  /**
   * Get teams the user is a member of.
   */
  listMyTeams: authedQuery.query(async ({ ctx }) => {
    const db = getDb();

    const memberships = await db
      .select({
        teamId: teamMembers.teamId,
        role: teamMembers.role,
        joinedAt: teamMembers.joinedAt,
      })
      .from(teamMembers)
      .where(eq(teamMembers.userId, ctx.user.id));

    if (memberships.length === 0) return [];

    const teamIds = memberships.map((m) => m.teamId);
    const teamList = await db
      .select()
      .from(teams)
      .where(inArray(teams.id, teamIds));

    // Get member counts
    const counts = await db
      .select({
        teamId: teamMembers.teamId,
        count: sql<number>`COUNT(*)`,
      })
      .from(teamMembers)
      .where(inArray(teamMembers.teamId, teamIds))
      .groupBy(teamMembers.teamId);

    const countMap = new Map(counts.map((c) => [c.teamId, c.count]));

    return teamList.map((t) => ({
      ...t,
      myRole: memberships.find((m) => m.teamId === t.id)?.role || "tester",
      memberCount: countMap.get(t.id) || 0,
    }));
  }),

  /**
   * Get team details + members.
   */
  getTeam: authedQuery
    .input(z.object({ teamId: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();

      // Verify membership
      const [membership] = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, input.teamId),
            eq(teamMembers.userId, ctx.user.id),
          ),
        )
        .limit(1);

      if (!membership) throw new Error("Not a member of this team");

      const [team] = await db
        .select()
        .from(teams)
        .where(eq(teams.id, input.teamId))
        .limit(1);

      if (!team) throw new Error("Team not found");

      // Get members with user info
      const members = await db
        .select({
          id: teamMembers.id,
          userId: teamMembers.userId,
          role: teamMembers.role,
          joinedAt: teamMembers.joinedAt,
          lastActiveAt: teamMembers.lastActiveAt,
          engagementScore: teamMembers.engagementScore,
          username: users.username,
          name: users.name,
          avatar: users.avatar,
        })
        .from(teamMembers)
        .leftJoin(users, eq(teamMembers.userId, users.id))
        .where(eq(teamMembers.teamId, input.teamId));

      // Get shared projects
      const shared = await db
        .select({
          id: teamProjects.id,
          projectId: teamProjects.projectId,
          addedAt: teamProjects.addedAt,
          projectName: projects.name,
        })
        .from(teamProjects)
        .leftJoin(projects, eq(teamProjects.projectId, projects.id))
        .where(eq(teamProjects.teamId, input.teamId));

      return { team, members, sharedProjects: shared, myRole: membership.role };
    }),

  /**
   * Update member role (admin+ only).
   */
  updateMemberRole: authedQuery
    .input(
      z.object({
        teamId: z.number(),
        userId: z.number(),
        role: z.enum(["admin", "tester", "viewer"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      // Verify admin+权限
      const [myMembership] = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, input.teamId),
            eq(teamMembers.userId, ctx.user.id),
          ),
        )
        .limit(1);

      if (!myMembership || !["owner", "admin"].includes(myMembership.role)) {
        throw new Error("Only owners and admins can update roles");
      }

      // P0-3: cannot change the owner's role
      const [targetMember] = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, input.teamId),
            eq(teamMembers.userId, input.userId),
          ),
        )
        .limit(1);

      if (targetMember?.role === "owner") {
        throw new Error("Cannot change the team owner's role");
      }

      await db
        .update(teamMembers)
        .set({ role: input.role })
        .where(
          and(
            eq(teamMembers.teamId, input.teamId),
            eq(teamMembers.userId, input.userId),
          ),
        );

      return { success: true };
    }),

  /**
   * Remove member (admin+ or self).
   */
  removeMember: authedQuery
    .input(
      z.object({
        teamId: z.number(),
        userId: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      // Can remove self, or admin+ can remove others
      if (input.userId !== ctx.user.id) {
        const [myMembership] = await db
          .select()
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, input.teamId),
              eq(teamMembers.userId, ctx.user.id),
            ),
          )
          .limit(1);

        if (!myMembership || !["owner", "admin"].includes(myMembership.role)) {
          throw new Error("Only owners and admins can remove members");
        }
      }

      // Can't remove owner
      const [target] = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, input.teamId),
            eq(teamMembers.userId, input.userId),
          ),
        )
        .limit(1);

      if (target?.role === "owner") throw new Error("Cannot remove team owner");

      await db
        .delete(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, input.teamId),
            eq(teamMembers.userId, input.userId),
          ),
        );

      // Seat count changed — reconcile billing (Phase 2; never throws on Stripe errors).
      // MCP team access for the removed member is inherently revoked: membership is
      // resolved per call, so access ends within one token TTL.
      await syncTeamSeatQuantity(input.teamId);

      return { success: true };
    }),

  /**
   * Share a project with the team.
   */
  shareProject: authedQuery
    .input(
      z.object({
        teamId: z.number(),
        projectId: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      // Verify admin+
      const [membership] = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, input.teamId),
            eq(teamMembers.userId, ctx.user.id),
          ),
        )
        .limit(1);

      if (!membership || !["owner", "admin"].includes(membership.role)) {
        throw new Error("Only owners and admins can share projects");
      }

      // Verify project ownership
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);

      if (!project) throw new Error("Project not found");
      if (project.userId !== ctx.user.id) throw new Error("Only the project owner can share it");

      // Tolerate duplicate share attempts (P0-4: unique index may throw)
      try {
        await db.insert(teamProjects).values({
          teamId: input.teamId,
          projectId: input.projectId,
          addedBy: ctx.user.id,
        });
      } catch (err: any) {
        if (err.cause?.code === 'ER_DUP_ENTRY' || err.code === 'ER_DUP_ENTRY' || err.message?.includes("Duplicate entry") || err.sqlMessage?.includes("Duplicate entry")) {
          return { success: true };
        }
        throw err;
      }

      return { success: true };
    }),

  /**
   * Unshare a project.
   */
  unshareProject: authedQuery
    .input(
      z.object({
        teamId: z.number(),
        projectId: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      const [membership] = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, input.teamId),
            eq(teamMembers.userId, ctx.user.id),
          ),
        )
        .limit(1);

      if (!membership || !["owner", "admin"].includes(membership.role)) {
        throw new Error("Only owners and admins can unshare projects");
      }

      await db
        .delete(teamProjects)
        .where(
          and(
            eq(teamProjects.teamId, input.teamId),
            eq(teamProjects.projectId, input.projectId),
          ),
        );

      return { success: true };
    }),

  /**
   * Delete team (owner only).
   */
  delete: authedQuery
    .input(z.object({ teamId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      const [team] = await db
        .select()
        .from(teams)
        .where(eq(teams.id, input.teamId))
        .limit(1);

      if (!team) throw new Error("Team not found");
      if (team.ownerId !== ctx.user.id) throw new Error("Only owner can delete");

      // Best-effort cancel of the seat subscription before deleting
      // (Phase 2; team_seats row itself cascades with the team).
      await cancelTeamSeatSubscription(input.teamId);

      await db.delete(teams).where(eq(teams.id, input.teamId));
      return { success: true };
    }),

  /**
   * Get shared pipelines from all shared projects in a team.
   */
  getSharedPipelines: authedQuery
    .input(z.object({ teamId: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();

      // Verify membership
      const [membership] = await db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, input.teamId), eq(teamMembers.userId, ctx.user.id)))
        .limit(1);
      if (!membership) throw new Error("Not a member");

      // Get shared project IDs
      const shared = await db
        .select({ projectId: teamProjects.projectId })
        .from(teamProjects)
        .where(eq(teamProjects.teamId, input.teamId));
      const projectIds = shared.map((s) => s.projectId);
      if (projectIds.length === 0) return [];

      // Get pipelines with project names
      const steps = await db
        .select({
          id: pipelineSteps.id,
          projectId: pipelineSteps.projectId,
          stepOrder: pipelineSteps.stepOrder,
          name: pipelineSteps.name,
          role: pipelineSteps.role,
          systemPrompt: pipelineSteps.systemPrompt,
          isEnabled: pipelineSteps.isEnabled,
          stepType: pipelineSteps.stepType,
          model: pipelineSteps.model,
        })
        .from(pipelineSteps)
        .where(inArray(pipelineSteps.projectId, projectIds))
        .orderBy(asc(pipelineSteps.stepOrder));

      // Get project names
      const projectList = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(inArray(projects.id, projectIds));
      const nameMap = new Map(projectList.map((p) => [p.id, p.name]));

      return steps.map((s) => ({
        ...s,
        projectName: nameMap.get(s.projectId) || `Project #${s.projectId}`,
      }));
    }),

  /**
   * Get shared custom agents from all team members.
   */
  getSharedAgents: authedQuery
    .input(z.object({ teamId: z.number() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();

      const [membership] = await db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, input.teamId), eq(teamMembers.userId, ctx.user.id)))
        .limit(1);
      if (!membership) throw new Error("Not a member");

      // Get all team member user IDs
      const members = await db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, input.teamId));
      const memberIds = members.map((m) => m.userId);

      // Get agents from team members (excluding self)
      const otherIds = memberIds.filter((id) => id !== ctx.user.id);
      if (otherIds.length === 0) return [];

      const agents = await db
        .select({
          id: customAgents.id,
          userId: customAgents.userId,
          name: customAgents.name,
          slug: customAgents.slug,
          description: customAgents.description,
          systemPrompt: customAgents.systemPrompt,
          defaultModel: customAgents.defaultModel,
          role: customAgents.role,
          isTemplate: customAgents.isTemplate,
        })
        .from(customAgents)
        .where(inArray(customAgents.userId, otherIds));

      // Get usernames
      const agentUsers = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, otherIds));
      const userMap = new Map(agentUsers.map((u) => [u.id, u.username]));

      return agents.map((a) => ({
        ...a,
        ownerName: userMap.get(a.userId) || `User #${a.userId}`,
      }));
    }),

  /**
   * Import a shared pipeline step into your own project.
   */
  importPipeline: authedQuery
    .input(z.object({
      teamId: z.number(),
      stepId: z.number(),
      targetProjectId: z.number(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      // Verify team membership
      const [membership] = await db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, input.teamId), eq(teamMembers.userId, ctx.user.id)))
        .limit(1);
      if (!membership) throw new Error("Not a team member");

      // Verify target project ownership
      const [targetProject] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.targetProjectId), eq(projects.userId, ctx.user.id)))
        .limit(1);
      if (!targetProject) throw new Error("Target project not found");

      // Get the source step and verify it belongs to a team-shared project (P0-2)
      const [sourceStep] = await db
        .select()
        .from(pipelineSteps)
        .where(eq(pipelineSteps.id, input.stepId))
        .limit(1);
      if (!sourceStep) throw new Error("Pipeline step not found");

      const [shared] = await db
        .select()
        .from(teamProjects)
        .where(
          and(
            eq(teamProjects.teamId, input.teamId),
            eq(teamProjects.projectId, sourceStep.projectId),
          ),
        )
        .limit(1);
      if (!shared) throw new Error("Source project is not shared with this team");

      // Get next step order
      const existingSteps = await db
        .select({ stepOrder: pipelineSteps.stepOrder })
        .from(pipelineSteps)
        .where(eq(pipelineSteps.projectId, input.targetProjectId));
      const nextOrder = existingSteps.length > 0
        ? Math.max(...existingSteps.map((s) => s.stepOrder)) + 1
        : 1;

      // Insert copy
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

      return { success: true, name: sourceStep.name };
    }),

  /**
   * Import a shared custom agent into your own project.
   */
  importAgent: authedQuery
    .input(z.object({
      teamId: z.number(),
      agentId: z.number(),
      targetProjectId: z.number(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();

      const [membership] = await db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, input.teamId), eq(teamMembers.userId, ctx.user.id)))
        .limit(1);
      if (!membership) throw new Error("Not a team member");

      const [targetProject] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.targetProjectId), eq(projects.userId, ctx.user.id)))
        .limit(1);
      if (!targetProject) throw new Error("Target project not found");

      const [sourceAgent] = await db
        .select()
        .from(customAgents)
        .where(eq(customAgents.id, input.agentId))
        .limit(1);
      if (!sourceAgent) throw new Error("Agent not found");

      // P0-2: verify the agent belongs to a team member (shared context)
      const [sourceMembership] = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, input.teamId),
            eq(teamMembers.userId, sourceAgent.userId),
          ),
        )
        .limit(1);
      if (!sourceMembership) throw new Error("Source agent owner is not a member of this team");

      // Check for slug collision
      const [existing] = await db
        .select()
        .from(customAgents)
        .where(and(
          eq(customAgents.userId, ctx.user.id),
          eq(customAgents.slug, sourceAgent.slug),
        ))
        .limit(1);

      const slug = existing ? `${sourceAgent.slug}-imported` : sourceAgent.slug;

      await db.insert(customAgents).values({
        userId: ctx.user.id,
        name: `${sourceAgent.name} (imported)`,
        slug,
        role: sourceAgent.role,
        description: sourceAgent.description,
        systemPrompt: sourceAgent.systemPrompt,
        defaultModel: sourceAgent.defaultModel,
        temperature: sourceAgent.temperature,
        maxTokens: sourceAgent.maxTokens,
      });

      return { success: true, name: sourceAgent.name };
    }),
});
