#!/usr/bin/env node
// DeeWaanAI local launcher (V3 spec, L2). Everything runs on THIS machine:
//   npx deewaanai
// Data lives in ~/.deewaanai (override the database location with
// SQLITE_PATH). Secrets are generated once and persisted there — they
// encrypt your stored LLM API keys and sign your local session, so they
// must survive restarts but never leave the machine.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

const home = process.env.SQLITE_PATH
  ? path.dirname(process.env.SQLITE_PATH)
  : path.join(os.homedir(), ".deewaanai");
fs.mkdirSync(home, { recursive: true });

const ENV_FILE = path.join(home, "env");
const PERSISTED_KEYS = ["APP_SECRET", "AI_SWARM_MASTER_KEY", "MARKETPLACE_MASTER_KEY"];

function loadPersisted() {
  try {
    return Object.fromEntries(
      fs.readFileSync(ENV_FILE, "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
    );
  } catch {
    return {};
  }
}

const persisted = loadPersisted();
let changed = false;
for (const key of PERSISTED_KEYS) {
  if (!persisted[key]) {
    persisted[key] = crypto.randomBytes(32).toString("hex");
    changed = true;
  }
}
if (changed) {
  fs.writeFileSync(ENV_FILE, Object.entries(persisted).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
}
for (const [k, v] of Object.entries(persisted)) {
  if (!process.env[k]) process.env[k] = v;
}

process.env.DB_DRIVER = process.env.DB_DRIVER || "sqlite";
process.env.NODE_ENV = process.env.NODE_ENV || "production";
process.env.APP_ID = process.env.APP_ID || "deewaanai-local";

// The bundled server resolves dist/public and db/migrations-sqlite relative
// to the working directory — pin it to the package root so `npx deewaanai`
// works from anywhere.
process.chdir(packageRoot);

await import(new URL("../dist/boot.js", import.meta.url).href).catch((err) => {
  console.error("DeeWaanAI failed to start:", err);
  process.exit(1);
});
