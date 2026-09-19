// ═══════════════════════════════════════════════════════════════════
//  QUORUM REHEARSAL — end-to-end certification test on a DUMMY listing
// ═══════════════════════════════════════════════════════════════════
// Purpose: prove the blind-review certification machinery (claim → score →
// submit → 5×3 quorum + kappa → published/rejected) works in production,
// WITHOUT touching the integrity of the owner's real listing (id 4).
//
// What it does (stages, state persisted in .deewaanai-rehearsal-state.json):
//   setup   1. Flip the real listing 4 to 'draft' (its pool stays intact;
//             this keeps test reviewers from ever seeing it — claim picks
//             the lowest task id of ANY certifying listing).
//           2. Publish a clearly-marked dummy listing from project 7 via
//             the owner's MCP token, then submit_for_review.
//   wait    3. Poll until the dummy reaches 'certifying' (or terminal).
//   review  4. Sign up 5 users (quorum-tester-*) through the REAL public
//             signup API, enroll each as reviewer via the REAL tRPC API.
//           5. Each reviewer claims → scores → submits 3 blind tasks
//             through the REAL blind-review flow (15 reviews = quorum).
//   verify  6. Report final listing status (published/rejected/certifying).
//   cleanup 7. Delete ONLY rows created by this run (dummy listing, its
//             test prompts / encrypted prompts / blind tasks / reviews;
//             the 5 test users + their reviewer profiles), then restore
//             listing 4 to 'certifying'. Idempotent: safe to re-run.
//
// GUARDRAILS:
//  - Never modifies or deletes any pre-existing row. The ONLY pre-existing
//    row it touches is listing 4's status field, flipped to 'draft' in
//    setup and restored to 'certifying' in cleanup (even on crash, re-run
//    cleanup to restore). No reviews exist for listing 4 yet, so nothing
//    is lost.
//  - Test reviewers can only ever see the dummy listing's tasks (listing 4
//    is not 'certifying' during the review stage).
//  - --dry-run prints every planned action without executing anything.
//  - The DB URL comes from the REHEARSAL_DB_URL env var — never hardcoded.
//  - Every action is printed to the console as it happens.
//
// Usage:
//   REHEARSAL_DB_URL='mysql://...' node scripts/quorum-rehearsal.mjs setup|wait|review|verify|cleanup|all [--dry-run]
// ═══════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { fileURLToPath } from "node:url";

const BASE = "https://deewaanai-production.up.railway.app";
const MCP_URL = `${BASE}/mcp`;
const TRPC_URL = `${BASE}/api/trpc`;
const TOKEN_URL = `${BASE}/oauth/token`;
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_FILE = path.join(DIR, ".deewaanai-test-token.json");
const STATE_FILE = path.join(DIR, ".deewaanai-rehearsal-state.json");

const REAL_LISTING_ID = 4;              // owner's real listing — protected
const DUMMY_PROJECT_ID = 7;             // "Contract Redline Checker" (template 2)
const DUMMY_TITLE = "ZZ Rehearsal Listing (automated test — do not buy)";
const REVIEWER_COUNT = 5;               // = MIN_UNIQUE_REVIEWERS
const REVIEWS_PER_REVIEWER = 3;         // = MIN_REVIEWS_PER_REVIEWER → 15 total

const stage = process.argv[2];
const DRY_RUN = process.argv.includes("--dry-run");
if (!stage || !["setup", "wait", "review", "verify", "cleanup", "all"].includes(stage)) {
  console.error("usage: node scripts/quorum-rehearsal.mjs setup|wait|review|verify|cleanup|all [--dry-run]");
  process.exit(1);
}

const DB_URL = process.env.REHEARSAL_DB_URL;
if (!DB_URL) { console.error("REHEARSAL_DB_URL env var required"); process.exit(1); }

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── State ──────────────────────────────────────────────────────────
const state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  : { dummyListingId: null, reviewers: [], realListingWasTouched: false };
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 }); }

// ─── DB (scoped queries only) ───────────────────────────────────────
const db = await mysql.createConnection({ uri: DB_URL });

// ─── Owner MCP client (token + auto-refresh, same as mcp-call.mjs) ──
let mcpSession = null;
let rpcId = 0;
async function ownerToken() {
  const t = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  if (Date.now() - new Date(t.obtained_at).getTime() > 50 * 60 * 1000) {
    const res = await fetch(TOKEN_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: t.client_id, refresh_token: t.refresh_token }),
    });
    if (!res.ok) throw new Error("token refresh failed: " + res.status);
    const fresh = await res.json();
    fresh.client_id = t.client_id; fresh.obtained_at = new Date().toISOString();
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(fresh, null, 2), { mode: 0o600 });
    return fresh.access_token;
  }
  return t.access_token;
}
async function mcpCall(name, args) {
  const token = await ownerToken();
  const rpc = async (method, params, isNotification = false) => {
    const body = { jsonrpc: "2.0", method, params };
    if (!isNotification) body.id = ++rpcId;
    const headers = {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "authorization": `Bearer ${token}`,
    };
    if (mcpSession) headers["mcp-session-id"] = mcpSession;
    const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) mcpSession = sid;
    if (isNotification || res.status === 202) return null;
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    return JSON.parse(dataLines.length ? dataLines[dataLines.length - 1] : text);
  };
  if (!mcpSession) {
    await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "rehearsal", version: "1.0" } });
    await rpc("notifications/initialized", {}, true);
  }
  const r = await rpc("tools/call", { name, arguments: args });
  const payload = r?.result ?? r;
  const text = payload?.content?.[0]?.text;
  if (payload?.isError) throw new Error(`MCP ${name} failed: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

// ─── tRPC client for test users (real HTTP API, superjson batch) ────
async function trpc(proc, input, token) {
  const res = await fetch(`${TRPC_URL}/${proc}?batch=1`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-local-auth-token": token } : {}) },
    body: JSON.stringify({ 0: { json: input } }),
  });
  const json = await res.json();
  const item = Array.isArray(json) ? json[0] : json;
  if (item?.error) throw new Error(`${proc}: ${item.error.json?.message ?? JSON.stringify(item.error).slice(0, 200)}`);
  return item?.result?.data?.json;
}

// ─── Honest heuristic scoring (deterministic, cross-reviewer aligned) ──
// Scores are derived from output structure so independent reviewers mostly
// agree (needed for kappa), with small per-reviewer jitter.
function scoreTask(task, reviewerIdx) {
  const out = task.actualOutput ?? "";
  const h = (s) => crypto.createHash("md5").update(s).digest()[0];
  const base =
    3 +
    (out.length > 600 ? 1 : 0) +
    (/^#|\n#/.test(out) ? 0.5 : 0) +
    (out.length > 1500 ? 0.5 : 0);
  const jitter = (dim) => ((h(`${task.taskId}:${dim}:${reviewerIdx}`) % 3) - 1) * 0.5; // -0.5/0/+0.5
  const clamp = (v) => Math.max(1, Math.min(5, Math.round(v)));
  return {
    accuracy: clamp(base + jitter("acc")),
    completeness: clamp(base + jitter("cmp")),
    clarity: clamp(base + 0.5 + jitter("clr")),
    tokenEfficiency: clamp(base - 0.5 + jitter("tok")),
    speed: clamp(base + jitter("spd")),
    consistency: clamp(base + 0.5 + jitter("con")),
    reviewTime: 45 + (h(`${task.taskId}:t:${reviewerIdx}`) % 120),
  };
}

// ═══════════════════════════════════════════════════════════════════
//  STAGES
// ═══════════════════════════════════════════════════════════════════
async function doSetup() {
  log("SETUP — protecting real listing", REAL_LISTING_ID, "→ draft");
  if (DRY_RUN) { log("[dry-run] UPDATE listing 4 → draft; publish dummy from project", DUMMY_PROJECT_ID, "; submit_for_review"); return; }
  const [u] = await db.query("UPDATE marketplace_listings SET status='draft' WHERE id=? AND status='certifying'", [REAL_LISTING_ID]);
  state.realListingWasTouched = u.affectedRows > 0;
  log("real listing flipped:", u.affectedRows, "(its 50 pooled tasks stay intact and unclaimable while not certifying)");

  log("publishing dummy listing from project", DUMMY_PROJECT_ID);
  const pub = await mcpCall("publish_to_marketplace", {
    projectId: DUMMY_PROJECT_ID, title: DUMMY_TITLE,
    description: "Automated certification-machinery rehearsal. This listing is temporary and will be deleted.",
    category: "other", price: 0,
  });
  state.dummyListingId = pub.listingId ?? pub.id;
  saveState();
  log("dummy listing id:", state.dummyListingId);

  log("submitting dummy for review...");
  const sub = await mcpCall("submit_for_review", { listingId: state.dummyListingId });
  log("submit result:", sub.status, "-", sub.message?.slice(0, 120));
}

async function doWait() {
  const id = state.dummyListingId;
  if (DRY_RUN) { log("[dry-run] poll dummy listing until not generating"); return; }
  if (!id) throw new Error("no dummy listing — run setup first");
  for (let i = 0; i < 40; i++) {
    const [r] = await db.query("SELECT status, ai_grade FROM marketplace_listings WHERE id=?", [id]);
    const s = r[0]?.status;
    log(`poll ${i}: ${s} (grade: ${r[0]?.ai_grade ?? "—"})`);
    if (s && s !== "generating" && s !== "draft") return;
    await sleep(15000);
  }
  throw new Error("timed out waiting for certifying");
}

async function doReview() {
  const id = state.dummyListingId;
  if (DRY_RUN) { log(`[dry-run] signup ${REVIEWER_COUNT} quorum-tester-* users, enroll, ${REVIEWS_PER_REVIEWER} reviews each`); return; }
  if (!id) throw new Error("no dummy listing — run setup first");
  const runTag = crypto.randomBytes(3).toString("hex");

  // 1. Sign up reviewers via the REAL public signup API (token comes back directly)
  if (state.reviewers.length === 0) {
    for (let i = 0; i < REVIEWER_COUNT; i++) {
      const username = `quorum-tester-${runTag}-${i + 1}`;
      const password = `Rsh-${crypto.randomBytes(12).toString("base64url")}!`;
      const r = await trpc("localAuth.signup", { username, password, name: `Rehearsal Reviewer ${i + 1}` });
      state.reviewers.push({ userId: r.user.id, username, token: r.token, done: 0 });
      saveState();
      log("signed up", username, "→ user id", r.user.id);
      await sleep(3000); // stay well under the 5 signups/min/IP rate limit
    }
  }

  // 2. Enroll + review through the REAL blind-task flow
  for (let i = 0; i < state.reviewers.length; i++) {
    const rev = state.reviewers[i];
    try {
      await trpc("marketplace.enrollReviewer", {}, rev.token);
      log(rev.username, "enrolled as reviewer");
    } catch (e) {
      if (!String(e.message).includes("Already enrolled")) throw e;
    }
    while (rev.done < REVIEWS_PER_REVIEWER) {
      const { task } = await trpc("marketplace.getNextReviewTask", {}, rev.token);
      if (!task) { log(rev.username, "no more tasks"); break; }
      const scores = scoreTask(task, i);
      await trpc("marketplace.submitReviewTask", { taskId: task.taskId ?? task.id, ...scores }, rev.token);
      rev.done++;
      saveState();
      log(rev.username, `submitted review ${rev.done}/${REVIEWS_PER_REVIEWER} (task ${task.taskId ?? task.id})`);
      await sleep(1500);
    }
  }
  log("review stage complete:", state.reviewers.map((r) => r.done).join("+"), "reviews");
}

async function doVerify() {
  const id = state.dummyListingId;
  if (DRY_RUN) { log("[dry-run] SELECT status/grade/kappa for dummy listing", id); return; }
  const [r] = await db.query(
    "SELECT status, grade, kappa_score, review_count, certified_at FROM marketplace_listings WHERE id=?", [id]);
  const [t] = await db.query("SELECT COUNT(*) AS n, SUM(status='completed') AS done FROM blind_review_tasks WHERE listing_id=?", [id]);
  log("VERIFY dummy listing", id, JSON.stringify({ ...r[0], tasks: t[0] }));
  log(r[0]?.status === "published" ? "✅ quorum machinery PUBLISHED the dummy listing"
    : r[0]?.status === "rejected" ? "✅ quorum machinery evaluated and REJECTED (also a valid outcome)"
    : "⚠ still certifying — quorum not reached");
}

async function doCleanup() {
  log("CLEANUP — deleting only rows created by this run");
  const id = state.dummyListingId;
  const userIds = state.reviewers.map((r) => r.userId);
  if (DRY_RUN) {
    log(`[dry-run] delete reviews/tasks/prompts/listing for dummy ${id}; delete users [${userIds}]; restore listing 4 → certifying (if touched: ${state.realListingWasTouched})`);
    return;
  }
  if (id) {
    for (const [table, col] of [
      ["listing_reviews", "listing_id"],
      ["blind_review_tasks", "listing_id"],
      ["review_assignments", "listing_id"],
      ["test_prompts", "listing_id"],
      ["encrypted_prompts", "listing_id"],
      ["marketplace_listings", "id"],
    ]) {
      const [r] = await db.query(`DELETE FROM ${table} WHERE ${col}=?`, [id]);
      log(`deleted ${r.affectedRows} row(s) from ${table}`);
    }
    state.dummyListingId = null;
  }
  for (const uid of userIds) {
    await db.query("DELETE FROM listing_reviews WHERE reviewer_id=?", [uid]);
    await db.query("DELETE FROM review_assignments WHERE reviewer_id=?", [uid]);
    await db.query("DELETE FROM reviewer_profiles WHERE user_id=?", [uid]);
    await db.query("DELETE FROM users WHERE id=? AND username LIKE 'quorum-tester-%'", [uid]);
    log("deleted test user", uid);
  }
  state.reviewers = [];
  if (state.realListingWasTouched) {
    await db.query("UPDATE marketplace_listings SET status='certifying' WHERE id=? AND status='draft'", [REAL_LISTING_ID]);
    state.realListingWasTouched = false;
    log("✅ real listing", REAL_LISTING_ID, "restored to certifying");
  }
  saveState();
  log("cleanup complete");
}

// ─── Runner ─────────────────────────────────────────────────────────
try {
  if (stage === "setup" || stage === "all") await doSetup();
  if (stage === "wait" || stage === "all") await doWait();
  if (stage === "review" || stage === "all") await doReview();
  if (stage === "verify" || stage === "all") await doVerify();
  if (stage === "cleanup") await doCleanup();
  if (stage === "all") log("NOTE: run 'cleanup' after inspecting the result.");
} finally {
  await db.end();
}
