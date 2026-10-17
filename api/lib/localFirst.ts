// ─── Local-first bootstrap (V3 spec, L1) ────────────────────────────
// A local install (DB_DRIVER=sqlite) has no signup screen and no hosted
// account: on first boot the server creates the owner account itself with
// an unguessable random password (password login is not the local UX) and
// signs a long-lived token. The token is written to <home>/auth-token
// (0600) so later starts can reprint the sign-in URL — the file is the
// credential, same trust model as SSH keys: anyone with local file access
// is already the owner of the machine.
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { count, eq } from "drizzle-orm";
import { users } from "@db/schema";
import { getDb } from "../queries/connection";
import { signLocalToken } from "../routers/localAuth";
import { env } from "./env";
import { logger } from "./logger";

export function isLocalFirst(): boolean {
  return env.dbDriver === "sqlite";
}

/** Directory holding the local install's data: the SQLite file's directory,
 *  or ~/.deewaanai when SQLITE_PATH is unset. */
export function localHomeDir(): string {
  if (env.sqlitePath) return dirname(env.sqlitePath);
  return join(homedir(), ".deewaanai");
}

const TOKEN_FILE = "auth-token";

export function readLocalToken(): string | null {
  try {
    const t = readFileSync(join(localHomeDir(), TOKEN_FILE), "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

export type ProvisionResult = {
  /** Token to print in the startup banner; null only in non-local mode. */
  token: string | null;
  /** True when this boot created the owner account (first run ever). */
  firstRun: boolean;
  homeDir: string;
};

/**
 * Create the local owner account on first run; on later runs, re-read the
 * stored token. Idempotent — safe to call on every boot.
 */
export async function provisionLocalOwnerIfFirstRun(): Promise<ProvisionResult> {
  if (!isLocalFirst()) return { token: null, firstRun: false, homeDir: "" };

  const home = localHomeDir();
  mkdirSync(home, { recursive: true });

  const db = getDb();
  const [row] = await db.select({ count: count() }).from(users);
  if ((row?.count ?? 0) > 0) {
    return { token: readLocalToken(), firstRun: false, homeDir: home };
  }

  const username = "owner";
  const randomPassword = crypto.randomBytes(24).toString("base64url");
  const passwordHash = await bcrypt.hash(randomPassword, 10);
  await db.insert(users).values({
    username,
    passwordHash,
    name: "Local Owner",
    role: "admin",
  });
  const [created] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!created) throw new Error("local-first: owner account creation failed");

  const token = await signLocalToken(created.id, username, "365d");
  const tokenPath = join(home, TOKEN_FILE);
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // best-effort on platforms without POSIX modes
  }
  logger.warn("[LOCAL-FIRST] First run: created the local owner account (admin). Sign in via the printed URL — no password needed.");
  return { token, firstRun: true, homeDir: home };
}

/** Plain-text startup banner for local installs (stdout, not the JSON
 *  logger — this is the installer's primary UX). */
export function printLocalFirstBanner(opts: {
  port: number;
  token: string | null;
  firstRun: boolean;
  homeDir: string;
}): void {
  const base = `http://localhost:${opts.port}`;
  const webUrl = opts.token ? `${base}/?auth_token=${opts.token}` : base;
  const lines = [
    "",
    "  ┌────────────────────────────────────────────────────────────",
    "  │ DeeWaanAI is running locally — your data never leaves this machine.",
    "  │",
    `  │  Web app (open this to sign in):`,
    `  │    ${webUrl}`,
    "  │",
    `  │  MCP URL (paste into your chat app):`,
    `  │    ${base}/mcp`,
    "  │",
    `  │  Data folder: ${opts.homeDir}`,
  ];
  if (!opts.token) {
    lines.push(
      "  │",
      "  │  (Sign-in token not found — delete the data folder to reset,",
      "  │   or check that auth-token exists in the data folder.)",
    );
  }
  if (opts.firstRun) {
    lines.push("  │", "  │  First run complete: your local owner account was created.");
  }
  lines.push("  └────────────────────────────────────────────────────────────", "");
  for (const line of lines) console.log(line);
}
