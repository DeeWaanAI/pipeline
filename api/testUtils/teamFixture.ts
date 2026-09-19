// Shared fixture helper for TeamSync integration tests.
// Uses raw SQL via mysql2 to avoid schema-vs-DB mismatches (e.g. pending migrations).
// Creates users + team + projects; returns tRPC callers per user.
// Cleans up afterAll (delete team cascades members/projects; then delete users).

import mysql from "mysql2/promise";
import { appRouter } from "../router";
import type { User } from "@db/schema";

const PREFIX = `test-team-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

function getConn() {
  return mysql.createConnection({ uri: process.env.DATABASE_URL! });
}

export interface TeamFixture {
  owner: User;
  admin: User;
  member: User;
  outsider: User;
  teamId: number;
  sharedProjectId: number;
  unsharedProjectId: number;
  /** tRPC caller authenticated as the given user */
  callerAs(user: User): ReturnType<typeof appRouter.createCaller>;
}

export async function createTeamFixture(): Promise<TeamFixture> {
  const conn = await getConn();

  // Create users
  const [ownerRes] = await conn.query(
    "INSERT INTO users (username, name, password_hash) VALUES (?, ?, ?)",
    [`${PREFIX}-owner`, "Owner", "x"],
  );
  const ownerId = Number((ownerRes as mysql.OkPacket).insertId);

  const [adminRes] = await conn.query(
    "INSERT INTO users (username, name, password_hash) VALUES (?, ?, ?)",
    [`${PREFIX}-admin`, "Admin", "x"],
  );
  const adminId = Number((adminRes as mysql.OkPacket).insertId);

  const [memberRes] = await conn.query(
    "INSERT INTO users (username, name, password_hash) VALUES (?, ?, ?)",
    [`${PREFIX}-member`, "Member", "x"],
  );
  const memberId = Number((memberRes as mysql.OkPacket).insertId);

  const [outsiderRes] = await conn.query(
    "INSERT INTO users (username, name, password_hash) VALUES (?, ?, ?)",
    [`${PREFIX}-outsider`, "Outsider", "x"],
  );
  const outsiderId = Number((outsiderRes as mysql.OkPacket).insertId);

  // Fetch full user rows for caller context
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    "SELECT * FROM users WHERE username LIKE ?",
    [`${PREFIX}-%`],
  );

  const owner = rows.find((r) => r.username === `${PREFIX}-owner`) as unknown as User;
  const admin = rows.find((r) => r.username === `${PREFIX}-admin`) as unknown as User;
  const member = rows.find((r) => r.username === `${PREFIX}-member`) as unknown as User;
  const outsider = rows.find((r) => r.username === `${PREFIX}-outsider`) as unknown as User;

  // Owner creates team
  const [teamRes] = await conn.query(
    "INSERT INTO teams (name, owner_id, invite_code) VALUES (?, ?, ?)",
    [`${PREFIX}-team`, owner.id, `INVITE${Date.now()}`],
  );
  const teamId = Number((teamRes as mysql.OkPacket).insertId);

  // memberships + seat
  await conn.query(
    "INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')",
    [teamId, owner.id],
  );
  await conn.query(
    "INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'admin')",
    [teamId, admin.id],
  );
  await conn.query(
    "INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'tester')",
    [teamId, member.id],
  );
  await conn.query(
    "INSERT INTO team_seats (team_id, seats) VALUES (?, 1)",
    [teamId],
  );

  // Owner creates a project and shares it
  const [sharedProjRes] = await conn.query(
    "INSERT INTO projects (user_id, name) VALUES (?, ?)",
    [owner.id, `${PREFIX}-shared-project`],
  );
  const sharedProjectId = Number((sharedProjRes as mysql.OkPacket).insertId);

  await conn.query(
    "INSERT INTO team_projects (team_id, project_id, added_by) VALUES (?, ?, ?)",
    [teamId, sharedProjectId, owner.id],
  );

  // Outsider creates a project NOT shared
  const [unsharedProjRes] = await conn.query(
    "INSERT INTO projects (user_id, name) VALUES (?, ?)",
    [outsider.id, `${PREFIX}-unshared-project`],
  );
  const unsharedProjectId = Number((unsharedProjRes as mysql.OkPacket).insertId);

  await conn.end();

  const callerAs = (user: User) =>
    appRouter.createCaller({
      req: new Request("http://localhost"),
      resHeaders: new Headers(),
      user,
      requestId: `test-${user.id}`,
    });

  return {
    owner,
    admin,
    member,
    outsider,
    teamId,
    sharedProjectId,
    unsharedProjectId,
    callerAs,
  };
}

export async function cleanupTeamFixture(fixture: TeamFixture) {
  const conn = await getConn();
  await conn.query("DELETE FROM team_members WHERE team_id = ?", [fixture.teamId]);
  await conn.query("DELETE FROM team_projects WHERE team_id = ?", [fixture.teamId]);
  await conn.query("DELETE FROM team_seats WHERE team_id = ?", [fixture.teamId]);
  await conn.query("DELETE FROM teams WHERE id = ?", [fixture.teamId]);
  await conn.query("DELETE FROM projects WHERE id IN (?, ?)", [fixture.sharedProjectId, fixture.unsharedProjectId]);
  for (const u of [fixture.owner, fixture.admin, fixture.member, fixture.outsider]) {
    await conn.query("DELETE FROM users WHERE id = ?", [u.id]);
  }
  await conn.end();
}
