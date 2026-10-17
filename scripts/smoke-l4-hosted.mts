// L4 gate (V3 spec): a marketplace-only deployment REFUSES execution and
// keeps the marketplace intact. Boots one instance with
// HOSTED_MARKETPLACE_ONLY=true and asserts:
//   1. /api/public-config reports marketplaceOnly
//   2. swarm.execute is refused with the "runs locally" pointer
//   3. /mcp tools/list exposes marketplace tools but NO execution tools
//   4. marketplace browse (public) still answers
//   5. the device-link endpoint still works (linking is not execution)
// and a control instance without the flag still exposes run_pipeline.
// Usage: npm run build:local && npx tsx scripts/smoke-l4-hosted.mts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";

const FLAG_PORT = 3411;
const CTRL_PORT = 3412;

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function boot(port: number, extra: Record<string, string>): Promise<{ child: ChildProcess; home: string }> {
  const home = mkdtempSync(join(tmpdir(), `deewaanai-l4-${port}-`));
  const child = spawn("node", ["dist/boot.js"], {
    env: {
      PATH: process.env.PATH!, HOME: home, PORT: String(port),
      DB_DRIVER: "sqlite", SQLITE_PATH: join(home, ".deewaanai", "deewaanai.db"),
      NODE_ENV: "production", APP_SECRET: `s-${port}`, APP_ID: "smoke",
      AI_SWARM_MASTER_KEY: `k-${port}`, MARKETPLACE_MASTER_KEY: `m-${port}`,
      REDIS_URL: "", START_WORKER: "false",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait for the banner (auth_token line).
  await new Promise<void>((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`boot timeout:\n${out}`)), 60_000);
    child.stdout?.on("data", (d) => {
      out += String(d);
      if (out.includes("auth_token=")) { clearTimeout(t); resolve(); }
    });
    child.stderr?.on("data", (d) => { out += String(d); });
    child.on("exit", (c) => { clearTimeout(t); reject(new Error(`exited ${c}:\n${out}`)); });
  });
  return { child, home };
}

// MCP speaks OAuth Bearer JWTs keyed off APP_SECRET (tokenService.ts) —
// the smoke mints one directly for the instance's owner (user id 1).
async function mcpBearer(port: number): Promise<string> {
  const key = createHash("sha256").update(`s-${port}`).digest();
  return new SignJWT({ scope: "mcp:read mcp:write mcp:run", client_id: "smoke" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("1").setIssuer("deewaanai").setIssuedAt().setExpirationTime("300s")
    .sign(key);
}

async function mcpCall(port: number, token: string, method: string, id: number, sessionId?: string, extra?: object) {
  return fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: extra ?? {} }),
  });
}

// The server answers as SSE (text/event-stream) — pull the data: payload.
async function readMcp(res: Response): Promise<any> {
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const raw = dataLine ? dataLine.slice(5).trim() : text;
  return JSON.parse(raw);
}

async function mcpTools(port: number, token: string): Promise<string[]> {
  const init = await mcpCall(port, token, "initialize", 1, undefined, {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  const sessionId = init.headers.get("mcp-session-id") ?? undefined;
  await mcpCall(port, token, "notifications/initialized", 2, sessionId);
  const res = await mcpCall(port, token, "tools/list", 3, sessionId);
  const body = await readMcp(res);
  if (!res.ok || !body?.result?.tools) fail(`tools/list failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  return body.result.tools.map((t: { name: string }) => t.name);
}

async function main() {
  const flagged = await boot(FLAG_PORT, { HOSTED_MARKETPLACE_ONLY: "true" });
  let control: { child: ChildProcess; home: string } | undefined;
  try {
    const base = `http://localhost:${FLAG_PORT}`;
    const token = readFileSync(join(flagged.home, ".deewaanai", "auth-token"), "utf8").trim();

    const cfg = await fetch(`${base}/api/public-config`).then((r) => r.json()) as { marketplaceOnly?: boolean };
    if (cfg.marketplaceOnly !== true) fail(`public-config: ${JSON.stringify(cfg)}`);
    console.log("✔ public-config reports marketplaceOnly");

    const exec = await fetch(`${base}/api/trpc/swarm.execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-local-auth-token": token },
      body: JSON.stringify({ json: { projectId: 1, prompt: "hi" } }),
    });
    const execBody = await exec.json().catch(() => null) as { error?: { json?: { message?: string } } } | null;
    const msg = execBody?.error?.json?.message ?? "";
    if (!msg.includes("no longer runs pipelines")) fail(`swarm.execute not refused correctly: ${msg || exec.status}`);
    console.log("✔ swarm.execute refused with the local-install pointer");

    const tools = await mcpTools(FLAG_PORT, await mcpBearer(FLAG_PORT));
    if (!tools.includes("search_marketplace") || !tools.includes("fork_pipeline")) {
      fail(`marketplace tools missing: ${tools.join(",")}`);
    }
    for (const banned of ["run_pipeline", "design_pipeline", "add_llm_provider", "create_pipeline"]) {
      if (tools.includes(banned)) fail(`execution tool still exposed: ${banned}`);
    }
    console.log(`✔ /mcp exposes ${tools.length} marketplace tools, zero execution tools`);

    const list = await fetch(`${base}/api/trpc/marketplace.list?input=${encodeURIComponent(JSON.stringify({ json: {} }))}`);
    if (!list.ok) fail(`marketplace.list HTTP ${list.status}`);
    console.log("✔ marketplace browse intact");

    const code = await fetch(`${base}/api/device/code`, { method: "POST" });
    if (!code.ok) fail(`device code HTTP ${code.status}`);
    console.log("✔ device linking intact");

    // Control: same build without the flag must still expose execution tools.
    control = await boot(CTRL_PORT, {});
    const ctrlToken = readFileSync(join(control.home, ".deewaanai", "auth-token"), "utf8").trim();
    const ctrlTools = await mcpTools(CTRL_PORT, await mcpBearer(CTRL_PORT));
    if (!ctrlTools.includes("run_pipeline")) fail("control instance lost run_pipeline");
    const ctrlCfg = await fetch(`http://localhost:${CTRL_PORT}/api/public-config`).then((r) => r.json()) as { marketplaceOnly?: boolean };
    if (ctrlCfg.marketplaceOnly !== false) fail("control public-config not false");
    console.log("✔ control instance unchanged (run_pipeline present)");

    console.log("\n✅ L4 hosted strip-down PASSED");
  } finally {
    flagged.child.kill("SIGKILL");
    control?.child.kill("SIGKILL");
    rmSync(flagged.home, { recursive: true, force: true });
    if (control) rmSync(control.home, { recursive: true, force: true });
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
