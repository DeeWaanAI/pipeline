// Phase 3 Enterprise boot smoke.
//   node scripts/smoke-enterprise.mjs flags    → ensure enterprise_sso/enterprise_relay rows exist (enabled=0)
//   node scripts/smoke-enterprise.mjs off      → SSO + relay endpoints 404 when flags off
//   node scripts/smoke-enterprise.mjs on       → enable flags; SSO lookup + authorize, relay round-trip,
//                                                signed audit ledger, MCP per-customer 429 burst
//   node scripts/smoke-enterprise.mjs disable  → set both flags back to 0 (rollout control)
// Requires the app server running on PORT (default 3000) for off/on phases.
import { createHash, randomBytes, createHmac } from "crypto";
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

const conn = await mysql.createConnection({ uri: DATABASE_URL, multipleStatements: true });

async function setFlags(enabled) {
  for (const key of ["enterprise_sso", "enterprise_relay"]) {
    await conn.query(
      `INSERT INTO feature_flags (\`key\`, name, description, enabled, rollout_percent)
       VALUES (?, ?, 'Phase 3 enterprise', ?, 0)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), rollout_percent = ?`,
      [key, key, enabled, enabled ? 100 : 0],
    );
  }
  console.log(`enterprise flags => ${enabled ? "ON" : "OFF"}`);
}

function mintLocalToken(userId, username) {
  const key = new TextEncoder().encode(APP_SECRET);
  return new SignJWT({ userId, username, type: "local" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("600s").sign(key);
}

function mintMcpToken(userId) {
  const key = createHash("sha256").update(APP_SECRET).digest();
  return new SignJWT({ scope: "mcp:read mcp:run mcp:write team:read team:write", client_id: "smoke-enterprise" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(String(userId))
    .setIssuer("deewaanai").setIssuedAt().setExpirationTime("600s").sign(key);
}

const fails = [];
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) fails.push(name);
};

if (phase === "flags" || phase === "disable") {
  await setFlags(0);
  await conn.end();
  process.exit(0);
}

if (phase === "off") {
  const sso = await fetch(`${BASE}/api/sso/lookup?domain=example.com`);
  check("flag OFF: /api/sso/lookup => 404", sso.status === 404, `status ${sso.status}`);
  const relay = await fetch(`${BASE}/api/relay/poll?wait=0`);
  check("flag OFF: /api/relay/poll => 404", relay.status === 404, `status ${relay.status}`);
} else if (phase === "on") {
  await setFlags(1);

  // ── fixtures ────────────────────────────────────────────────────
  const [[admin]] = await conn.query("SELECT id, username FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  const [[user]] = await conn.query("SELECT id, username FROM users WHERE role='user' ORDER BY id LIMIT 1");
  if (!admin) throw new Error("no admin user in DB — cannot smoke admin endpoints");
  const adminToken = await mintLocalToken(admin.id, admin.username ?? "admin");
  await conn.query(
    `INSERT INTO sso_connections (type, domain, display_name, enabled, oidc_issuer, oidc_client_id)
     VALUES ('oidc', 'smoke-enterprise.test', 'Smoke IdP', 1, 'https://issuer.invalid', 'smoke-client')
     ON DUPLICATE KEY UPDATE enabled = 1, oidc_issuer = VALUES(oidc_issuer)`,
  );

  // ── SSO ─────────────────────────────────────────────────────────
  const lookup = await fetch(`${BASE}/api/sso/lookup?domain=smoke-enterprise.test`);
  const lookupBody = lookup.status === 200 ? await lookup.json() : null;
  check("SSO lookup finds seeded connection", lookup.status === 200 && lookupBody?.sso === true,
    `${lookup.status} ${JSON.stringify(lookupBody)}`);
  const authz = await fetch(`${BASE}/api/sso/oidc/authorize?connectionId=${lookupBody?.connectionId ?? 0}`, { redirect: "manual" });
  check("SSO oidc/authorize => 302 (IdP or localized error redirect)", authz.status === 302,
    `location: ${authz.headers.get("location")}`);

  // ── Relay round-trip ────────────────────────────────────────────
  const reg = await fetch(`${BASE}/api/relay/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-local-auth-token": adminToken },
    body: JSON.stringify({ name: "smoke-relay" }),
  });
  const regBody = (reg.status === 200 || reg.status === 201) ? await reg.json() : null;
  check("relay register (admin) => raw token + relayId", (reg.status === 200 || reg.status === 201) && !!regBody?.token && !!regBody?.relayId,
    `${reg.status} ${regBody ? `relayId=${regBody.relayId}` : await reg.text()}`);

  if (regBody) {
    const relayAuth = { Authorization: `Bearer ${regBody.token}` };
    const idle = await fetch(`${BASE}/api/relay/poll?wait=1`, { headers: relayAuth });
    check("relay poll idle => 204", idle.status === 204, `status ${idle.status}`);

    const enq = await fetch(`${BASE}/api/relay/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-local-auth-token": adminToken },
      body: JSON.stringify({ relayId: regBody.relayId, kind: "http_proxy", payload: { method: "GET", path: "/api/health" } }),
    });
    check("relay enqueue (admin)", enq.status === 200 || enq.status === 201, `status ${enq.status}`);

    const claimed = await fetch(`${BASE}/api/relay/poll?wait=1`, { headers: relayAuth });
    const claimedBody = claimed.status === 200 ? await claimed.json() : null;
    check("relay poll claims pending request", claimed.status === 200 && claimedBody?.kind === "http_proxy",
      `${claimed.status} ${JSON.stringify(claimedBody)?.slice(0, 100)}`);

    const done = await fetch(`${BASE}/api/relay/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...relayAuth },
      body: JSON.stringify({ requestId: claimedBody?.requestId ?? claimedBody?.id, result: { status: 200, json: { ok: true } } }),
    });
    check("relay result completes request", done.status === 200, `status ${done.status}`);
    const [[row]] = await conn.query(
      "SELECT status FROM relay_requests ORDER BY id DESC LIMIT 1");
    check("relay request marked completed in DB", row?.status === "completed", `status=${row?.status}`);
  }

  // ── Signed audit ledger (tRPC admin query procedure) ────────────
  const ledgerRes = await fetch(
    `${BASE}/api/trpc/export.auditLedgerJson?input=${encodeURIComponent(JSON.stringify({ json: {} }))}`,
    { headers: { "x-local-auth-token": adminToken } },
  );
  const ledgerText = await ledgerRes.text();
  let envelope = null;
  try { envelope = JSON.parse(ledgerText)?.result?.data?.json; } catch { /* shape differs */ }
  check("audit ledger => signed envelope", ledgerRes.status === 200 && !!envelope?.signature && envelope.algorithm === "HMAC-SHA256",
    `${ledgerRes.status} ${envelope ? `sections: ${Object.keys(envelope.payload?.sections ?? envelope.payload ?? {}).length}` : ledgerText.slice(0, 120)}`);

  // ── MCP per-customer rate limit (solo tier: burst > 60/min) ─────
  const mcpToken = await mintMcpToken(user.id);
  let seen429 = false, retryAfter = null;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${mcpToken}`,
  };
  const burst = Array.from({ length: 80 }, (_, i) =>
    fetch(`${BASE}/mcp`, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "burst", version: "0" } } }),
    }).then((r) => { if (r.status === 429) { seen429 = true; retryAfter = r.headers.get("retry-after"); } return r.status; }),
  );
  const statuses = await Promise.all(burst);
  check("MCP rate limit: 429 + Retry-After after solo burst", seen429 && retryAfter !== null,
    `200s=${statuses.filter((s) => s === 200).length} 429s=${statuses.filter((s) => s === 429).length} retryAfter=${retryAfter}`);
} else {
  console.error("unknown phase", phase);
  await conn.end();
  process.exit(2);
}

await conn.end();
if (fails.length) {
  console.error(`SMOKE FAILED: ${fails.join(", ")}`);
  process.exit(1);
}
console.log(`SMOKE ${phase} OK`);
