// Finisher: resumes partial/failed seed benchmarks under their frozen plans
// until completed (Together 503s make the first pass flaky). Completed
// children are never re-run — a resume appends attempts only.
// Usage: seed instance on :3500, npx tsx scripts/seed-resume.mts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, and, inArray } from "drizzle-orm";
import * as schema from "../db/schema.sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";

const BASE = "http://localhost:3500";
const db = drizzle(new Database(".seed-home/.deewaanai/deewaanai.db"), { schema });
const envFile = Object.fromEntries(
  readFileSync(".seed-home/env", "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);

async function mcpBearer(): Promise<string> {
  const key = createHash("sha256").update(envFile.APP_SECRET!).digest();
  return new SignJWT({ scope: "mcp:read mcp:write mcp:run", client_id: "seed" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("1").setIssuer("deewaanai").setIssuedAt().setExpirationTime("2h")
    .sign(key);
}

let sessionId: string | undefined;
let rpcId = 0;
async function mcp(bearer: string, method: string, params: object = {}): Promise<any> {
  rpcId += 1;
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const parsed = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
  if (parsed.error) {
    if (method.startsWith("notifications/")) return null;
    throw new Error(`${method}: ${JSON.stringify(parsed.error).slice(0, 300)}`);
  }
  return parsed.result;
}

async function callTool(bearer: string, name: string, args: object): Promise<any> {
  const r = await mcp(bearer, "tools/call", { name, arguments: args });
  if (r?.isError) throw new Error(`${name}: ${r?.content?.[0]?.text?.slice(0, 300)}`);
  return r?.structuredContent ?? {};
}

async function poll(bearer: string, benchmarkId: number, capMin: number): Promise<string> {
  const deadline = Date.now() + capMin * 60 * 1000;
  let state = "running";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20000));
    const st = await callTool(bearer, "benchmark_status", { benchmarkId });
    state = st.state ?? "unknown";
    if (["completed", "failed", "cancelled", "partial"].includes(state)) return state;
  }
  return state;
}

async function main() {
  const bearer = await mcpBearer();
  await mcp(bearer, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "seed", version: "0" } });
  await mcp(bearer, "notifications/initialized");

  for (let round = 1; round <= 6; round++) {
    const unfinished = await db.select().from(schema.benchmarks)
      .where(inArray(schema.benchmarks.state, ["partial", "failed"]));
    if (!unfinished.length) break;
    console.log(`── round ${round}: ${unfinished.length} unfinished`);
    for (const b of unfinished) {
      try {
        const quote = await callTool(bearer, "quote_benchmark", { benchmarkId: b.id });
        const planHash = quote.planHash;
        if (!planHash) throw new Error("no planHash");
        const approval = await callTool(bearer, "approve_benchmark_spend", { benchmarkId: b.id, planHash });
        await callTool(bearer, "resume_benchmark", {
          benchmarkId: b.id, planHash, spendApprovalId: approval.spendApprovalId,
          retryFailed: true, // re-run failed children (transient Together 503s)
        });
        const state = await poll(bearer, b.id, 20);
        console.log(`  benchmark ${b.id} (project ${b.sourceProjectId}) → ${state}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("nothing_left_to_do")) {
          // All children terminal but state lagging — check again
          const [now] = await db.select().from(schema.benchmarks).where(eq(schema.benchmarks.id, b.id));
          console.log(`  benchmark ${b.id}: nothing left to do, state=${now.state}`);
          if (now.state === "partial" || now.state === "failed") {
            console.log(`  ⚠ benchmark ${b.id} still ${now.state} with nothing requeueable — leaving for manual review`);
          }
        } else {
          console.log(`  ✗ benchmark ${b.id}: ${msg.slice(0, 200)}`);
        }
      }
    }
  }

  const final = await db.select().from(schema.benchmarks)
    .where(and(inArray(schema.benchmarks.state, ["completed", "partial", "failed"])));
  console.log("\nfinal states:");
  for (const b of final) {
    const [proj] = await db.select().from(schema.projects).where(eq(schema.projects.id, b.sourceProjectId ?? 0));
    console.log(`  ${proj?.name ?? "?"}: benchmark ${b.id} → ${b.state}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
