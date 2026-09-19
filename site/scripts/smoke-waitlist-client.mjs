// ═══════════════════════════════════════════════════════════════════
//  WAITLIST CLIENT SMOKE — executes the REAL built inline script from
//  dist/index.html against a zero-dep mock of the Wave W contract
//  (api/waitlist-route.ts):  GET /count → {claimed}
//                            POST /join → 201 {position,referralCode}
//                                       → 409 {error:"already_joined",...}
//
//  Regression guard: the script is executed through Node's vm parser, so
//  a SyntaxError (e.g. top-level await inside Astro's non-async
//  define:vars IIFE — found 2026-07-29) fails the suite immediately.
//
//  Usage:
//    PUBLIC_WAITLIST_API_URL=http://127.0.0.1:8787/api/waitlist npm run build
//    node scripts/smoke-waitlist-client.mjs
// ═══════════════════════════════════════════════════════════════════
import http from "node:http";
import fs from "node:fs";
import vm from "node:vm";

const PORT = 8787;
const API = `http://127.0.0.1:${PORT}/api/waitlist`;

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

// ── Mock server (mirrors the real route's contract + dedupe) ──────
const entries = []; // {email, role, ref, referralCode}
let countHits = 0;
let failNextJoin = false;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === "/api/waitlist/count" && req.method === "GET") {
    countHits++;
    return json(200, { claimed: entries.length });
  }
  if (url.pathname === "/api/waitlist/join" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (failNextJoin) { failNextJoin = false; return json(500, { error: "boom" }); }
    const { email, role, ref } = JSON.parse(body);
    const existing = entries.find((e) => e.email === email);
    if (existing) {
      return json(409, {
        error: "already_joined",
        position: entries.indexOf(existing) + 1,
        referralCode: existing.referralCode,
      });
    }
    const referralCode = Math.random().toString(36).slice(2, 10);
    entries.push({ email, role, ref, referralCode });
    return json(201, { position: entries.length, referralCode });
  }
  json(404, { error: "not_found" });
});

// ── Browser stubs ──────────────────────────────────────────────────
function makeEl(id, hidden = false) {
  const set = new Set(hidden ? ["hidden"] : []);
  return {
    id, textContent: "", value: "", href: "", disabled: false, dataset: {},
    listeners: {},
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
    },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
  };
}

const IDS = ["wl-counter", "wl-ref", "wl-form", "wl-error", "wl-submit",
  "wl-email", "wl-role", "wl-position", "wl-ref-url", "wl-share-x",
  "wl-share-li", "wl-success", "wl-copy"];

function makePage({ search = "", storage }) {
  const els = Object.fromEntries(IDS.map((id) => [id, makeEl(id, ["wl-error", "wl-success"].includes(id))]));
  const page = {
    els,
    copied: null,
    location: { search, origin: "https://deewaanai.test" },
  };
  const sandbox = {
    document: { getElementById: (id) => els[id] ?? null },
    sessionStorage: storage.session,
    localStorage: storage.local,
    location: page.location,
    navigator: { clipboard: { writeText: async (t) => { page.copied = t; } } },
    URLSearchParams, URL, encodeURIComponent, JSON, Date, Math,
    setTimeout, console, fetch: globalThis.fetch,
  };
  page.run = (script) => vm.runInNewContext(script, sandbox, { filename: "waitlist-inline.js" });
  page.dispatch = async (id, type, event = {}) => {
    for (const fn of els[id].listeners[type] ?? []) await fn({ preventDefault() {}, ...event });
  };
  return page;
}

function storage() {
  const mk = () => { const m = new Map(); return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  }; };
  return { session: mk(), local: mk() };
}

async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

// ── Extract the built inline waitlist script ──────────────────────
const html = fs.readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const wlScript = scripts.find((s) => s.includes("wl-form"));

console.log("\nWaitlist client smoke (real built script vs mock contract)\n");

check("waitlist script present in dist (build had PUBLIC_WAITLIST_API_URL set)", !!wlScript);
if (!wlScript) { console.log("\nRebuild with: PUBLIC_WAITLIST_API_URL=http://127.0.0.1:8787/api/waitlist npm run build"); process.exit(1); }
check("script points at the mock API", wlScript.includes(`const apiUrl = "${API}"`));

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// Seed 41 entries so the next claim is #42.
for (let i = 0; i < 41; i++) entries.push({ email: `seed${i}@t.dev`, role: "user", ref: null, referralCode: `seed${i}` });
countHits = 0;

// ── Scenario A: first visit with ?ref=abc123 ──────────────────────
{
  const store = storage();
  const page = makePage({ search: "?ref=abc123", storage: store });
  page.run(wlScript); // SyntaxError here = regression (define:vars IIFE)
  const counted = await until(() => page.els["wl-counter"].textContent.includes("41"));
  check("counter fetched + rendered (41 of 100)", counted, `got "${page.els["wl-counter"].textContent}"`);
  check("count cached to sessionStorage", !!store.session.getItem("wl-count"));
  check("?ref= captured into hidden field", page.els["wl-ref"].value === "abc123");
  check("?ref= persisted to localStorage", store.local.getItem("wl-ref") === "abc123");

  // ── Scenario B: reload — cache hit (no new /count), ref restored ──
  const page2 = makePage({ search: "", storage: store });
  page2.run(wlScript);
  const counted2 = await until(() => page2.els["wl-counter"].textContent.includes("41"));
  check("reload renders counter from cache", counted2);
  check("cache hit → no second /count request", countHits === 1, `countHits=${countHits}`);
  check("ref restored from localStorage (no ?ref= in URL)", page2.els["wl-ref"].value === "abc123");

  // ── Scenario C: submit new email → 201 success flow ──
  page2.els["wl-email"].value = "pioneer@t.dev";
  page2.els["wl-role"].value = "creator";
  await page2.dispatch("wl-form", "submit");
  const ok = await until(() => !page2.els["wl-success"].classList.contains("hidden"));
  check("201 → success panel shown", ok);
  check("position rendered (#42)", page2.els["wl-position"].textContent.includes("42"), `got "${page2.els["wl-position"].textContent}"`);
  const refUrl = page2.els["wl-ref-url"].textContent;
  check("referral URL built (?ref=<code>)", /https:\/\/deewaanai\.test\/\?ref=.+/.test(refUrl), refUrl);
  check("X share link built", page2.els["wl-share-x"].href.startsWith("https://twitter.com/intent/tweet?text="));
  check("LinkedIn share link built", page2.els["wl-share-li"].href.startsWith("https://www.linkedin.com/sharing/share-offsite/"));
  check("form hidden after success", page2.els["wl-form"].classList.contains("hidden"));
  check("server received ref=abc123 attribution", entries.at(-1).ref === "abc123");
  check("server received role=creator", entries.at(-1).role === "creator");

  // ── Scenario D: duplicate email → 409 still treated as success ──
  const page3 = makePage({ search: "", storage: store });
  page3.run(wlScript);
  await until(() => page3.els["wl-counter"].textContent.length > 0);
  page3.els["wl-email"].value = "pioneer@t.dev";
  page3.els["wl-role"].value = "both";
  await page3.dispatch("wl-form", "submit");
  const ok3 = await until(() => !page3.els["wl-success"].classList.contains("hidden"));
  check("409 already_joined → success panel shown", ok3);
  check("409 returns original position (#42)", page3.els["wl-position"].textContent.includes("42"), `got "${page3.els["wl-position"].textContent}"`);
  check("no duplicate entry created server-side", entries.filter((e) => e.email === "pioneer@t.dev").length === 1);
  check("error panel stays hidden on 409", page3.els["wl-error"].classList.contains("hidden"));

  // ── Scenario E: server 500 → graceful error, button re-enabled ──
  const page4 = makePage({ search: "", storage: store });
  page4.run(wlScript);
  await until(() => page4.els["wl-counter"].textContent.length > 0);
  page4.els["wl-email"].value = "unlucky@t.dev";
  page4.els["wl-role"].value = "user";
  failNextJoin = true;
  await page4.dispatch("wl-form", "submit");
  const err = await until(() => !page4.els["wl-error"].classList.contains("hidden"));
  check("500 → generic error shown (never raw)", err && page4.els["wl-error"].textContent.length > 0);
  check("submit button re-enabled after failure", page4.els["wl-submit"].disabled === false);
  check("success panel NOT shown on failure", page4.els["wl-success"].classList.contains("hidden"));

  // ── Scenario F: copy referral link ──
  await page2.dispatch("wl-copy", "click");
  const copiedOk = await until(() => page2.copied !== null);
  check("copy button writes referral URL to clipboard", copiedOk && page2.copied === refUrl, `copied="${page2.copied}"`);
}

// ── Scenario G: count endpoint down → fallback text, no crash ─────
{
  await new Promise((r) => server.close(r));
  const page = makePage({ search: "", storage: storage() });
  page.run(wlScript);
  await new Promise((r) => setTimeout(r, 300)); // let the failed fetch settle
  check("count fetch failure → fallback text survives", page.els["wl-counter"].textContent.length === 0 || !page.els["wl-counter"].textContent.includes("NaN"));
}

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
