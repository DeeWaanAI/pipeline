// MCP pipeline-authoring tools smoke (create/get/update/design + tier gates).
//   DATABASE_URL=... APP_SECRET=... PORT=8899 node scripts/smoke-mcp-authoring.mjs
// Requires the app server running on PORT and a migrated database.
// Creates two throwaway users (standard + pro_designer), exercises the tools
// over the real MCP streamable-HTTP transport, then removes all fixtures.
import { createHash } from "crypto";
import { SignJWT } from "jose";
import mysql from "mysql2/promise";
import fs from "fs";

const envText = fs.existsSync(new URL("../.env", import.meta.url))
  ? fs.readFileSync(new URL("../.env", import.meta.url), "utf8")
  : "";
const fromEnvFile = (k) => (envText.match(new RegExp(`^${k}=["']?([^"'\\n]+)`, "m")) || [])[1] || "";
const DATABASE_URL = process.env.DATABASE_URL || fromEnvFile("DATABASE_URL");
const APP_SECRET = process.env.APP_SECRET || fromEnvFile("APP_SECRET");
const PORT = process.env.PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;

if (!DATABASE_URL || !APP_SECRET) {
  console.error("DATABASE_URL and APP_SECRET are required");
  process.exit(2);
}

const conn = await mysql.createConnection({ uri: DATABASE_URL });
const fails = [];
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) fails.push(name);
};

function mintMcpToken(userId) {
  const key = createHash("sha256").update(APP_SECRET).digest();
  return new SignJWT({ scope: "mcp:read mcp:run mcp:write", client_id: "smoke-authoring" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(String(userId))
    .setIssuer("deewaanai").setIssuedAt().setExpirationTime("600s").sign(key);
}

async function rpc(token, session, method, params) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (session) headers["mcp-session-id"] = session;
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const sid = res.headers.get("mcp-session-id") || session;
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch {
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    if (data.length) { try { payload = JSON.parse(data[data.length - 1]); } catch { /* leave null */ } }
  }
  return { status: res.status, session: sid, payload };
}

async function initSession(token) {
  const r = await rpc(token, null, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke-authoring", version: "0" },
  });
  return r.session;
}

function toolResult(r) {
  // MCP tool result: { result: { content: [{ type: "text", text }], isError? } } or { error }
  if (r.payload?.error) return { error: r.payload.error.message ?? JSON.stringify(r.payload.error) };
  const content = r.payload?.result?.content;
  const text = Array.isArray(content) ? content.find((c) => c.type === "text")?.text : null;
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  const isError = Boolean(r.payload?.result?.isError);
  return { error: isError ? (typeof data === "string" ? data : JSON.stringify(data)) : null, data };
}

const ts = Date.now();
const projectIds = [];
let userAId, userBId;

try {
  // ─── Fixtures: standard user A, pro_designer user B ───
  const [ra] = await conn.query(
    `INSERT INTO users (username, password_hash, tier) VALUES (?, 'smoke', 'standard')`,
    [`mcp-smoke-a-${ts}`],
  );
  userAId = ra.insertId;
  const [rb] = await conn.query(
    `INSERT INTO users (username, password_hash, tier) VALUES (?, 'smoke', 'pro_designer')`,
    [`mcp-smoke-b-${ts}`],
  );
  userBId = rb.insertId;
  const tokenA = await mintMcpToken(userAId);
  const tokenB = await mintMcpToken(userBId);
  const sessA = await initSession(tokenA);
  const sessB = await initSession(tokenB);

  // ─── tools/list shows the authoring tools ───
  const list = await rpc(tokenA, sessA, "tools/list", {});
  const names = (list.payload?.result?.tools ?? []).map((t) => t.name);
  for (const t of ["get_pipeline", "create_pipeline", "update_pipeline", "design_pipeline"]) {
    check(`tools/list includes ${t}`, names.includes(t));
  }

  // ─── A (standard): sequential create works ───
  const createSeq = toolResult(await rpc(tokenA, sessA, "tools/call", {
    name: "create_pipeline",
    arguments: {
      name: `smoke-seq-${ts}`,
      description: "sequential chain",
      steps: [
        { name: "Builder", role: "builder", systemPrompt: "Draft it." },
        { name: "Polisher", role: "polisher", systemPrompt: "Polish it." },
      ],
    },
  }));
  check("standard: create sequential pipeline", !createSeq.error && createSeq.data?.id > 0,
    createSeq.error ?? `id=${createSeq.data?.id} steps=${createSeq.data?.stepCount}`);
  if (createSeq.data?.id) projectIds.push(createSeq.data.id);

  // Verify template and agents were created for the sequential pipeline
  if (createSeq.data?.id) {
    const [templateCheck] = await conn.query(
      `SELECT id, name FROM pipeline_templates WHERE source_project_id = ?`,
      [createSeq.data.id]
    );
    check("create_pipeline: pipelineTemplate created", templateCheck.length === 1,
      `templates=${templateCheck.length}`);

    const [agentCheck] = await conn.query(
      `SELECT COUNT(*) as n FROM custom_agents WHERE user_id = ?`,
      [userAId]
    );
    check("create_pipeline: customAgents created", agentCheck[0].n >= 2,
      `agents=${agentCheck[0].n}`);

    const [stepCheck] = await conn.query(
      `SELECT COUNT(*) as n FROM pipeline_steps WHERE project_id = ? AND agent_id IS NOT NULL`,
      [createSeq.data.id]
    );
    check("create_pipeline: steps linked to agents", stepCheck[0].n === 2,
      `linked=${stepCheck[0].n}`);
  }

  // ─── A (standard): IF step rejected by tier gate ───
  const createIf = toolResult(await rpc(tokenA, sessA, "tools/call", {
    name: "create_pipeline",
    arguments: {
      name: `smoke-if-${ts}`,
      steps: [
        { name: "Builder", role: "builder", systemPrompt: "Draft it." },
        { name: "Gate", role: "critic", systemPrompt: "Judge.", stepType: "if",
          ifConfig: { options: ["pass", "revise"], mappings: { pass: 1, revise: 1 } } },
      ],
    },
  }));
  check("standard: IF step blocked with upgrade message",
    !!createIf.error && /custom-pipeline tier/.test(createIf.error),
    createIf.error?.slice(0, 90));

  // ─── A (standard): design_pipeline blocked by autodesign gate ───
  const designDenied = toolResult(await rpc(tokenA, sessA, "tools/call", {
    name: "design_pipeline",
    arguments: { name: `smoke-design-${ts}`, task: "Write and review a blog post" },
  }));
  check("standard: design_pipeline blocked with upgrade message",
    !!designDenied.error && /auto-design tier/.test(designDenied.error),
    designDenied.error?.slice(0, 90));
  // cleanup any project the denied call may have created before the gate ran
  const [stray] = await conn.query(`SELECT id FROM projects WHERE user_id = ?`, [userAId]);
  for (const row of stray) if (!projectIds.includes(row.id)) projectIds.push(row.id);

  // ─── B (pro_designer): IF + WHILE chain accepted ───
  const createCf = toolResult(await rpc(tokenB, sessB, "tools/call", {
    name: "create_pipeline",
    arguments: {
      name: `smoke-cf-${ts}`,
      pipelineConfig: { maxIterations: 5, stopOnNoImprovement: true },
      steps: [
        { name: "Builder", role: "builder", systemPrompt: "Draft it." },
        { name: "Loop", role: "critic", systemPrompt: "Improve until good.", stepType: "while",
          whileConfig: { targetStep: 1, maxIterations: 3 } },
        { name: "Gate", role: "critic", systemPrompt: "Judge.", stepType: "if",
          ifConfig: { options: ["pass", "revise"], mappings: { pass: 4, revise: 1 } } },
        { name: "Human", stepType: "approval" },
      ],
    },
  }));
  check("pro_designer: IF+WHILE+approval chain created",
    !createCf.error && createCf.data?.stepCount === 4 && createCf.data?.controlFlow === true,
    createCf.error ?? `id=${createCf.data?.id}`);
  const cfId = createCf.data?.id;
  if (cfId) projectIds.push(cfId);

  // ─── B: get_pipeline round-trips the steps ───
  if (cfId) {
    const got = toolResult(await rpc(tokenB, sessB, "tools/call", {
      name: "get_pipeline", arguments: { id: cfId },
    }));
    const types = got.data?.steps?.map((s) => s.stepType).join(",") ?? "";
    check("get_pipeline returns ordered steps with configs",
      !got.error && got.data?.stepCount === 4 && types === "agent,while,if,approval"
        && got.data?.pipelineConfig?.maxIterations === 5,
      got.error ?? types);

    // ─── B: update_pipeline renames + replaces steps ───
    const upd = toolResult(await rpc(tokenB, sessB, "tools/call", {
      name: "update_pipeline",
      arguments: {
        id: cfId, name: `smoke-cf-renamed-${ts}`,
        steps: [{ name: "Only", role: "builder", systemPrompt: "Do everything." }],
      },
    }));
    check("update_pipeline renames + replaces steps",
      !upd.error && upd.data?.stepCount === 1 && upd.data?.updated?.includes("name"),
      upd.error ?? JSON.stringify(upd.data).slice(0, 90));

    const got2 = toolResult(await rpc(tokenB, sessB, "tools/call", {
      name: "get_pipeline", arguments: { id: cfId },
    }));
    check("get_pipeline reflects replacement",
      !got2.error && got2.data?.name?.includes("renamed") && got2.data?.stepCount === 1,
      got2.error ?? `${got2.data?.name} steps=${got2.data?.stepCount}`);
  }

  // ─── A cannot touch B's project (non-leaky) ───
  if (cfId) {
    const foreign = toolResult(await rpc(tokenA, sessA, "tools/call", {
      name: "update_pipeline", arguments: { id: cfId, name: "hijack" },
    }));
    check("cross-user update blocked (Project not found)",
      !!foreign.error && /Project not found/.test(foreign.error), foreign.error?.slice(0, 60));
  }
} finally {
  // ─── Cleanup fixtures ───
  for (const pid of projectIds) {
    await conn.query(`DELETE FROM pipeline_steps WHERE project_id = ?`, [pid]);
    await conn.query(`DELETE FROM projects WHERE id = ?`, [pid]);
  }
  if (userAId) await conn.query(`DELETE FROM users WHERE id = ?`, [userAId]);
  if (userBId) await conn.query(`DELETE FROM users WHERE id = ?`, [userBId]);
  await conn.end();
}

console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
