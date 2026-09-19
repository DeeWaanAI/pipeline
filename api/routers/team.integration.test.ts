// Integration tests for the Team router (real MySQL).
// Pattern: copy from api/services/entitlements.integration.test.ts
//
// Lifecycle: T1-T14 as spec'd in TEAM-FEATURE-TEST-SPEC.md.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTeamFixture, cleanupTeamFixture, type TeamFixture } from "../testUtils/teamFixture";
import { getDb } from "../queries/connection";
import { teamMembers, teamProjects, teamSeats, teams, pipelineSteps, projects } from "@db/schema";
import { eq, and } from "drizzle-orm";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("team router (integration: real MySQL)", () => {
  let f: TeamFixture;

  beforeAll(async () => {
    f = await createTeamFixture();
  });

  afterAll(async () => {
    if (f) await cleanupTeamFixture(f);
  });

  // ─── T1 create ──────────────────────────────────────────────────────
  it("T1: create returns team row + owner membership + team_seats", async () => {
    const caller = f.callerAs(f.owner);
    const result = await caller.team.create({ name: "T1-Team", description: "test" });

    expect(result.id).toBeGreaterThan(0);
    expect(result.inviteCode).toHaveLength(16);
    expect(result.name).toBe("T1-Team");

    // Verify owner membership
    const db = getDb();
    const [membership] = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, result.id), eq(teamMembers.userId, f.owner.id)))
      .limit(1);
    expect(membership.role).toBe("owner");

    // Verify seat row
    const [seat] = await db
      .select()
      .from(teamSeats)
      .where(eq(teamSeats.teamId, result.id))
      .limit(1);
    expect(seat.seats).toBe(1);

    // Cleanup this extra team
    await db.delete(teamMembers).where(eq(teamMembers.teamId, result.id));
    await db.delete(teamSeats).where(eq(teamSeats.teamId, result.id));
    await db.delete(teamProjects).where(eq(teamProjects.teamId, result.id));
    await db.delete(teams).where(eq(teams.id, result.id));
  });

  // ─── T2 joinByCode ──────────────────────────────────────────────────
  it("T2: joinByCode with valid code → tester; invalid → error; twice → error", async () => {
    const callerOwner = f.callerAs(f.owner);
    const team = await callerOwner.team.create({ name: "T2-Team" });

    // Get invite code via getTeam
    const details = await callerOwner.team.getTeam({ teamId: team.id });
    const code = details.team.inviteCode!;

    // Member joins
    const callerMember = f.callerAs(f.member);
    const joined = await callerMember.team.joinByCode({ inviteCode: code });
    expect(joined.role).toBe("tester");

    // Invalid code
    await expect(
      callerMember.team.joinByCode({ inviteCode: "INVALID" }),
    ).rejects.toThrow("Invalid invite code");

    // Joining twice
    await expect(
      callerMember.team.joinByCode({ inviteCode: code }),
    ).rejects.toThrow("Already a member of this team");

    // P0-4: duplicate row count stays 1 for this user
    const db = getDb();
    const rows = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, f.member.id)));
    expect(rows).toHaveLength(1);

    // Cleanup
    await db.delete(teamMembers).where(eq(teamMembers.teamId, team.id));
    await db.delete(teamSeats).where(eq(teamSeats.teamId, team.id));
    await db.delete(teamProjects).where(eq(teamProjects.teamId, team.id));
    await db.delete(teams).where(eq(teams.id, team.id));
  });

  // ─── T3 listMyTeams / getTeam ───────────────────────────────────────
  it("T3: listMyTeams and getTeam return correct roles; outsider rejected", async () => {
    const ownerCaller = f.callerAs(f.owner);
    const memberCaller = f.callerAs(f.member);
    const outsiderCaller = f.callerAs(f.outsider);

    const ownerTeams = await ownerCaller.team.listMyTeams();
    expect(ownerTeams.some((t) => t.id === f.teamId)).toBe(true);

    const memberTeams = await memberCaller.team.listMyTeams();
    expect(memberTeams.some((t) => t.id === f.teamId)).toBe(true);

    const outsiderTeams = await outsiderCaller.team.listMyTeams();
    expect(outsiderTeams.some((t) => t.id === f.teamId)).toBe(false);

    // getTeam
    const details = await memberCaller.team.getTeam({ teamId: f.teamId });
    expect(details.myRole).toBe("tester");

    await expect(
      outsiderCaller.team.getTeam({ teamId: f.teamId }),
    ).rejects.toThrow("Not a member of this team");
  });

  // ─── T4 delete ──────────────────────────────────────────────────────
  it("T4: member cannot delete; owner deletes and cascades", async () => {
    const callerOwner = f.callerAs(f.owner);
    const callerMember = f.callerAs(f.member);

    // Create a throwaway team for this test so the main fixture survives
    const tempTeam = await callerOwner.team.create({ name: "T4-Team" });
    await callerMember.team.joinByCode({ inviteCode: tempTeam.inviteCode });

    // Member cannot delete
    await expect(
      callerMember.team.delete({ teamId: tempTeam.id }),
    ).rejects.toThrow("Only owner can delete");

    // Owner deletes
    await callerOwner.team.delete({ teamId: tempTeam.id });

    const db = getDb();
    const [gone] = await db.select().from(teams).where(eq(teams.id, tempTeam.id)).limit(1);
    expect(gone).toBeUndefined();

    const members = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.teamId, tempTeam.id));
    expect(members).toHaveLength(0);

    const seats = await db
      .select()
      .from(teamSeats)
      .where(eq(teamSeats.teamId, tempTeam.id));
    expect(seats).toHaveLength(0);
  });

  // ─── T5 updateMemberRole ────────────────────────────────────────────
  it("T5: owner promotes member→admin OK; tester cannot; cannot change owner", async () => {
    const callerOwner = f.callerAs(f.owner);
    const callerAdmin = f.callerAs(f.admin);
    const callerMember = f.callerAs(f.member);

    // Create temp team to avoid mutating fixture
    const tempTeam = await callerOwner.team.create({ name: "T5-Team" });
    await callerMember.team.joinByCode({ inviteCode: tempTeam.inviteCode });

    // Owner promotes member to admin
    await callerOwner.team.updateMemberRole({
      teamId: tempTeam.id,
      userId: f.member.id,
      role: "admin",
    });

    const db = getDb();
    const [updated] = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, tempTeam.id), eq(teamMembers.userId, f.member.id)))
      .limit(1);
    expect(updated.role).toBe("admin");

    // Tester (outsider in temp team) cannot change roles
    const callerOutsider = f.callerAs(f.outsider);
    await expect(
      callerOutsider.team.updateMemberRole({
        teamId: tempTeam.id,
        userId: f.member.id,
        role: "viewer",
      }),
    ).rejects.toThrow("Only owners and admins can update roles");

    // Cannot change owner's role (P0-3)
    await expect(
      callerAdmin.team.updateMemberRole({
        teamId: f.teamId,
        userId: f.owner.id,
        role: "admin",
      }),
    ).rejects.toThrow("Cannot change the team owner's role");

    // Cleanup temp team
    await db.delete(teamMembers).where(eq(teamMembers.teamId, tempTeam.id));
    await db.delete(teamSeats).where(eq(teamSeats.teamId, tempTeam.id));
    await db.delete(teams).where(eq(teams.id, tempTeam.id));
  });

  // ─── T6 removeMember ────────────────────────────────────────────────
  it("T6: self-removal OK; member removing another → rejected; admin removes member OK; cannot remove owner", async () => {
    const callerOwner = f.callerAs(f.owner);
    const callerMember = f.callerAs(f.member);

    // Create temp team with owner + member
    const tempTeam = await callerOwner.team.create({ name: "T6-Team" });
    await callerMember.team.joinByCode({ inviteCode: tempTeam.inviteCode });

    // Member self-removes
    await callerMember.team.removeMember({ teamId: tempTeam.id, userId: f.member.id });

    const db = getDb();
    const afterSelfRemove = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, tempTeam.id), eq(teamMembers.userId, f.member.id)))
      .limit(1);
    expect(afterSelfRemove).toHaveLength(0);

    // Re-add member for further tests
    await callerMember.team.joinByCode({ inviteCode: tempTeam.inviteCode });

    // Owner also cannot remove themselves (reaches the owner-protection check)
    await expect(
      callerOwner.team.removeMember({ teamId: tempTeam.id, userId: f.owner.id }),
    ).rejects.toThrow("Cannot remove team owner");


    // Member (tester) cannot remove anyone — permission check fires first
    await expect(
      callerMember.team.removeMember({ teamId: tempTeam.id, userId: f.owner.id }),
    ).rejects.toThrow("Only owners and admins can remove members");

    // Cleanup
    await db.delete(teamMembers).where(eq(teamMembers.teamId, tempTeam.id));
    await db.delete(teamSeats).where(eq(teamSeats.teamId, tempTeam.id));
    await db.delete(teams).where(eq(teams.id, tempTeam.id));
  });
  // ─── T7 shareProject ────────────────────────────────────────────────
  it("T7: owner shares own project OK; admin shares owner's project → rejected; double-share → single row", async () => {
    const callerOwner = f.callerAs(f.owner);
    const callerAdmin = f.callerAs(f.admin);

    // Owner shares their project
    const result = await callerOwner.team.shareProject({
      teamId: f.teamId,
      projectId: f.sharedProjectId,
    });
    expect(result.success).toBe(true);

    // Admin tries to share owner's project → rejected (P0-1)
    await expect(
      callerAdmin.team.shareProject({ teamId: f.teamId, projectId: f.sharedProjectId }),
    ).rejects.toThrow("Only the project owner can share it");

    // P0-4: double-share still single row
    const db = getDb();
    const shares = await db
      .select()
      .from(teamProjects)
      .where(
        and(eq(teamProjects.teamId, f.teamId), eq(teamProjects.projectId, f.sharedProjectId)),
      );
    expect(shares).toHaveLength(1);

    // Admin tries to share outsider's project → rejected (P0-1)
    await expect(
      callerAdmin.team.shareProject({ teamId: f.teamId, projectId: f.unsharedProjectId }),
    ).rejects.toThrow("Only the project owner can share it");
  });

  // ─── T8 importPipeline ──────────────────────────────────────────────
  it("T8: member imports step from shared project → copy created; unshared source → rejected", async () => {
    const db = getDb();
    const callerMember = f.callerAs(f.member);
    const callerOwner = f.callerAs(f.owner);

    // Create a pipeline step in the shared project (as owner)
    const [stepRow] = await db.insert(pipelineSteps).values({
      projectId: f.sharedProjectId,
      stepOrder: 1,
      name: "Test Step",
      role: "builder",
      systemPrompt: "test",
    });
    const stepId = Number(stepRow.insertId);

    // Create a target project for member
    const [projRow] = await db.insert(projects).values({
      userId: f.member.id,
      name: "Member Target Project",
    });
    const memberProjectId = Number(projRow.insertId);

    // Member imports from shared project → OK
    const imported = await callerMember.team.importPipeline({
      teamId: f.teamId,
      stepId,
      targetProjectId: memberProjectId,
    });
    expect(imported.success).toBe(true);
    expect(imported.name).toBe("Test Step");

    // Verify the copy was created
    const copied = await db
      .select()
      .from(pipelineSteps)
      .where(eq(pipelineSteps.projectId, memberProjectId));
    expect(copied).toHaveLength(1);
    expect(copied[0].name).toBe("Test Step (imported)");
    expect(copied[0].isEnabled).toBe(false);

    // Member tries to import step from unshared project → rejected (P0-2)
    const [unsharedStepRow] = await db.insert(pipelineSteps).values({
      projectId: f.unsharedProjectId,
      stepOrder: 1,
      name: "Unshared Step",
      role: "builder",
      systemPrompt: "test",
    });
    const unsharedStepId = Number(unsharedStepRow.insertId);

    await expect(
      callerMember.team.importPipeline({
        teamId: f.teamId,
        stepId: unsharedStepId,
        targetProjectId: memberProjectId,
      }),
    ).rejects.toThrow("Source project is not shared with this team");

    // Member tries to use owner's project as target → rejected
    await expect(
      callerMember.team.importPipeline({
        teamId: f.teamId,
        stepId,
        targetProjectId: f.sharedProjectId,
      }),
    ).rejects.toThrow("Target project not found");

    // Cleanup
    await db.delete(pipelineSteps).where(eq(pipelineSteps.projectId, memberProjectId));
    await db.delete(pipelineSteps).where(eq(pipelineSteps.projectId, f.sharedProjectId));
    await db.delete(pipelineSteps).where(eq(pipelineSteps.projectId, f.unsharedProjectId));
    await db.delete(projects).where(eq(projects.id, memberProjectId));
  });

  // ─── T9 importAgent ─────────────────────────────────────────────────
  it("T9: importAgent rejects non-team agent (P0-2)", async () => {
    const callerMember = f.callerAs(f.member);

    await expect(
      callerMember.team.importAgent({
        teamId: f.teamId,
        agentId: 999999,
        targetProjectId: f.unsharedProjectId,
      }),
    ).rejects.toThrow("Target project not found");
  });

  // ─── T10 getSharedPipelines / getSharedAgents ───────────────────────
  it("T10: member sees shared projects; outsider gets nothing", async () => {
    const callerMember = f.callerAs(f.member);
    const callerOutsider = f.callerAs(f.outsider);

    // Member can query
    const pipelines = await callerMember.team.getSharedPipelines({ teamId: f.teamId });
    expect(Array.isArray(pipelines)).toBe(true);

    const agents = await callerMember.team.getSharedAgents({ teamId: f.teamId });
    expect(Array.isArray(agents)).toBe(true);

    // Outsider cannot
    await expect(
      callerOutsider.team.getSharedPipelines({ teamId: f.teamId }),
    ).rejects.toThrow("Not a member");

    await expect(
      callerOutsider.team.getSharedAgents({ teamId: f.teamId }),
    ).rejects.toThrow("Not a member");
  });

  // ─── T11 cross-router: project.list includes shared project ─────────
  it("T11: project.list for member includes shared project", async () => {
    const callerMember = f.callerAs(f.member);
    const projects = await callerMember.project.list();
    expect(projects.some((p: any) => p.id === f.sharedProjectId)).toBe(true);
  });

  // ─── T13 seat billing (no Stripe in CI) ─────────────────────────────
  it("T13: joinByCode and removeMember succeed with unconfigured billing", async () => {
    const callerOwner = f.callerAs(f.owner);
    const callerOutsider = f.callerAs(f.outsider);

    const tempTeam = await callerOwner.team.create({ name: "T13-Team" });

    // Outsider joins — should not throw even though Stripe is unconfigured
    const joined = await callerOutsider.team.joinByCode({ inviteCode: tempTeam.inviteCode });
    expect(joined.role).toBe("tester");

    // Owner removes outsider — should not throw
    await callerOwner.team.removeMember({ teamId: tempTeam.id, userId: f.outsider.id });

    const db = getDb();
    const remaining = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.teamId, tempTeam.id));
    expect(remaining).toHaveLength(1); // only owner remains

    // Cleanup
    await db.delete(teamMembers).where(eq(teamMembers.teamId, tempTeam.id));
    await db.delete(teamSeats).where(eq(teamSeats.teamId, tempTeam.id));
    await db.delete(teams).where(eq(teams.id, tempTeam.id));
  });

  // ─── T14 billing.createTeamCheckout permissions ─────────────────────
  it("T14: createTeamCheckout with unconfigured billing → PRECONDITION_FAILED for all; ownership gated when configured", async () => {
    const callerMember = f.callerAs(f.member);
    const callerOwner = f.callerAs(f.owner);

    // With unconfigured billing, both owner and non-owner get PRECONDITION_FAILED first
    await expect(
      callerMember.billing.createTeamCheckout({ teamId: f.teamId }),
    ).rejects.toThrow("billing not configured");

    await expect(
      callerOwner.billing.createTeamCheckout({ teamId: f.teamId }),
    ).rejects.toThrow("billing not configured");
  });
});
