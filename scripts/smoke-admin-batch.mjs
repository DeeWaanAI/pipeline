// Batch B (admin hardening) boot smoke — 2026-07-28.
// Verifies: #1 admin audit trail rows persist, #2 lockout guard rejects
// self-demotion, #3 user search count+email, #5 certification queue + requeue
// guards, and that fixtures are removed afterwards.
// Requires the app server already running on PORT (default 3000).
//   node scripts/smoke-admin-batch.mjs
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

// tRPC query procedures require GET with the input in the query string.
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
let adminId, memberId, listingId, templateId;

try {
  // ── fixtures: smoke admin + smoke member ──────────────────────────
  const pw = `Smoke-${tag}-Passw0rd!`;
  const a = await trpc("localAuth.signup", { username: `smoke-admin-${tag}`, password: pw, name: "Smoke Admin" });
  if (a.__error) throw new Error("signup admin: " + a.__error);
  adminId = a.user.id;
  await db.query("UPDATE users SET role='admin' WHERE id=?", [adminId]);
  // Re-login not needed: role is read per-request from the JWT's user row? No —
  // the token carries the user; promote then call with a FRESH login token.
  const login = await trpc("localAuth.login", { username: `smoke-admin-${tag}`, password: pw });
  const adminToken = login.token;

  const m = await trpc("localAuth.signup", { username: `smoke-member-${tag}`, password: pw, name: "Smoke Member" });
  memberId = m.user.id;

  console.log("── #3 user search fixes");
  const byEmail = await trpcQuery("admin.listUsers", { page: 1, pageSize: 20, search: `smoke-admin-${tag}` }, adminToken);
  check("search by username matches", !byEmail.__error && byEmail.users.some((u) => u.id === adminId));
  check("total respects the search filter", !byEmail.__error && byEmail.total === byEmail.users.length,
    `total=${byEmail.total} rows=${byEmail.users?.length}`);
  const [emailRow] = await db.query("SELECT email FROM users WHERE id=?", [adminId]);
  if (emailRow[0]?.email) {
    const r = await trpcQuery("admin.listUsers", { page: 1, pageSize: 20, search: emailRow[0].email }, adminToken);
    check("search matches email", !r.__error && r.users.some((u) => u.id === adminId));
  } else {
    await db.query("UPDATE users SET email=? WHERE id=?", [`smoke-${tag}@example.com`, adminId]);
    const r = await trpcQuery("admin.listUsers", { page: 1, pageSize: 20, search: `smoke-${tag}@example.com` }, adminToken);
    check("search matches email", !r.__error && r.users.some((u) => u.id === adminId));
  }

  console.log("── #2 lockout guard");
  const selfDemote = await trpc("admin.setUserRole", { userId: adminId, role: "user" }, adminToken);
  check("self-demotion rejected", !!selfDemote.__error && /demote yourself/.test(selfDemote.__error), selfDemote.__error ?? "");
  const promote = await trpc("admin.setUserRole", { userId: memberId, role: "admin" }, adminToken);
  check("promoting another user works", !promote.__error && promote.success === true, promote.__error ?? "");

  console.log("── #1 audit trail");
  await db.query(
    "INSERT INTO feature_flags (`key`, name, description, enabled, rollout_percent) VALUES ('smoke_batch_b', 'Smoke', 'smoke', 0, 0) ON DUPLICATE KEY UPDATE enabled=0");
  const flag = await trpc("admin.toggleFeatureFlag", { key: "smoke_batch_b", enabled: true }, adminToken);
  check("flag toggle works", !flag.__error && flag.success === true, flag.__error ?? "");
  const audit = await trpcQuery("admin.listAdminAuditLog", { page: 1, pageSize: 10 }, adminToken);
  const actions = (audit.items ?? []).map((i) => i.action);
  check("audit log readable", !audit.__error, audit.__error ?? "");
  check("flag toggle audited", actions.includes("feature_flag.toggle"));
  check("role change audited", actions.includes("user.set_role"));
  const flagRow = (audit.items ?? []).find((i) => i.action === "feature_flag.toggle");
  check("audit row has admin username + detail", !!flagRow && flagRow.adminUsername === `smoke-admin-${tag}` && flagRow.detail?.enabled === true);

  console.log("── #5 certification queue + requeue");
  const queue = await trpcQuery("admin.certificationQueue", {}, adminToken);
  check("certification queue readable", !queue.__error && Array.isArray(queue), queue.__error ?? "");

  await db.query("INSERT INTO pipeline_templates (user_id, name, description, steps, is_auto) VALUES (?, ?, '', JSON_ARRAY(), 0)", [adminId, `smoke-${tag}`]);
  templateId = (await db.query("SELECT LAST_INSERT_ID() id"))[0][0].id;
  await db.query("INSERT INTO marketplace_listings (creator_id, template_id, title, price, status) VALUES (?, ?, ?, 0, 'generating')", [adminId, templateId, `smoke-listing-${tag}`]);
  listingId = (await db.query("SELECT LAST_INSERT_ID() id"))[0][0].id;

  const q2 = await trpcQuery("admin.certificationQueue", {}, adminToken);
  const row = (q2 ?? []).find((r) => r.id === listingId);
  check("stuck generating listing appears in queue", !!row && row.status === "generating");
  const requeue = await trpc("admin.requeueCertification", { listingId }, adminToken);
  check("requeue resets generating → draft", !requeue.__error && requeue.action === "reset_to_draft", requeue.__error ?? "");
  const [after] = await db.query("SELECT status FROM marketplace_listings WHERE id=?", [listingId]);
  check("listing now draft", after[0]?.status === "draft");
  const badRequeue = await trpc("admin.requeueCertification", { listingId }, adminToken);
  check("requeue on draft rejected", !!badRequeue.__error && /Cannot requeue/.test(badRequeue.__error), badRequeue.__error ?? "");

  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  // ── cleanup (always) ──────────────────────────────────────────────
  if (listingId) await db.query("DELETE FROM marketplace_listings WHERE id=?", [listingId]).catch(() => {});
  if (templateId) await db.query("DELETE FROM pipeline_templates WHERE id=?", [templateId]).catch(() => {});
  await db.query("DELETE FROM feature_flags WHERE `key`='smoke_batch_b'").catch(() => {});
  if (adminId) await db.query("DELETE FROM admin_audit_log WHERE admin_user_id=?", [adminId]).catch(() => {});
  if (adminId) await db.query("DELETE FROM users WHERE id=?", [adminId]).catch(() => {});
  if (memberId) await db.query("DELETE FROM users WHERE id=?", [memberId]).catch(() => {});
  await db.end();
  console.log("fixtures cleaned");
}
process.exit(failed > 0 ? 1 : 0);
