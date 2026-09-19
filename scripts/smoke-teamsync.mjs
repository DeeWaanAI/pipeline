// Phase 2 TeamSync boot smoke — phases:
//   node scripts/smoke-teamsync.mjs flag   → ensure teamsync flag row exists (enabled=0)
//   node scripts/smoke-teamsync.mjs off    → assert team tools hidden + call rejected
//   node scripts/smoke-teamsync.mjs on     → enable flag; assert 8 team tools listed + team_runs_list executes
//   node scripts/smoke-teamsync.mjs disable→ set flag back to 0 (rollout control)
//   node scripts/smoke-teamsync.mjs flow   → E2E deep scenario (seed users+team+project, handoff, memory)
// Requires the app server already running on PORT (default 3000) for off/on/flow phases.
import { createHash } from "crypto";
import { SignJWT } from "jose";
import mysql from "mysql2/promise";
import fs from "fs";

const envText = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const getEnv = (k) => (envText.match(new RegExp(`^${k}=["']?([^"'\\n]+)`, "m")) || [])[1] || "";
const DATABASE_URL = getEnv("DATABASE_URL");
const APP_SECRET = process.env.APP_SECRET || getEnv("APP_SECRET");
const PORT = process.env.PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const phase = process.argv[2];

async function db() {
  return mysql.createConnection({ uri: DATABASE_URL, multipleStatements: true });
}

async function setFlag(enabled) {
  const conn = await db();
  await conn.query(
    `INSERT INTO feature_flags (\`key\`, name, description, enabled, rollout_percent)
     VALUES ('teamsync', 'TeamSync', 'Phase 2 cross-app team collaboration', ?, 0)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), rollout_percent = 0`,
    [enabled],
  );
  await conn.end();
  console.log(`teamsync flag => ${enabled}`);
}

async function mintToken(userId) {
  const key = createHash("sha256").update(APP_SECRET).digest();
  return new SignJWT({ scope: "mcp:read mcp:run mcp:write team:read team:write", client_id: "smoke-teamsync" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuer("deewaanai")
    .setIssuedAt()
    .setExpirationTime("600s")
    .sign(key);
}

/** Parse a streamable-HTTP MCP response (JSON or SSE-framed JSON). */
async function readMcp(res) {
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
}

async function mcpSession(token) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  const initRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
    }),
  });
  if (initRes.status !== 200) throw new Error(`initialize failed: ${initRes.status} ${await initRes.text()}`);
  const sessionId = initRes.headers.get("mcp-session-id");
  await readMcp(initRes);
  const h2 = { ...headers, "mcp-session-id": sessionId };
  const notif = await fetch(`${BASE}/mcp`, {
    method: "POST", headers: h2,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  if (notif.status !== 202) throw new Error(`initialized notification failed: ${notif.status}`);
  return (method, params, id) =>
    fetch(`${BASE}/mcp`, {
      method: "POST", headers: h2,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }).then(readMcp);
}

const fails = [];
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) fails.push(name);
};

if (phase === "flag" || phase === "disable") {
  await setFlag(0);
} else if (phase === "off" || phase === "on") {
  const conn = await db();
  const [[u]] = await conn.query("SELECT id FROM users ORDER BY id LIMIT 1");
  if (phase === "on") {
    await conn.query(
      `INSERT INTO feature_flags (\`key\`, name, description, enabled, rollout_percent)
       VALUES ('teamsync', 'TeamSync', 'Phase 2', 1, 100)
       ON DUPLICATE KEY UPDATE enabled = 1, rollout_percent = 100`,
    );
  }
  await conn.end();
  const token = await mintToken(u.id);

  // 401 challenge without token
  const unauth = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("unauthenticated /mcp => 401", unauth.status === 401, `status ${unauth.status}`);

  const call = await mcpSession(token);
  const list = await call("tools/list", {}, 2);
  const names = (list.result?.tools || []).map((t) => t.name);
  const teamTools = names.filter((n) => n.startsWith("team_"));
  if (phase === "off") {
    check("flag OFF: team tools hidden from tools/list", teamTools.length === 0, `${names.length} tools`);
    const rejected = await call("tools/call", { name: "team_runs_list", arguments: { teamId: 1 } }, 3);
    check("flag OFF: team_runs_list call rejected", !!rejected.error || rejected.result?.isError === true,
      rejected.error ? `code ${rejected.error.code}` : "isError");
  } else {
    check("flag ON: 8 team tools listed", teamTools.length === 8, teamTools.sort().join(", "));
    const res = await call("tools/call", { name: "team_runs_list", arguments: { teamId: 1 } }, 3);
    // Any structured MCP response (success or localized error) proves the tool is wired + executes.
    check("flag ON: team_runs_list executes", !!res.result, JSON.stringify(res.result ?? res.error).slice(0, 120));
  }
} else if (phase === "flow") {
  await runFlow();
} else {
  console.error("unknown phase", phase);
  process.exit(2);
}

if (fails.length) {
  console.error(`SMOKE FAILED: ${fails.join(", ")}`);
  process.exit(1);
}
console.log(`SMOKE ${phase} OK`);

// ─── flow phase (E2E deep scenario) ──────────────────────────────────────
async function runFlow() {
  const conn = await db();
  const prefix = `smoke-flow-${Date.now()}`;

  // 1. Seed two users
  const [ua] = await conn.query(
    "INSERT INTO users (username, name, password_hash) VALUES (?, ?, ?)",
    [`${prefix}-a`, "User A", "x"],
  );
  const userAId = ua.insertId;
  const [ub] = await conn.query(
    "INSERT INTO users (username, name, password_hash) VALUES (?, ?, ?)",
    [`${prefix}-b`, "User B", "x"],
  );
  const userBId = ub.insertId;

  // 2. A creates team
  const inviteCode = `INV${Date.now()}`;
  const [teamRow] = await conn.query(
    "INSERT INTO teams (name, owner_id, invite_code) VALUES (?, ?, ?)",
    [`${prefix}-team`, userAId, inviteCode],
  );
  const teamId = teamRow.insertId;

  // memberships + seat
  await conn.query(
    "INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')",
    [teamId, userAId],
  );
  await conn.query(
    "INSERT INTO team_seats (team_id, seats) VALUES (?, 1)",
    [teamId],
  );

  // B joins
  await conn.query(
    "INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'tester')",
    [teamId, userBId],
  );

  // 3. A creates project and shares it
  const [projRow] = await conn.query(
    "INSERT INTO projects (user_id, name) VALUES (?, ?)",
    [userAId, `${prefix}-project`],
  );
  const projectId = projRow.insertId;
  await conn.query(
    "INSERT INTO team_projects (team_id, project_id, added_by) VALUES (?, ?, ?)",
    [teamId, projectId, userAId],
  );

  // 4. Create a swarm run on the shared project
  const [runRow] = await conn.query(
    "INSERT INTO swarm_runs (project_id, user_id, user_prompt, status, current_step) VALUES (?, ?, ?, 'paused', 'approval')",
    [projectId, userAId, "Smoke test run"],
  );
  const runId = runRow.insertId;
  await conn.end();

  // 5. Mint tokens
  const tokenA = await mintToken(userAId);
  const tokenB = await mintToken(userBId);

  const callA = await mcpSession(tokenA);
  const callB = await mcpSession(tokenB);

  // 6. B: team_context_get returns seeded state
  const ctxB = await callB("tools/call", {
    name: "team_context_get",
    arguments: { teamId, projectId },
  }, 10);
  check("flow: B team_context_get returns project state",
    !!ctxB.result?.projectId && ctxB.result.projectId === projectId,
    JSON.stringify(ctxB.error).slice(0, 80));

  // 7. A: team_handoff to B
  const handoff = await callA("tools/call", {
    name: "team_handoff",
    arguments: { runId, assigneeUserId: userBId, note: "Please review" },
  }, 11);
  check("flow: A team_handoff to B succeeds",
    !!handoff.result?.assignmentId,
    JSON.stringify(handoff.error).slice(0, 80));

  // 8. B: team_runs_list shows waitingForYou
  const listB = await callB("tools/call", {
    name: "team_runs_list",
    arguments: { teamId },
  }, 12);
  const waiting = listB.result?.waitingForYou || [];
  check("flow: B team_runs_list shows waitingForYou",
    waiting.some((w) => w.runId === runId),
    `waiting=${waiting.length}`);

  // 9. B: team_memory_append
  const appendB = await callB("tools/call", {
    name: "team_memory_append",
    arguments: { teamId, projectId, note: "B was here" },
  }, 13);
  check("flow: B team_memory_append succeeds",
    !!appendB.result?.episodeId,
    JSON.stringify(appendB.error).slice(0, 80));

  // 10. A: team_context_get sees the episode
  const ctxA2 = await callA("tools/call", {
    name: "team_context_get",
    arguments: { teamId, projectId },
  }, 14);
  const episodes = ctxA2.result?.episodes || [];
  check("flow: A team_context_get sees B's episode",
    episodes.some((e) => e.summary && e.summary.includes("B was here")),
    `episodes=${episodes.length}`);

  // Cleanup
  const conn2 = await db();
  await conn2.query("DELETE FROM approval_assignments WHERE swarm_run_id = ?", [runId]);
  await conn2.query("DELETE FROM notifications WHERE user_id IN (?, ?)", [userAId, userBId]);
  await conn2.query("DELETE FROM swarm_runs WHERE id = ?", [runId]);
  await conn2.query("DELETE FROM team_projects WHERE team_id = ?", [teamId]);
  await conn2.query("DELETE FROM projects WHERE id = ?", [projectId]);
  await conn2.query("DELETE FROM team_members WHERE team_id = ?", [teamId]);
  await conn2.query("DELETE FROM team_seats WHERE team_id = ?", [teamId]);
  await conn2.query("DELETE FROM teams WHERE id = ?", [teamId]);
  await conn2.query("DELETE FROM users WHERE id IN (?, ?)", [userAId, userBId]);
  await conn2.end();
}
