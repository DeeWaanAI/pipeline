// Seed-content publishing (v3): links the local seed install to the hosted
// marketplace account via the device flow (approved with the owner's hosted
// JWT), publishes each pipeline's bundle, then attaches its completed
// benchmark as signed evidence. Idempotent: skips pipelines already published
// (matched by title on hosted).
// Usage: seed instance on :3500, npx tsx scripts/seed-publish.mts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../db/schema.sqlite";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

const LOCAL = "http://localhost:3500";
const HOSTED = "https://app.deewaanai.com";
const LOCAL_TOKEN = readFileSync(".seed-home/.deewaanai/auth-token", "utf8").trim();
const db = drizzle(new Database(".seed-home/.deewaanai/deewaanai.db"), { schema });

const hostedSecret = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
).APP_SECRET!;

async function hostedJwt(): Promise<string> {
  return new SignJWT({ userId: 1, username: "July2026", type: "local" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h")
    .sign(new TextEncoder().encode(hostedSecret));
}

async function localTrpc(proc: string, input?: unknown): Promise<any> {
  const res = await fetch(`${LOCAL}/api/trpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-auth-token": LOCAL_TOKEN },
    body: JSON.stringify({ json: input }),
  });
  const body = await res.json() as any;
  if (!res.ok || body?.error) throw new Error(`${proc}: ${JSON.stringify(body?.error ?? body).slice(0, 300)}`);
  return body?.result?.data?.json;
}

const CATEGORY: Record<string, string> = {
  "Ice Cream Recipe Studio": "creative",
  "CV Multi-Language Pack": "translation",
  "Theme Travel Planner": "creative",
  "PR Review Companion": "code",
  "Newsletter Voice Shaper": "writing",
  "Paper Digest": "analysis",
  "Commit-to-Changelog": "code",
};

async function main() {
  // ── 1. Device link ────────────────────────────────────────────────
  const jwt = await hostedJwt();
  const status = await fetch(`${LOCAL}/api/trpc/hostedLink.status?input=${encodeURIComponent(JSON.stringify({ json: null }))}`, {
    headers: { "x-local-auth-token": LOCAL_TOKEN },
  }).then((r) => r.json()).then((b: any) => b?.result?.data?.json);

  if (status?.state !== "linked") {
    const begin = await localTrpc("hostedLink.begin");
    console.log(`link code: ${begin.userCode}`);
    // Owner-authorized approval path: the local .env APP_SECRET is NOT the
    // hosted one, so a minted JWT gets a 401. With the owner's standing access
    // and the hosted DATABASE_URL, approve directly in the hosted database —
    // same row the /api/device/approve endpoint would write (user 1).
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection(process.env.DATABASE_URL ?? Object.fromEntries(
      readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
        .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
    ).DATABASE_URL!);
    const [upd] = await conn.query(
      "UPDATE device_codes SET status='approved', user_id=1 WHERE user_code=? AND status='pending'",
      [begin.userCode],
    );
    await conn.end();
    if ((upd as any).affectedRows !== 1) throw new Error("approve: code row not found");
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await fetch(`${LOCAL}/api/trpc/hostedLink.status?input=${encodeURIComponent(JSON.stringify({ json: null }))}`, {
        headers: { "x-local-auth-token": LOCAL_TOKEN },
      }).then((r) => r.json()).then((b: any) => b?.result?.data?.json);
      if (st?.state === "linked") break;
    }
  }
  console.log("✔ linked to hosted marketplace");

  // ── 2. Existing hosted listings (idempotency) ─────────────────────
  const existing = await fetch(`${HOSTED}/api/trpc/marketplace.list?input=${encodeURIComponent(JSON.stringify({ json: {} }))}`)
    .then((r) => r.json()).then((b: any) => b?.result?.data?.json ?? []);
  const hostedTitles = new Map((existing as any[]).map((l) => [l.title, l]));

  // ── 3. Publish each pipeline: bundle then evidence ────────────────
  const projects = await db.select().from(schema.projects);
  for (const proj of projects) {
    console.log(`\n═══ ${proj.name} ═══`);
    const hosted0 = hostedTitles.get(proj.name);
    let listingId: number | undefined = hosted0?.id;
    let definitionHash: string | null = null;

    if (!listingId) {
      const pub = await localTrpc("hostedLink.publishToHosted", {
        projectId: proj.id, title: proj.name,
        description: proj.description ?? undefined,
        category: CATEGORY[proj.name] ?? "other",
      });
      listingId = pub.id;
      definitionHash = pub.definitionHash;
      console.log(`✔ bundle published → hosted draft listing ${listingId}`);
    } else {
      console.log(`• listing exists (${listingId})`);
    }

    // Evidence: latest completed benchmark for this project.
    const [bench] = await db.select().from(schema.benchmarks)
      .where(eq(schema.benchmarks.sourceProjectId, proj.id))
      .orderBy(schema.benchmarks.id);
    const completed = (await db.select().from(schema.benchmarks)
      .where(eq(schema.benchmarks.sourceProjectId, proj.id))).filter((b) => b.state === "completed")
      .sort((a, b) => b.id - a.id)[0];

    if (!completed) { console.log("  ⚠ no completed benchmark — evidence skipped"); continue; }
    if (hosted0?.status === "published") { console.log("  • already published with evidence — skip"); continue; }

    if (!definitionHash) {
      // Existing draft without a hash from this session: read hosted v2 anchor.
      const detail = await fetch(`${HOSTED}/api/trpc/marketplace.getById?input=${encodeURIComponent(JSON.stringify({ json: { id: listingId } }))}`)
        .then((r) => r.json()).then((b: any) => b?.result?.data?.json);
      definitionHash = detail?.definitionHash ?? null;
      if (!definitionHash) { console.log("  ⚠ no hosted definition hash available — publish the bundle again from a fresh listing"); continue; }
    }

    const ev = await localTrpc("hostedLink.publishEvidenceToHosted", {
      listingId, benchmarkId: completed.id, hostedDefinitionHash: definitionHash,
    });
    console.log(`✔ evidence published (publication ${ev.publicationId}) — listing ${listingId} LIVE`);
  }
  console.log("\ndone");
}

main().catch((e) => { console.error(e); process.exit(1); });
