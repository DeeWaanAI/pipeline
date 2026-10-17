// Local-first first-run smoke (V3 L1 gate): boots the BUILT server
// (dist/boot.js) on a throwaway HOME with DB_DRIVER=sqlite and proves the
// whole first-run story end to end:
//   1. ~/.deewaanai-equivalent dir is created with the db + auth-token
//   2. auth-token is written with 0600 permissions
//   3. the startup banner prints a sign-in URL carrying ?auth_token=
//   4. that token authenticates against the live server (localAuth.me)
//   5. a SECOND boot reuses the account (no duplicate owner, same token)
// Usage:  npm run build && npx tsx scripts/smoke-first-run.mts
// Safe: everything happens under a fresh temp dir; nothing touches the repo
// DB or the real HOME.
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const PORT = 3199;
const BASE = `http://localhost:${PORT}`;

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function waitForBanner(child: ChildProcess, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for banner. Output so far:\n${out}`)), timeoutMs);
    child.stdout?.on("data", (d) => {
      out += String(d);
      if (out.includes("auth_token=")) {
        clearTimeout(timer);
        resolve(out);
      }
    });
    child.stderr?.on("data", (d) => { out += String(d); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}). Output:\n${out}`));
    });
  });
}

async function boot(home: string): Promise<{ child: ChildProcess; output: string }> {
  const child = spawn("node", ["dist/boot.js"], {
    env: {
      ...process.env,
      HOME: home,
      DB_DRIVER: "sqlite",
      SQLITE_PATH: join(home, ".deewaanai", "deewaanai.db"),
      NODE_ENV: "production",
      PORT: String(PORT),
      START_WORKER: "false",
      APP_SECRET: "smoke-secret-not-real",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = await waitForBanner(child);
  return { child, output };
}

async function stop(child: ChildProcess): Promise<void> {
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), "deewaanai-first-run-"));
  console.log(`throwaway HOME: ${home}`);
  try {
    // ── First boot ────────────────────────────────────────────────
    const first = await boot(home);
    const m = first.output.match(/http:\/\/localhost:\d+\/\?auth_token=(\S+)/);
    if (!m) fail("banner did not contain a sign-in URL with ?auth_token=");
    const token = m[1].trim();
    console.log("✔ banner printed a sign-in URL with a token");

    const tokenPath = join(home, ".deewaanai", "auth-token");
    const mode = statSync(tokenPath).mode & 0o777;
    if (mode !== 0o600) fail(`auth-token permissions are ${mode.toString(8)}, expected 600`);
    if (readFileSync(tokenPath, "utf8").trim() !== token) fail("auth-token file content != banner token");
    console.log("✔ auth-token file exists, mode 0600, matches banner");

    // Token authenticates against the live server.
    const me = await fetch(`${BASE}/api/trpc/localAuth.me`, {
      headers: { "x-local-auth-token": token },
    });
    if (!me.ok) fail(`localAuth.me HTTP ${me.status}`);
    const body = await me.json() as { result?: { data?: { json?: { username?: string; role?: string } } } };
    const user = body.result?.data?.json;
    if (user?.username !== "owner" || user?.role !== "admin") {
      fail(`unexpected localAuth.me payload: ${JSON.stringify(body)}`);
    }
    console.log("✔ token authenticates as the local owner (admin)");

    const health = await fetch(`${BASE}/api/health`).then((r) => r.json()) as { db?: string };
    if (health.db !== "connected") fail(`health db=${health.db}`);
    console.log("✔ health check: db connected");

    await stop(first.child);

    // ── Second boot: same account, same token, no duplicates ──────
    const second = await boot(home);
    const m2 = second.output.match(/auth_token=(\S+)/);
    if (!m2 || m2[1].trim() !== token) fail("second boot did not reprint the same token");
    console.log("✔ second boot reuses the same owner account and token");
    await stop(second.child);

    console.log("\n✅ L1 first-run smoke PASSED");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
