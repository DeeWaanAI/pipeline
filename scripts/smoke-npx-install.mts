// L2 gate (V3 spec): prove the packed tarball installs and runs on a machine
// WITHOUT the repo. Creates a throwaway dir, `npm install <tarball>` (fetches
// better-sqlite3 from the registry like a real user), boots `npx deewaanai`
// with a clean environment (no DATABASE_URL, no secrets, fresh HOME), and
// verifies: banner sign-in URL, health, token auth, and the SPA being served.
// Usage: node scripts/pack-local.mjs && npx tsx scripts/smoke-npx-install.mts
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";

const PORT = 3210;
const BASE = `http://localhost:${PORT}`;

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

const tarball = readdirSync("dist-pkg").find((f) => f.endsWith(".tgz"));
if (!tarball) fail("no tarball in dist-pkg — run node scripts/pack-local.mjs first");

async function waitForBanner(child: ChildProcess, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`timeout. Output:\n${out}`)), timeoutMs);
    child.stdout?.on("data", (d) => {
      out += String(d);
      if (out.includes("auth_token=")) { clearTimeout(timer); resolve(out); }
    });
    child.stderr?.on("data", (d) => { out += String(d); });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`exited (${code}). Output:\n${out}`)); });
  });
}

async function main() {
  const sandbox = mkdtempSync(join(tmpdir(), "deewaanai-l2-"));
  const home = join(sandbox, "home");
  console.log(`sandbox: ${sandbox}`);

  console.log("• npm install (registry fetch, like a real user)…");
  execSync(`npm install --prefix "${sandbox}" "${join(process.cwd(), "dist-pkg", tarball)}"`, { stdio: "pipe" });
  console.log("✔ installed from tarball");

  // Clean environment: only PATH/HOME/PORT — no repo env, no secrets.
  const child = spawn(join(sandbox, "node_modules", ".bin", "deewaanai"), [], {
    env: { PATH: process.env.PATH!, HOME: home, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: sandbox,
  });

  try {
    const banner = await waitForBanner(child);
    const m = banner.match(/http:\/\/localhost:\d+\/\?auth_token=(\S+)/);
    if (!m) fail("no sign-in URL in banner");
    console.log("✔ banner printed sign-in URL");

    const token = m[1].trim();
    const me = await fetch(`${BASE}/api/trpc/localAuth.me`, { headers: { "x-local-auth-token": token } });
    const body = await me.json() as { result?: { data?: { json?: { username?: string; role?: string } } } };
    if (body.result?.data?.json?.role !== "admin") fail(`auth failed: ${JSON.stringify(body)}`);
    console.log("✔ token authenticates as local owner (admin)");

    const health = await fetch(`${BASE}/api/health`).then((r) => r.json()) as { db?: string };
    if (health.db !== "connected") fail(`health db=${health.db}`);
    console.log("✔ health: db connected (sqlite file, zero setup)");

    const spa = await fetch(BASE);
    const html = await spa.text();
    if (!spa.ok || !html.includes("<")) fail("SPA not served");
    console.log("✔ web app served");

    console.log("\n✅ L2 clean-install smoke PASSED");
  } finally {
    child.kill("SIGKILL");
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
