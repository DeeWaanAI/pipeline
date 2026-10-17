// Assemble the local-first npm package (V3 spec, L2) and produce a tarball.
// Layout mirrors the repo (dist/boot.js, dist/public, db/migrations-sqlite)
// because the bundled server resolves those paths relative to its cwd —
// the bin launcher chdirs into the package root before importing boot.js.
// Usage: node scripts/pack-local.mjs   (runs build:local first)
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const stage = join(root, "dist-pkg");

console.log("• building local bundle (build:local)…");
execSync("npm run build:local", { stdio: "inherit" });

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "bin"), { recursive: true });

cpSync(join(root, "packaging", "bin", "deewaanai.js"), join(stage, "bin", "deewaanai.js"));
cpSync(join(root, "dist", "boot.js"), join(stage, "dist", "boot.js"));
cpSync(join(root, "dist", "public"), join(stage, "dist", "public"), { recursive: true });
cpSync(join(root, "db", "migrations-sqlite"), join(stage, "db", "migrations-sqlite"), { recursive: true });

// Pin better-sqlite3 to the exact version the repo lockfile built against —
// the external require in boot.js resolves to this dependency.
const rootLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const pinned = rootLock["packages"]?.["node_modules/better-sqlite3"]?.version;
const pkg = JSON.parse(readFileSync(join(root, "packaging", "package.json"), "utf8"));
if (pinned) pkg.dependencies["better-sqlite3"] = pinned;
writeFileSync(join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

console.log(`• staging complete (better-sqlite3 ${pinned ?? "unpinned"})`);
const out = execSync("npm pack", { cwd: stage, encoding: "utf8" }).trim();
const tarball = join(stage, out);
console.log(`✅ packed: ${tarball}`);
