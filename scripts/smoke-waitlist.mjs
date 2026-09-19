// Wave W waitlist boot smoke — 2026-07-29.
// Verifies the public /api/waitlist contract against a running server:
// join → 201 {position, referralCode}; rejoin → 409 already_joined (same
// position+code); validation 400s; count reflects joins. Fixtures cleaned.
// Requires the app server already running on PORT (default 3000).
//   node scripts/smoke-waitlist.mjs
import mysql from "mysql2/promise";
import fs from "fs";

const envText = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const getEnv = (k) => (envText.match(new RegExp(`^${k}=["']?([^"'\\n]+)`, "m")) || [])[1] || "";
const DATABASE_URL = getEnv("DATABASE_URL");
const PORT = process.env.PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const check = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
};

const tag = Date.now().toString(36);
const emailA = `smoke-wl-a-${tag}@example.com`;
const emailB = `smoke-wl-b-${tag}@example.com`;
const db = await mysql.createConnection({ uri: DATABASE_URL });

const join = (body) => fetch(`${BASE}/api/waitlist/join`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

try {
  console.log("── join contract");
  let res = await join({ email: ` ${emailA.toUpperCase()} `, role: "creator", ref: null });
  check("join returns 201", res.status === 201, `got ${res.status}`);
  const a = await res.json();
  check("join returns position + referralCode", Number.isInteger(a.position) && /^[A-Za-z0-9_-]{8}$/.test(a.referralCode), JSON.stringify(a));
  const [dbRow] = await db.query("SELECT email, role FROM waitlist_entries WHERE referral_code=?", [a.referralCode]);
  check("email normalized (lowercase/trimmed) before storage", dbRow[0]?.email === emailA, dbRow[0]?.email ?? "");

  console.log("── duplicate handling");
  res = await join({ email: emailA, role: "user", ref: null });
  check("rejoin returns 409", res.status === 409, `got ${res.status}`);
  const dup = await res.json();
  check("409 carries already_joined + same position + same code",
    dup.error === "already_joined" && dup.position === a.position && dup.referralCode === a.referralCode, JSON.stringify(dup));

  console.log("── referral ref stored");
  res = await join({ email: emailB, role: "both", ref: a.referralCode });
  const b = await res.json();
  check("second join gets a later position", res.status === 201 && b.position > a.position, `a=${a.position} b=${b.position}`);
  const [refRow] = await db.query("SELECT ref FROM waitlist_entries WHERE referral_code=?", [b.referralCode]);
  check("ref recorded", refRow[0]?.ref === a.referralCode, refRow[0]?.ref ?? "");

  console.log("── validation");
  res = await join({ email: "not-an-email", role: "user" });
  check("invalid email → 400", res.status === 400 && (await res.json()).error === "invalid_email");
  res = await join({ email: `smoke-wl-c-${tag}@example.com`, role: "admin" });
  check("invalid role → 400", res.status === 400 && (await res.json()).error === "invalid_role");
  res = await fetch(`${BASE}/api/waitlist/join`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  // 6th request inside the 5/min per-IP window: 429 (limiter engaged) is as
  // valid as the 400 the handler returns in a fresh window.
  check("malformed JSON → 400 (or 429 rate-limited)", res.status === 400 || res.status === 429, `got ${res.status}`);

  console.log("── count");
  res = await fetch(`${BASE}/api/waitlist/count`);
  const count = await res.json();
  check("count returns claimed ≥ 2", res.status === 200 && count.claimed >= 2, JSON.stringify(count));
  check("count is cacheable", (res.headers.get("cache-control") ?? "").includes("max-age=60"));

  console.log("── CORS (marketing site origin)");
  const siteOrigin = "https://site.example";
  res = await fetch(`${BASE}/api/waitlist/join`, {
    method: "OPTIONS",
    headers: {
      origin: siteOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  check("preflight OPTIONS succeeds", res.status === 204 || res.status === 200, `got ${res.status}`);
  const acao = res.headers.get("access-control-allow-origin") ?? "";
  check("preflight allows the site origin", acao === "*" || acao === siteOrigin, acao || "<missing>");
  res = await fetch(`${BASE}/api/waitlist/count`, { headers: { origin: siteOrigin } });
  const acaoGet = res.headers.get("access-control-allow-origin") ?? "";
  check("GET carries allow-origin header", acaoGet === "*" || acaoGet === siteOrigin, acaoGet || "<missing>");

  console.log(`\n${passed} passed, ${failed} failed`);
} finally {
  await db.query("DELETE FROM waitlist_entries WHERE email IN (?, ?)", [emailA, emailB]).catch(() => {});
  await db.end();
  console.log("fixtures cleaned");
}
process.exit(failed > 0 ? 1 : 0);
