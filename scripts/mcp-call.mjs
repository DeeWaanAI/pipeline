// Minimal MCP streamable-HTTP client for DeeWaanAI testing.
// usage: node scripts/mcp-call.mjs <toolName> '<jsonArgs>'
//        node scripts/mcp-call.mjs --list
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://deewaanai-production.up.railway.app/mcp";
const TOKEN_URL = "https://deewaanai-production.up.railway.app/oauth/token";
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_FILE = path.join(DIR, ".deewaanai-test-token.json");
const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));

async function refresh() {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", client_id: tokens.client_id, refresh_token: tokens.refresh_token }),
  });
  if (!res.ok) { console.error("refresh failed:", res.status, await res.text()); process.exit(1); }
  const fresh = await res.json();
  fresh.client_id = tokens.client_id;
  fresh.obtained_at = new Date().toISOString();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  return fresh.access_token;
}

let access_token = tokens.access_token;
// Proactively refresh if older than 50 minutes
if (Date.now() - new Date(tokens.obtained_at).getTime() > 50 * 60 * 1000) {
  access_token = await refresh();
}

let sessionId = null;
let id = 0;

async function rpc(method, params, isNotification = false) {
  const body = { jsonrpc: "2.0", method, params };
  if (!isNotification) body.id = ++id;
  const headers = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
    "authorization": `Bearer ${access_token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(BASE, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  if (isNotification || res.status === 202) return null;
  const text = await res.text();
  // Handle SSE-framed responses
  const dataLines = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  const payload = dataLines.length ? dataLines[dataLines.length - 1] : text;
  try { return JSON.parse(payload); } catch { return { raw: text, status: res.status }; }
}

await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "kimi-test", version: "1.0" },
});
await rpc("notifications/initialized", {}, true);

if (process.argv[2] === "--list") {
  const r = await rpc("tools/list", {});
  const tools = r?.result?.tools ?? [];
  console.log(tools.map((t) => t.name).join("\n"));
} else {
  const [name, argsJson] = [process.argv[2], process.argv[3] ?? "{}"];
  const r = await rpc("tools/call", { name, arguments: JSON.parse(argsJson) });
  console.log(JSON.stringify(r?.result ?? r, null, 2));
}
