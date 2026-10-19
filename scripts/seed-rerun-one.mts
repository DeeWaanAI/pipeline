// Re-run a single seed pipeline by project id and print the final output.
// Usage: npx tsx scripts/seed-rerun-one.mts <projectId> [promptOverrideFile]
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.sqlite";
import { readFileSync } from "node:fs";

const projectId = Number(process.argv[2]);
const TOKEN = readFileSync(".seed-home/.deewaanai/auth-token", "utf8").trim();
const db = drizzle(new Database(".seed-home/.deewaanai/deewaanai.db"), { schema });

const prompt = process.argv[3]
  ? readFileSync(process.argv[3], "utf8")
  : 'Brand: "TinyForge" — indie software tools; voice: playful but expert, talks to makers like a friend who codes. Rough draft: "Hi all, we made a new thing. It is a CLI that cleans up your Downloads folder. It took a while. It has rules and stuff. You can try it. Let me know if it breaks."';

const res = await fetch("http://localhost:3500/api/trpc/swarm.execute", {
  method: "POST",
  headers: { "content-type": "application/json", "x-local-auth-token": TOKEN },
  body: JSON.stringify({ json: { projectId, prompt, isTestRun: true, autoApprove: true } }),
});
const body = await res.json();
const runId = body?.result?.data?.json?.swarmRunId;
if (!runId) throw new Error(JSON.stringify(body).slice(0, 300));
console.log("run", runId);

const deadline = Date.now() + 8 * 60 * 1000;
let status = "running";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 8000));
  const [run] = await db.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, runId));
  status = run?.status ?? "missing";
  if (["completed", "failed", "cancelled"].includes(status)) break;
}
console.log("status:", status);
const [run] = await db.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, runId));
if (run?.finalResponseId) {
  const [resp] = await db.select().from(schema.agentResponses).where(eq(schema.agentResponses.id, run.finalResponseId));
  console.log("-----\n" + resp.content);
}
