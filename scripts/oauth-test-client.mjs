// Two-step OAuth 2.1 + PKCE client for DeeWaanAI MCP testing.
//   node scripts/oauth-test-client.mjs prepare   → registers client, prints consent URL
//   node scripts/oauth-test-client.mjs capture   → waits for callback, exchanges code, saves token
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://deewaanai-production.up.railway.app";
const PORT = 8797;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE = path.join(DIR, ".deewaanai-oauth-state.json");
const OUT = path.join(DIR, ".deewaanai-test-token.json");

const mode = process.argv[2];

if (mode === "prepare") {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const reg = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "kimi-test-client", redirect_uris: [REDIRECT_URI] }),
  });
  if (!reg.ok) { console.error("register failed:", reg.status, await reg.text()); process.exit(1); }
  const { client_id } = await reg.json();
  fs.writeFileSync(STATE, JSON.stringify({ client_id, verifier }), { mode: 0o600 });
  const url = new URL(`${BASE}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client_id);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "mcp:read mcp:run mcp:write");
  console.log(url.toString());
} else if (mode === "capture") {
  const { client_id, verifier } = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const code = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      if (u.pathname !== "/callback") { res.end("waiting"); return; }
      const c = u.searchParams.get("code");
      res.end(c ? "OK — you can close this tab and return to Kimi." : "error: " + u.searchParams.get("error"));
      srv.close();
      c ? resolve(c) : reject(new Error("access_denied"));
    });
    srv.listen(PORT, "127.0.0.1", () => console.log("listening on 127.0.0.1:" + PORT + " — waiting for your click..."));
    setTimeout(() => { srv.close(); reject(new Error("timeout")); }, 280_000);
  });
  const tok = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, client_id, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
  });
  if (!tok.ok) { console.error("token exchange failed:", tok.status, await tok.text()); process.exit(1); }
  const tokens = await tok.json();
  tokens.client_id = client_id;
  tokens.obtained_at = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log("SUCCESS — token saved. scopes:", tokens.scope);
} else {
  console.error("usage: node oauth-test-client.mjs prepare|capture");
  process.exit(1);
}
