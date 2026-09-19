// ═══════════════════════════════════════════════════════════════════
//  BETA SIMULATION — multi-creator marketplace stress test (guardrailed)
// ═══════════════════════════════════════════════════════════════════
// Simulates a real beta: 4 test creators (2 hand-built pipelines, 2
// auto-designed) publish to the marketplace; 5 shared test reviewers work
// the combined blind-review pool. Everything goes through the REAL public
// APIs (signup, template, project, autoDesign, marketplace, blind review).
//
// GUARDRAILS (in addition to quorum-rehearsal.mjs discipline):
//  1. HARD CAPS — refuses to run above MAX_CREATORS/MAX_REVIEWERS/
//     MAX_LISTINGS. A typo cannot spawn a crowd.
//  2. MANIFEST — every created ID is written to the manifest BEFORE the
//     next action; cleanup is driven by the manifest list, never by
//     queries that could match pre-existing rows.
//  3. AUTO-RESTORE — any stage, on start, reports leftover manifest state;
//     `cleanup` is always safe to re-run and restores listing 4 + deletes
//     only manifest-listed rows.
//  4. PROVIDER BUDGET GUARD — aborts if listing submissions would exceed
//     MAX_LISTINGS (each submission = 1 test-generation cycle on the
//     owner's provider key, whose CIPHERTEXT is copied to test creators;
//     the plaintext key never appears anywhere).
//  5. FULL ACCESS — the owner has granted standing full access for
//     scripted ops (2026-07-28). Guardrails 1–4 still apply unchanged.
//
// Real listing 4 is flipped to 'draft' during the run (pool intact,
// unclaimable while not certifying) and restored in cleanup.
//
// Usage:
//   REHEARSAL_DB_URL='mysql://...' node scripts/beta-simulation.mjs setup|wait|review|verify|cleanup [--dry-run]
// ═══════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { fileURLToPath } from "node:url";

const BASE = "https://deewaanai-production.up.railway.app";
const TRPC_URL = `${BASE}/api/trpc`;
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_FILE = path.join(DIR, ".deewaanai-beta-manifest.json");

// ─── Guardrail 1: hard caps ─────────────────────────────────────────
const MAX_CREATORS = 4;
const MAX_REVIEWERS = 5;
const MAX_LISTINGS = 4; // also the provider budget guard (guardrail 4)
const REVIEWS_PER_REVIEWER_CAP = 30; // absolute ceiling per reviewer

const REAL_LISTING_ID = 4;
const OWNER_USER_ID = 1;
const PROVIDER_TO_COPY = 2; // owner's aliyun qwen3.6-flash provider (ciphertext copy)

const CREATOR_PLANS = [
  { kind: "hand-good", title: "ZZ Beta Hand-Good (test listing — do not buy)",
    steps: [
      { name: "Summarizer", role: "builder", systemPrompt: "You are an expert meeting-notes summarizer. Produce a crisp executive summary with clear sections: Decisions, Action Items (with owners), Risks. Be precise and never invent details not present in the input.", stepType: "agent", providerId: null, model: null, temperature: "0.3", maxTokens: 2048 },
      { name: "Critic", role: "critic", systemPrompt: "You are a meticulous editor. Review the summary for factual fidelity to the input, missing action items, and clarity. List concrete improvements only.", stepType: "agent", providerId: null, model: null, temperature: "0.2", maxTokens: 1024 },
      { name: "Refiner", role: "refiner", systemPrompt: "You are a senior executive writer. Apply the critic's feedback and produce the final polished summary. Keep it under 300 words, well-structured, professional.", stepType: "agent", providerId: null, model: null, temperature: "0.3", maxTokens: 2048 },
    ] },
  { kind: "hand-sloppy", title: "ZZ Beta Hand-Sloppy (test listing — do not buy)",
    steps: [
      { name: "Doer", role: "builder", systemPrompt: "do the thing", stepType: "agent", providerId: null, model: null, temperature: "0.9", maxTokens: 256 },
    ] },
  { kind: "auto-trip", title: "ZZ Beta Auto-Trip (test listing — do not buy)",
    task: "Plan a 3-day city trip itinerary with daily schedule, budget breakdown, and local food tips" },
  { kind: "auto-email", title: "ZZ Beta Auto-Email (test listing — do not buy)",
    task: "Proofread and improve marketing emails: fix grammar, tighten copy, add a compelling subject line and call to action" },
];

const stage = process.argv[2];
const DRY_RUN = process.argv.includes("--dry-run");
if (!stage || !["setup", "wait", "review", "verify", "cleanup"].includes(stage)) {
  console.error("usage: node scripts/beta-simulation.mjs setup|wait|review|verify|cleanup [--dry-run]");
  process.exit(1);
}
if (CREATOR_PLANS.length > MAX_CREATORS) { console.error("CAP VIOLATION: plans exceed MAX_CREATORS"); process.exit(1); }
const DB_URL = process.env.REHEARSAL_DB_URL;
if (!DB_URL) { console.error("REHEARSAL_DB_URL env var required"); process.exit(1); }

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Guardrail 2: manifest written before acting ────────────────────
const manifest = fs.existsSync(MANIFEST_FILE)
  ? JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"))
  : { realListingTouched: false, submissions: 0, creators: [], reviewers: [] };
function saveManifest() { fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), { mode: 0o600 }); }

// ─── Guardrail 3: leftover-state report on every stage ──────────────
if (stage !== "cleanup" && (manifest.creators.length || manifest.reviewers.length)) {
  log(`⚠ manifest shows leftovers from a previous run (${manifest.creators.length} creators, ${manifest.reviewers.length} reviewers). Continuing; run 'cleanup' to remove them.`);
}

const db = await mysql.createConnection({ uri: DB_URL });

// ─── tRPC client (real HTTP API, superjson batch) ───────────────────
async function trpc(proc, input, token) {
  const res = await fetch(`${TRPC_URL}/${proc}?batch=1`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-local-auth-token": token } : {}) },
    body: JSON.stringify({ 0: { json: input } }),
  });
  const json = await res.json();
  const item = Array.isArray(json) ? json[0] : json;
  if (item?.error) throw new Error(`${proc}: ${item.error.json?.message ?? JSON.stringify(item.error).slice(0, 250)}`);
  return item?.result?.data?.json;
}

// Signup rate limit: 5/min/IP. We create 9 accounts — pace them.
let signupCount = 0;
async function signup(username, name) {
  if (signupCount > 0 && signupCount % 4 === 0) { log("pacing signups (rate limit) — waiting 65s"); await sleep(65000); }
  signupCount++;
  const password = `Beta-${crypto.randomBytes(12).toString("base64url")}!`;
  const r = await trpc("localAuth.signup", { username, password, name });
  return { userId: r.user.id, username, token: r.token };
}

// ─── Honest heuristic scoring (same discipline as the rehearsal) ────
function scoreTask(task, reviewerIdx) {
  const out = task.actualOutput ?? "";
  const h = (s) => crypto.createHash("md5").update(s).digest()[0];
  const base = 3 + (out.length > 600 ? 1 : 0) + (/^#|\n#/.test(out) ? 0.5 : 0) + (out.length > 1500 ? 0.5 : 0);
  const jitter = (dim) => ((h(`${task.taskId}:${dim}:${reviewerIdx}`) % 3) - 1) * 0.5;
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
async function doSetup() {
  if (DRY_RUN) { log(`[dry-run] protect listing ${REAL_LISTING_ID}; create ${CREATOR_PLANS.length} creators with pipelines+listings via real APIs`); return; }

  log("protecting real listing", REAL_LISTING_ID, "→ draft");
  const [u] = await db.query("UPDATE marketplace_listings SET status='draft' WHERE id=? AND status='certifying'", [REAL_LISTING_ID]);
  manifest.realListingTouched = u.affectedRows > 0;
  saveManifest();
  log("real listing flipped:", u.affectedRows);

  const runTag = crypto.randomBytes(3).toString("hex");
  for (let i = 0; i < CREATOR_PLANS.length; i++) {
    const plan = CREATOR_PLANS[i];
    log(`── creator ${i + 1}/${CREATOR_PLANS.length} (${plan.kind})`);
    const c = await signup(`beta-creator-${runTag}-${i + 1}`, `Beta Creator ${i + 1} (${plan.kind})`);
    const entry = { ...c, kind: plan.kind, providerId: null, projectId: null, templateId: null, listingId: null };
    manifest.creators.push(entry); saveManifest(); // manifest first

    // Provider fixture: copy the owner's provider CIPHERTEXT row (no plaintext anywhere)
    const [pr] = await db.query(
      "INSERT INTO llm_providers (user_id, name, slug, base_url, api_key_ref, default_model, models, config, is_enabled) SELECT ?, name, slug, base_url, api_key_ref, default_model, models, config, is_enabled FROM llm_providers WHERE id=? AND user_id=?",
      [c.userId, PROVIDER_TO_COPY, OWNER_USER_ID]);
    entry.providerId = Number(pr.insertId); saveManifest();
    log("provider fixture copied (id", entry.providerId, ")");

    if (plan.kind.startsWith("hand")) {
      const t = await trpc("template.createEmpty", { name: `Beta ${plan.kind}` }, c.token);
      entry.templateId = t.id; saveManifest();
      await trpc("template.update", { id: t.id, name: `Beta ${plan.kind}`, steps: plan.steps }, c.token);
      log("hand-built template", t.id, `(${plan.steps.length} steps)`);
    } else {
      const p = await trpc("project.create", { name: `Beta ${plan.kind}`, description: "beta simulation", defaultProviderId: entry.providerId }, c.token);
      entry.projectId = p.project?.id ?? p.id; saveManifest();
      log("project", entry.projectId, "created — running real autoDesign (LLM call)...");
      await trpc("swarm.autoDesign", { projectId: entry.projectId, task: plan.task, providerId: entry.providerId }, c.token);
      const [tpl] = await db.query("SELECT id FROM pipeline_templates WHERE user_id=? ORDER BY id DESC LIMIT 1", [c.userId]);
      entry.templateId = tpl[0]?.id ?? null; saveManifest();
      if (!entry.templateId) throw new Error("autoDesign produced no template for " + plan.kind);
      log("auto-designed template", entry.templateId);
    }

    // Guardrail 4: provider budget — never submit more than MAX_LISTINGS
    if (manifest.submissions >= MAX_LISTINGS) throw new Error("BUDGET GUARD: submissions cap reached");
    const listing = await trpc("marketplace.create", { templateId: entry.templateId, title: plan.title, description: "Automated beta simulation listing. Temporary — will be deleted.", category: "other", price: 0 }, c.token);
    entry.listingId = listing.id; saveManifest();
    log("listing", listing.id, "created — submitting for review...");
    await trpc("marketplace.submitForReview", { id: listing.id }, c.token);
    manifest.submissions++; saveManifest();
    log("submitted (total submissions:", manifest.submissions, ")");
  }
  log("SETUP complete —", manifest.creators.length, "creators,", manifest.submissions, "listings submitted");
}

async function doWait() {
  const ids = manifest.creators.map((c) => c.listingId).filter(Boolean);
  if (DRY_RUN || ids.length === 0) { log("[dry-run] poll listings", ids, "until all leave 'generating'"); if (ids.length === 0 && !DRY_RUN) throw new Error("no listings"); return; }
  for (let i = 0; i < 60; i++) {
    const [rows] = await db.query(`SELECT id, status, ai_grade FROM marketplace_listings WHERE id IN (${ids.join(",")})`);
    const pending = rows.filter((r) => r.status === "generating" || r.status === "draft");
    log(`poll ${i}:`, rows.map((r) => `${r.id}:${r.status}${r.ai_grade ? `(${r.ai_grade})` : ""}`).join("  "));
    if (pending.length === 0) return;
    await sleep(15000);
  }
  throw new Error("timeout waiting for listings to settle");
}

async function doReview() {
  if (DRY_RUN) { log(`[dry-run] signup ${MAX_REVIEWERS} reviewers, enroll, work the combined pool`); return; }
  const runTag = crypto.randomBytes(3).toString("hex");
  if (manifest.reviewers.length === 0) {
    for (let i = 0; i < MAX_REVIEWERS; i++) {
      const r = await signup(`beta-reviewer-${runTag}-${i + 1}`, `Beta Reviewer ${i + 1}`);
      manifest.reviewers.push({ ...r, done: 0 }); saveManifest();
      log("signed up", r.username);
      await sleep(3000);
    }
  }
  for (let i = 0; i < manifest.reviewers.length; i++) {
    const rev = manifest.reviewers[i];
    try { await trpc("marketplace.enrollReviewer", {}, rev.token); log(rev.username, "enrolled"); }
    catch (e) { if (!String(e.message).includes("Already enrolled")) throw e; }
    while (rev.done < REVIEWS_PER_REVIEWER_CAP) {
      const { task } = await trpc("marketplace.getNextReviewTask", {}, rev.token);
      if (!task) { log(rev.username, "pool exhausted at", rev.done, "reviews"); break; }
      const scores = scoreTask(task, i);
      await trpc("marketplace.submitReviewTask", { taskId: task.taskId ?? task.id, ...scores }, rev.token);
      rev.done++; saveManifest();
      log(rev.username, `review ${rev.done} submitted (task ${task.taskId ?? task.id})`);
      await sleep(1200);
    }
  }
  log("REVIEW complete:", manifest.reviewers.map((r) => r.done).join("+"), "reviews total");
}

async function doVerify() {
  const ids = manifest.creators.map((c) => c.listingId).filter(Boolean);
  if (DRY_RUN) { log("[dry-run] report per-listing outcome + pool stats"); return; }
  const [rows] = await db.query(
    `SELECT l.id, l.title, l.status, l.grade, l.kappa_score, l.review_count, l.certified_at,
       (SELECT COUNT(*) FROM blind_review_tasks t WHERE t.listing_id=l.id) AS tasks,
       (SELECT COUNT(*) FROM blind_review_tasks t WHERE t.listing_id=l.id AND t.status='completed') AS done
     FROM marketplace_listings l WHERE l.id IN (${ids.join(",")})`);
  for (const r of rows) {
    log("VERIFY", r.id, r.status, `grade=${r.grade ?? "—"}`, `kappa=${r.kappa_score ?? "—"}`, `reviews=${r.review_count ?? 0}`, `pool=${r.done}/${r.tasks}`);
  }
  const outcomes = rows.map((r) => r.status);
  log("outcomes:", outcomes.join(", "));
}

async function doCleanup() {
  log("CLEANUP — deleting manifest-listed rows only");
  if (DRY_RUN) { log(`[dry-run] delete ${manifest.creators.length} creators' artifacts, ${manifest.reviewers.length} reviewers; restore listing ${REAL_LISTING_ID}`); return; }
  for (const c of manifest.creators) {
    if (c.listingId) {
      for (const [table, col] of [["listing_reviews","listing_id"],["blind_review_tasks","listing_id"],["review_assignments","listing_id"],["test_prompts","listing_id"],["encrypted_prompts","listing_id"],["marketplace_listings","id"]]) {
        await db.query(`DELETE FROM ${table} WHERE ${col}=?`, [c.listingId]);
      }
      log("creator", c.userId, "listing", c.listingId, "artifacts deleted");
    }
    // FK-safe order: every child of the copied provider must go first
    // (custom_agents.default_provider_id, projects.default_provider_id).
    await db.query("DELETE FROM custom_agents WHERE user_id=?", [c.userId]).catch(() => {});
    await db.query("DELETE FROM pipeline_steps WHERE template_id=?", [c.templateId ?? -1]).catch(() => {});
    if (c.projectId) await db.query("DELETE FROM projects WHERE id=? AND user_id=?", [c.projectId, c.userId]);
    if (c.templateId) await db.query("DELETE FROM pipeline_templates WHERE id=? AND user_id=?", [c.templateId, c.userId]);
    if (c.providerId) await db.query("DELETE FROM llm_providers WHERE id=? AND user_id=?", [c.providerId, c.userId]);
    await db.query("DELETE FROM swarm_runs WHERE user_id=?", [c.userId]).catch(() => {});
    await db.query("DELETE FROM listing_reviews WHERE reviewer_id=?", [c.userId]);
    await db.query("DELETE FROM reviewer_profiles WHERE user_id=?", [c.userId]);
    await db.query("DELETE FROM users WHERE id=? AND username LIKE 'beta-creator-%'", [c.userId]);
    log("creator", c.userId, "fully removed");
  }
  for (const r of manifest.reviewers) {
    await db.query("DELETE FROM listing_reviews WHERE reviewer_id=?", [r.userId]);
    await db.query("DELETE FROM review_assignments WHERE reviewer_id=?", [r.userId]);
    await db.query("DELETE FROM blind_review_tasks WHERE reviewer_id=? AND status='assigned'", [r.userId]);
    await db.query("DELETE FROM reviewer_profiles WHERE user_id=?", [r.userId]);
    await db.query("DELETE FROM users WHERE id=? AND username LIKE 'beta-reviewer-%'", [r.userId]);
    log("reviewer", r.userId, "removed");
  }
  if (manifest.realListingTouched) {
    await db.query("UPDATE marketplace_listings SET status='certifying' WHERE id=? AND status='draft'", [REAL_LISTING_ID]);
    log("✅ real listing", REAL_LISTING_ID, "restored to certifying");
  }
  manifest.realListingTouched = false; manifest.submissions = 0; manifest.creators = []; manifest.reviewers = [];
  saveManifest();
  log("cleanup complete");
}

try {
  if (stage === "setup") await doSetup();
  if (stage === "wait") await doWait();
  if (stage === "review") await doReview();
  if (stage === "verify") await doVerify();
  if (stage === "cleanup") await doCleanup();
} finally {
  await db.end();
}
