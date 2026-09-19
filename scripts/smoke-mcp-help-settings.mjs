// MCP help + settings tools smoke (deewaanai_help / get_settings /
// set_default_model / suggest_llm_providers / add_provider + the sampling probe).
//   DATABASE_URL=... APP_SECRET=... PORT=8899 node scripts/smoke-mcp-help-settings.mjs
// Requires the app server running on PORT and a migrated database.
// Creates throwaway users (standard + pro_auto), exercises the tools over
// the real MCP streamable-HTTP transport, then removes all fixtures.
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
  return new SignJWT({ scope: "mcp:read mcp:run mcp:write", client_id: "smoke-help-settings" })
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

// capabilities: pass { sampling: {} } to simulate a sampling-capable client
async function initSession(token, capabilities = {}) {
  const r = await rpc(token, null, "initialize", {
    protocolVersion: "2025-03-26", capabilities, clientInfo: { name: "smoke-help-settings", version: "0" },
  });
  return r.session;
}

function toolResult(r) {
  if (r.payload?.error) return { error: r.payload.error.message ?? JSON.stringify(r.payload.error) };
  const content = r.payload?.result?.content;
  const text = Array.isArray(content) ? content.find((c) => c.type === "text")?.text : null;
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  const isError = Boolean(r.payload?.result?.isError);
  return { error: isError ? (typeof data === "string" ? data : JSON.stringify(data)) : null, data };
}

const ts = Date.now();
let userStdId, userAutoId, providerRowId, addedProviderId, flagCreated = false;

try {
  // ─── Fixtures ───
  const [rs] = await conn.query(
    `INSERT INTO users (username, password_hash, tier) VALUES (?, 'smoke', 'standard')`,
    [`mcp-smoke-std-${ts}`],
  );
  userStdId = rs.insertId;
  const [ra] = await conn.query(
    `INSERT INTO users (username, password_hash, tier) VALUES (?, 'smoke', 'pro_auto')`,
    [`mcp-smoke-auto-${ts}`],
  );
  userAutoId = ra.insertId;
  const tokenStd = await mintMcpToken(userStdId);
  const tokenAuto = await mintMcpToken(userAutoId);
  const sessStd = await initSession(tokenStd);
  const sessAuto = await initSession(tokenAuto);
  const sessAutoSampling = await initSession(tokenAuto, { sampling: {} });

  // ─── tools/list includes all expected tools ───
  const list = await rpc(tokenStd, sessStd, "tools/list", {});
  const names = (list.payload?.result?.tools ?? []).map((t) => t.name);
  for (const t of ["deewaanai_help", "get_settings", "set_default_model", "suggest_llm_providers", "add_provider"]) {
    check(`tools/list includes ${t}`, names.includes(t));
  }

  // ─── suggest_llm_providers: returns curated list with free-tier options ───
  const suggest = toolResult(await rpc(tokenStd, sessStd, "tools/call", {
    name: "suggest_llm_providers", arguments: {},
  }));
  check("suggest_llm_providers: returns curated list",
    !suggest.error && suggest.data?.count > 0 && suggest.data?.quickPick?.length > 0,
    suggest.error ?? String(suggest.data?.count));
  check("suggest_llm_providers: gemini is in the list",
    (suggest.data?.providers ?? []).some((p) => p.slug === "gemini"),
    (suggest.data?.providers ?? []).map((p) => p.slug).join(","));

  // ─── add_provider: rejects unknown slug ───
  const badSlug = toolResult(await rpc(tokenAuto, sessAuto, "tools/call", {
    name: "add_provider", arguments: { slug: "fake-provider", apiKey: "key123" },
  }));
  check("add_provider: unknown slug rejected",
    !!badSlug.error && /Unknown provider slug/.test(badSlug.error),
    badSlug.error?.slice(0, 80));

  // ─── help: standard user sees manual-authoring path, not design ───
  const helpStd = toolResult(await rpc(tokenStd, sessStd, "tools/call", {
    name: "deewaanai_help", arguments: {},
  }));
  const stdTools = helpStd.data?.sections?.flatMap((s) => s.tools.map((t) => t.name)) ?? [];
  check("help: standard tier reported", !helpStd.error && helpStd.data?.tier === "standard",
    helpStd.error ?? helpStd.data?.tier);
  check("help: standard sees create_pipeline, not design_pipeline",
    stdTools.includes("create_pipeline") && !stdTools.includes("design_pipeline"),
    stdTools.join(","));
  check("help: no team tools without flag", !stdTools.some((n) => n.startsWith("team_")));

  // ─── help: pro_auto sees design_pipeline and gets no-provider tip ───
  const helpAuto = toolResult(await rpc(tokenAuto, sessAuto, "tools/call", {
    name: "deewaanai_help", arguments: {},
  }));
  const autoTools = helpAuto.data?.sections?.flatMap((s) => s.tools.map((t) => t.name)) ?? [];
  check("help: pro_auto sees design_pipeline",
    !helpAuto.error && autoTools.includes("design_pipeline"), helpAuto.error ?? "");
  check("help: pro_auto without provider gets the add-provider tip",
    helpAuto.data?.tips?.some((t) => t.includes("No LLM provider is configured")) === true,
    (helpAuto.data?.tips ?? []).join(" | ").slice(0, 120));

  // ─── get_settings: empty providers, sampling probe false ───
  const settings1 = toolResult(await rpc(tokenAuto, sessAuto, "tools/call", {
    name: "get_settings", arguments: {},
  }));
  check("get_settings: tier + empty providers + sampling=false",
    !settings1.error && settings1.data?.tier === "pro_auto"
      && Array.isArray(settings1.data?.providers) && settings1.data.providers.length === 0
      && settings1.data?.desktopLlm?.clientSupportsSampling === false,
    settings1.error ?? JSON.stringify(settings1.data?.desktopLlm));

  // ─── sampling-capable session reports true ───
  const settings2 = toolResult(await rpc(tokenAuto, sessAutoSampling, "tools/call", {
    name: "get_settings", arguments: {},
  }));
  check("get_settings: sampling-capable client reports true",
    !settings2.error && settings2.data?.desktopLlm?.clientSupportsSampling === true,
    settings2.error ?? JSON.stringify(settings2.data?.desktopLlm));

  // ─── set_default_model: writes and round-trips ───
  const setModel = toolResult(await rpc(tokenAuto, sessAuto, "tools/call", {
    name: "set_default_model", arguments: { model: "gemini-2.0-flash" },
  }));
  check("set_default_model: updates defaultModel",
    !setModel.error && setModel.data?.defaultModel === "gemini-2.0-flash",
    setModel.error ?? String(setModel.data?.defaultModel));

  // ─── set_default_model: foreign/unknown provider rejected ───
  const badProvider = toolResult(await rpc(tokenAuto, sessAuto, "tools/call", {
    name: "set_default_model", arguments: { model: "x", providerId: 999999 },
  }));
  check("set_default_model: unknown providerId rejected",
    !!badProvider.error && /not one of your configured providers/.test(badProvider.error),
    badProvider.error?.slice(0, 80));

  // ─── mcp_sampling flag ON: sample_ping appears; help shows Diagnostics ───
  await conn.query(
    `INSERT INTO feature_flags (\`key\`, name, description, enabled, rollout_percent)
     VALUES ('mcp_sampling', 'MCP Sampling', 'smoke', 1, 100)
     ON DUPLICATE KEY UPDATE enabled = 1, rollout_percent = 100`,
  );
  flagCreated = true;
  process.stdout.write("waiting 65s for the app's flag cache (60s TTL) to refresh... ");
  await new Promise((r) => setTimeout(r, 65000));
  console.log("done");

  const sessStdFlag = await initSession(tokenStd);
  const listFlag = await rpc(tokenStd, sessStdFlag, "tools/list", {});
  const namesFlag = (listFlag.payload?.result?.tools ?? []).map((t) => t.name);
  check("flag on: sample_ping visible in tools/list (new session)", namesFlag.includes("sample_ping"));

  const helpFlag = toolResult(await rpc(tokenStd, sessStd, "tools/call", {
    name: "deewaanai_help", arguments: {},
  }));
  const flagTools = helpFlag.data?.sections?.flatMap((s) => s.tools.map((t) => t.name)) ?? [];
  check("flag on: help lists sample_ping under Diagnostics", flagTools.includes("sample_ping"));

  // ─── flag ON but client WITHOUT sampling: design falls back to provider path ───
  const designFallback = toolResult(await rpc(tokenAuto, sessAuto, "tools/call", {
    name: "design_pipeline", arguments: { name: `smoke-fallback-${ts}`, task: "Draft and polish a memo" },
  }));
  check("flag on + no sampling: design uses provider path (chatFn not used)",
    !!designFallback.error && /No LLM provider configured/.test(designFallback.error),
    designFallback.error?.slice(0, 90));

  // ─── set_default_model: own provider accepted (raw SQL insert) ───
  const [rp] = await conn.query(
    `INSERT INTO llm_providers (user_id, name, slug, base_url, api_key_ref, default_model)
     VALUES (?, 'smoke-gemini', 'gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'smoke-ref', 'gemini-2.0-flash')`,
    [userAutoId],
  );
  providerRowId = rp.insertId;
  const setBoth = toolResult(await rpc(tokenAuto, sessAuto, "tools/call", {
    name: "set_default_model", arguments: { model: "gemini-2.0-flash-lite", providerId: providerRowId },
  }));
  check("set_default_model: model + own provider stored",
    !setBoth.error && setBoth.data?.defaultModel === "gemini-2.0-flash-lite"
      && setBoth.data?.defaultProviderId === providerRowId
      && setBoth.data?.providers?.length === 1,
    setBoth.error ?? JSON.stringify({ m: setBoth.data?.defaultModel, p: setBoth.data?.defaultProviderId }));

  // ─── get_settings never leaks the API key ref ───
  const settings3 = toolResult(await rpc(tokenAuto, sessAuto, "tools/call", {
    name: "get_settings", arguments: {},
  }));
  check("get_settings: api_key_ref never exposed",
    !settings3.error && !JSON.stringify(settings3.data).includes("smoke-ref"));

  // ─── add_provider: creates a real provider from chat ───
  const addProv = toolResult(await rpc(tokenAuto, sessAuto, "tools/call", {
    name: "add_provider", arguments: { slug: "deepseek", apiKey: "fake-deepseek-key-for-smoke", defaultModel: "deepseek-chat" },
  }));
  check("add_provider: creates deepseek provider",
    !addProv.error && addProv.data?.slug === "deepseek" && addProv.data?.defaultModel === "deepseek-chat",
    addProv.error ?? JSON.stringify(addProv.data));
  addedProviderId = addProv.data?.id ?? null;

  // After adding a provider, get_settings shows it and help tip disappears
  const settingsAfterAdd = toolResult(await rpc(tokenAuto, sessAuto, "tools/call", {
    name: "get_settings", arguments: {},
  }));
  check("get_settings: shows newly added provider",
    !settingsAfterAdd.error && settingsAfterAdd.data?.providers?.some((p) => p.id === addedProviderId),
    settingsAfterAdd.error ?? JSON.stringify(settingsAfterAdd.data?.providers));
  check("get_settings: never leaks api_key_ref after add",
    !settingsAfterAdd.error && !JSON.stringify(settingsAfterAdd.data).includes("fake-deepseek-key"));

  const helpAfterAdd = toolResult(await rpc(tokenAuto, sessAuto, "tools/call", {
    name: "deewaanai_help", arguments: {},
  }));
  check("help: no-provider tip disappears after add_provider",
    !helpAfterAdd.data?.tips?.some((t) => t.includes("No LLM provider is configured")),
    (helpAfterAdd.data?.tips ?? []).join(" | ").slice(0, 120));
} finally {
  // ─── Cleanup fixtures ───
  const [strayProjects] = await conn.query(
    `SELECT id FROM projects WHERE user_id IN (?, ?)`, [userStdId ?? 0, userAutoId ?? 0],
  );
  for (const p of strayProjects) {
    await conn.query(`DELETE FROM pipeline_steps WHERE project_id = ?`, [p.id]);
    await conn.query(`DELETE FROM pipeline_templates WHERE source_project_id = ?`, [p.id]);
    await conn.query(`DELETE FROM projects WHERE id = ?`, [p.id]);
  }
  if (addedProviderId) await conn.query(`DELETE FROM llm_providers WHERE id = ?`, [addedProviderId]);
  if (providerRowId) await conn.query(`DELETE FROM llm_providers WHERE id = ?`, [providerRowId]);
  if (flagCreated) await conn.query(`DELETE FROM feature_flags WHERE \`key\` = 'mcp_sampling'`);
  if (userStdId) await conn.query(`DELETE FROM users WHERE id = ?`, [userStdId]);
  if (userAutoId) await conn.query(`DELETE FROM users WHERE id = ?`, [userAutoId]);
  await conn.end();
}

console.log(fails.length ? `\n${fails.length} FAILURES` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
