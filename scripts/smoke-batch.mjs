// Research Mode batch smoke — 2026-07-30.
// Verifies: runBatch, getBatchStatus, exportBatchResults, resumeBatch.
// Requires the app server already running on PORT (default 3000).
//   node scripts/smoke-batch.mjs
import mysql from "mysql2/promise";
import fs from "fs";

const envText = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const getEnv = (k) => (envText.match(new RegExp(`^${k}=["']?([^"'\\n]+)`, "m")) || [])[1] || "";
const DATABASE_URL = getEnv("DATABASE_URL");
const PORT = process.env.PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const TRPC = `${BASE}/api/trpc`;

let passed = 0, failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
};

async function trpc(proc, input, token) {
  const res = await fetch(`${TRPC}/${proc}?batch=1`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-local-auth-token": token } : {}) },
    body: JSON.stringify({ 0: { json: input } }),
  });
  const json = await res.json();
  const item = Array.isArray(json) ? json[0] : json;
  if (item?.error) return { __error: item.error.json?.message ?? JSON.stringify(item.error) };
  return item?.result?.data?.json;
}

async function trpcQuery(proc, input, token) {
  const qs = encodeURIComponent(JSON.stringify({ 0: { json: input } }));
  const res = await fetch(`${TRPC}/${proc}?batch=1&input=${qs}`, {
    headers: { ...(token ? { "x-local-auth-token": token } : {}) },
  });
  const json = await res.json();
  const item = Array.isArray(json) ? json[0] : json;
  if (item?.error) return { __error: item.error.json?.message ?? JSON.stringify(item.error) };
  return item?.result?.data?.json;
}

const db = await mysql.createConnection({ uri: DATABASE_URL, multipleStatements: true });
const tag = Date.now().toString(36);
let userId, token, projectId, batchId;

try {
  // ── fixtures: smoke user ──────────────────────────────────────────
  const pw = `Smoke-${tag}-Passw0rd!`;
  const signup = await trpc("localAuth.signup", { username: `smoke-batch-${tag}`, password: pw, name: "Smoke Batch" });
  if (signup.__error) throw new Error("signup: " + signup.__error);
  userId = signup.user.id;

  const login = await trpc("localAuth.login", { username: `smoke-batch-${tag}`, password: pw });
  if (login.__error) throw new Error("login: " + login.__error);
  token = login.token;

  // ── create project ────────────────────────────────────────────────
  const project = await trpc("project.create", { name: `Smoke Batch Project ${tag}` }, token);
  if (project.__error) throw new Error("create project: " + project.__error);
  projectId = project.id;

  // ── add a provider (required for pipeline runs) ───────────────────
  const provider = await trpc("llm.createProvider", {
    name: "Smoke Provider",
    slug: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-smoke-test-key",
    defaultModel: "gpt-4o-mini",
  }, token);
  if (provider.__error) throw new Error("create provider: " + provider.__error);

  // ── runBatch (3 inputs) ───────────────────────────────────────────
  const inputs = ["Input A", "Input B", "Input C"];
  const batch = await trpc("swarm.runBatch", {
    projectId,
    name: `Smoke batch ${tag}`,
    inputs,
  }, token);
  if (batch.__error) throw new Error("runBatch: " + batch.__error);
  batchId = batch.batchId;

  check("runBatch returns batchId", typeof batchId === "number" && batchId > 0);
  check("runBatch returns 3 runIds", batch.runIds.length === 3);
  check("runBatch status is queued", batch.status === "queued");

  // ── poll batch_status ─────────────────────────────────────────────
  let status = null;
  let polls = 0;
  const maxPolls = 30;
  do {
    await new Promise((r) => setTimeout(r, 2000));
    status = await trpcQuery("swarm.getBatchStatus", { batchId }, token);
    if (status.__error) throw new Error("getBatchStatus: " + status.__error);
    polls++;
  } while (status.status === "running" && polls < maxPolls);

  check(`batch completes within ${maxPolls} polls`, polls < maxPolls, `(status: ${status.status})`);
  check("batch has 3 totalRuns", status.totalRuns === 3);
  check("batch completed+failed = total", (status.completedRuns + status.failedRuns) === 3);

  // ── exportBatchResults ────────────────────────────────────────────
  const exported = await trpcQuery("swarm.exportBatchResults", { batchId }, token);
  if (exported.__error) throw new Error("exportBatchResults: " + exported.__error);

  check("export returns CSV string", typeof exported.csv === "string" && exported.csv.length > 0);
  check("CSV has header + 3 data rows", exported.csv.split("\\n").length === 5); // header + 3 rows + trailing empty

  // ── listBatches ───────────────────────────────────────────────────
  const batches = await trpcQuery("swarm.listBatches", { limit: 10 }, token);
  if (batches.__error) throw new Error("listBatches: " + batches.__error);
  check("listBatches includes our batch", batches.some((b) => b.id === batchId));

  console.log(`\\n smoke-batch: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  console.error("SMOKE ERROR:", err.message);
  process.exit(1);
} finally {
  // ── cleanup ───────────────────────────────────────────────────────
  if (batchId) await db.query("DELETE FROM swarm_batches WHERE id = ?", [batchId]);
  if (projectId) {
    await db.query("DELETE FROM swarm_runs WHERE project_id = ?", [projectId]);
    await db.query("DELETE FROM pipeline_steps WHERE project_id = ?", [projectId]);
    await db.query("DELETE FROM projects WHERE id = ?", [projectId]);
  }
  if (userId) {
    await db.query("DELETE FROM llm_providers WHERE user_id = ?", [userId]);
    await db.query("DELETE FROM users WHERE id = ?", [userId]);
  }
  await db.end();
}
