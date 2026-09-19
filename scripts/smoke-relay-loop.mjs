// ═══════════════════════════════════════════════════════════════════
//  OFFLINE SMOKE — on-prem relay loop, end to end on localhost
// ═══════════════════════════════════════════════════════════════════
// Proves the whole relay path against a locally running app:
//
//   1. Enables the enterprise_relay feature flag (restores prior state after).
//   2. Registers a relay via POST /api/relay/register (admin JWT minted
//      locally with APP_SECRET — same shape localAuth.signLocalToken issues).
//   3. Spawns relay/connector.mjs as a real child process, pointed at the
//      local app for BOTH CLOUD_URL and LOCAL_URL.
//   4. Enqueues an http_proxy request (GET /api/health) via the admin
//      endpoint and asserts the connector long-polls it, executes it, posts
//      the result back, and the row lands status=completed in MySQL.
//
// USAGE
//   # App must be running; no special env needed beyond normal config:
//   #   npm run dev                          # or: node dist/boot.js
//   #
//   # Then:
//   #   node scripts/smoke-relay-loop.mjs http://127.0.0.1:3001
//   #
//   # Args/env:
//   #   argv[2]       baseUrl of the running app (required)
//   #   --keep        leave relay registration + request rows in the DB
//   #   DATABASE_URL  (required; falls back to parsing ../.env)
//   #   APP_SECRET    (required; falls back to parsing ../.env) — must match
//   #                 the app's secret so the minted admin JWT verifies
//   #
//   # Requires at least one admin user (first signup becomes admin, or run
//   # `npm run make-admin`). The script enables enterprise_relay itself and
//   # restores its previous enabled/rollout state on exit.
//   #
//   # Expected output: PASS lines per check, then "SMOKE relay-loop OK".
//
// NOTES / LIMITATIONS
//   - The connector runs cleanly against localhost: CLOUD_URL and LOCAL_URL
//     both point at the app, so the relayed http_proxy call executes
//     GET /api/health on the app itself. No inbound ports are opened.
//   - This covers the loop (register → poll → execute → result → DB).
//     A REAL on-prem deployment (egress-only network, LOCAL_URL pointing at
//     a private service) is the acceptance item — see
//     DeeWaanAI-Next/ACCEPTANCE.md section D.
// ═══════════════════════════════════════════════════════════════════
import { spawn } from "child_process";
import fs from "fs";
import { fileURLToPath } from "url";
import { SignJWT } from "jose";
import mysql from "mysql2/promise";

// ─── Args & env ─────────────────────────────────────────────────────
const BASE = (process.argv[2] || "").replace(/\/+$/, "");
const KEEP = process.argv.includes("--keep");
if (!BASE) {
  console.error("usage: node scripts/smoke-relay-loop.mjs <baseUrl> [--keep]");
  process.exit(2);
}

let envFile = "";
try { envFile = fs.readFileSync(new URL("../.env", import.meta.url), "utf8"); } catch { /* .env optional */ }
const fromEnvFile = (k) => (envFile.match(new RegExp(`^${k}=["']?([^"'\\n]+)`, "m")) || [])[1] || "";

const DATABASE_URL = process.env.DATABASE_URL || fromEnvFile("DATABASE_URL");
const APP_SECRET = process.env.APP_SECRET || fromEnvFile("APP_SECRET");
if (!DATABASE_URL) { console.error("DATABASE_URL is required (env or .env)."); process.exit(2); }
if (!APP_SECRET) { console.error("APP_SECRET is required (env or .env) and must match the app's."); process.exit(2); }

const CONNECTOR = fileURLToPath(new URL("../relay/connector.mjs", import.meta.url));
const FLAG_KEY = "enterprise_relay";
const WAIT_COMPLETE_MS = 45000;

const fails = [];
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) fails.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let conn;
let child = null;
let relayId = null;
let requestId = null;
let flagPrior = undefined; // undefined = row did not exist
const childLog = [];

async function mintAdminToken(userId, username) {
  const key = new TextEncoder().encode(APP_SECRET);
  return new SignJWT({ userId, username, type: "local" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("600s")
    .sign(key);
}

try {
  conn = await mysql.createConnection({ uri: DATABASE_URL });

  // ─── Flag ON (restore later) ───────────────────────────────────────
  const [[prior]] = await conn.query(
    "SELECT enabled, rollout_percent FROM feature_flags WHERE `key` = ?", [FLAG_KEY]);
  flagPrior = prior ?? null;
  await conn.query(
    `INSERT INTO feature_flags (\`key\`, name, description, enabled, rollout_percent)
     VALUES (?, 'Enterprise Relay', 'On-prem relay (smoke)', 1, 100)
     ON DUPLICATE KEY UPDATE enabled = 1, rollout_percent = 100`,
    [FLAG_KEY],
  );
  console.log(`flag ${FLAG_KEY} => ON (prior: ${prior ? `enabled=${prior.enabled} rollout=${prior.rollout_percent}` : "no row"})`);

  // ─── Admin identity ────────────────────────────────────────────────
  const [[admin]] = await conn.query("SELECT id, username FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  if (!admin) throw new Error("no admin user in DB — sign up in the app first (first user becomes admin)");
  const adminToken = await mintAdminToken(admin.id, admin.username ?? "admin");
  const adminHeaders = { "content-type": "application/json", "x-local-auth-token": adminToken };

  // ─── Negative: bogus relay token rejected ──────────────────────────
  const badPoll = await fetch(`${BASE}/api/relay/poll?wait=0`, { headers: { authorization: "Bearer bogus" } });
  check("poll with bogus relay token => 401", badPoll.status === 401, `status ${badPoll.status}`);

  // ─── Register relay ────────────────────────────────────────────────
  const reg = await fetch(`${BASE}/api/relay/register`, {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({ name: `smoke-relay-${Date.now().toString(36)}` }),
  });
  const regBody = reg.status === 201 ? await reg.json() : null;
  check("relay register (admin) => 201 + raw token + relayId",
    reg.status === 201 && !!regBody?.token && !!regBody?.relayId,
    `status ${reg.status}${regBody ? ` relayId=${regBody.relayId}` : ""}`);
  if (!regBody) throw new Error("relay registration failed — aborting");
  relayId = regBody.relayId;

  // ─── Spawn the real connector against localhost ────────────────────
  child = spawn(process.execPath, [CONNECTOR], {
    env: {
      ...process.env,
      CLOUD_URL: BASE,
      RELAY_TOKEN: regBody.token,
      LOCAL_URL: BASE, // relay executes the proxied call against the app itself
      POLL_WAIT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => childLog.push(...String(d).split("\n").filter(Boolean)));
  child.stderr.on("data", (d) => childLog.push(...String(d).split("\n").filter(Boolean)));
  const childExit = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  await sleep(500); // let the connector boot + first poll
  check("connector child process alive", child.exitCode === null, `pid=${child.pid}`);

  // ─── Enqueue an http_proxy request (admin) ─────────────────────────
  const enq = await fetch(`${BASE}/api/relay/enqueue`, {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({ relayId, kind: "http_proxy", payload: { method: "GET", path: "/api/health" } }),
  });
  const enqBody = enq.status === 201 ? await enq.json() : null;
  check("relay enqueue (admin) => 201 + requestId", enq.status === 201 && !!enqBody?.requestId,
    `status ${enq.status}${enqBody ? ` requestId=${enqBody.requestId}` : ""}`);
  if (!enqBody) throw new Error("enqueue failed — aborting");
  requestId = enqBody.requestId;

  // ─── Wait for the connector to complete it ─────────────────────────
  const deadline = Date.now() + WAIT_COMPLETE_MS;
  let row = null;
  while (Date.now() < deadline) {
    const [[r]] = await conn.query(
      "SELECT status, result_json, error FROM relay_requests WHERE id = ?", [requestId]);
    if (r && (r.status === "completed" || r.status === "failed")) { row = r; break; }
    await sleep(500);
  }
  check("request completed by connector within timeout", row?.status === "completed",
    row ? `status=${row.status}${row.error ? ` error=${row.error}` : ""}` : "still pending/claimed after 45s");

  let result = null;
  try { result = typeof row?.result_json === "string" ? JSON.parse(row.result_json) : row?.result_json; } catch { /* shape */ }
  check("result is GET /api/health => HTTP 200 + status ok",
    result?.status === 200 && result?.json?.status === "ok",
    result ? `status=${result.status} body=${JSON.stringify(result.json ?? result.text ?? null).slice(0, 120)}` : "no result");

  check("connector logged job completion",
    childLog.some((l) => l.includes('"job completed"') || l.includes("job completed")),
    childLog.length ? `${childLog.length} log line(s)` : "no child output captured");

  child.kill("SIGTERM");
  await Promise.race([childExit, sleep(3000)]);
  child = null;
} catch (err) {
  check("script completed without exception", false, err.message);
} finally {
  if (child) {
    child.kill("SIGKILL");
    child = null;
  }
  if (conn) {
    try {
      // Restore flag to its prior state (or OFF if the row was new).
      if (flagPrior) {
        await conn.query("UPDATE feature_flags SET enabled=?, rollout_percent=? WHERE `key`=?",
          [flagPrior.enabled, flagPrior.rollout_percent, FLAG_KEY]);
      } else {
        await conn.query("UPDATE feature_flags SET enabled=0, rollout_percent=0 WHERE `key`=?", [FLAG_KEY]);
      }
      console.log(`flag ${FLAG_KEY} restored`);
      if (KEEP) {
        console.log(`--keep: leaving relayId=${relayId} requestId=${requestId}`);
      } else {
        if (requestId) await conn.query("DELETE FROM relay_requests WHERE id=?", [requestId]);
        if (relayId) {
          await conn.query("DELETE FROM relay_requests WHERE relay_id=?", [relayId]);
          await conn.query("DELETE FROM relay_registrations WHERE id=?", [relayId]);
        }
        console.log("fixtures cleaned up");
      }
    } catch (err) {
      console.error(`cleanup/flag-restore failed (non-fatal): ${err.message}`);
    }
    await conn.end();
  }
}

if (fails.length) {
  console.error(`SMOKE FAILED: ${fails.join(", ")}`);
  process.exit(1);
}
console.log("SMOKE relay-loop OK");
