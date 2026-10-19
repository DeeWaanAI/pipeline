// Seed-content test runs: executes each of the 7 pipelines once with a
// realistic input through the real local stack (worker + in-memory queue +
// Together AI). Usage: seed instance on :3500, then npx tsx scripts/seed-run.mts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, desc } from "drizzle-orm";
import * as schema from "../db/schema.sqlite";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3500";
const TOKEN = readFileSync(".seed-home/.deewaanai/auth-token", "utf8").trim();
const db = drizzle(new Database(".seed-home/.deewaanai/deewaanai.db"), { schema });

const INPUTS: Record<string, string> = {
  "Ice Cream Recipe Studio": "Theme: remote islands. Dietary restrictions: halal and vegan. Serving: 4 people, home kitchen with a basic ice cream maker.",
  "CV Multi-Language Pack": `Here is my CV:\n\nSarah Chen — Product Manager\nsarah.chen@email.com | Singapore\n\nExperience\n- Senior Product Manager, TechFlow Asia (2022–present): led launch of a B2B SaaS dashboard used by 40k accounts; grew activation 18%.\n- Product Manager, ShopSphere (2019–2022): owned checkout funnel; cut cart abandonment 12%.\n\nEducation\n- BSc Computer Science, National University of Singapore, 2018\n\nSkills: product strategy, SQL, A/B testing, stakeholder management\nLanguages: English (native), Mandarin (fluent)\n\nTarget languages: French and German.`,
  "Theme Travel Planner": "Theme: high mountains. Budget: $800 total. Duration: 5 days. Departing from: Lyon, France. Month: June. I hike regularly but have no climbing gear.",
  "PR Review Companion": `Review this diff:\n\ndiff --git a/src/auth.ts b/src/auth.ts\n@@ -12,7 +12,9 @@ export function login(user, password) {\n-  const hash = sha256(password);\n-  return db.users.find({ name: user, hash });\n+  const hash = md5(password);\n+  const query = "SELECT * FROM users WHERE name='" + user + "' AND hash='" + hash + "'";\n+  return db.raw(query);\n }`,
  "Newsletter Voice Shaper": `Brand: "TinyForge" — indie software tools; voice: playful but expert, talks to makers like a friend who codes. Rough draft: "Hi all, we made a new thing. It's a CLI that cleans up your Downloads folder. It took a while. It has rules and stuff. You can try it. Let me know if it breaks."`,
  "Paper Digest": `Abstract: We evaluated whether large language models improve code review outcomes in a field study of 12 teams over 8 weeks. Teams using LLM-assisted review showed 23% faster turnaround but a 9% increase in post-merge defects. Self-reported reviewer confidence rose 31%. We hypothesize familiarity effects and suggest further longitudinal study.`,
  "Commit-to-Changelog": `Commits this week:\n- feat: add dark mode toggle to settings\n- feat: export report as PDF\n- fix: crash when uploading empty CSV\n- fix: dark mode flicker on load\n- perf: dashboard loads 40% faster via lazy chunks\n- docs: update README install steps\n- chore: bump lodash\n- fix: typo in footer\n- feat!: rename config file to forge.config.json (old config.json no longer read)\n- Merge branch 'main' into dev`,
};

async function runOne(name: string): Promise<{ status: string; cost: number | null; outLen: number }> {
  const [proj] = await db.select().from(schema.projects).where(eq(schema.projects.name, name));
  if (!proj) throw new Error(`project missing: ${name}`);
  const res = await fetch(`${BASE}/api/trpc/swarm.execute`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-auth-token": TOKEN },
    body: JSON.stringify({ json: { projectId: proj.id, prompt: INPUTS[name], isTestRun: true, autoApprove: true } }),
  });
  const body = await res.json();
  const runId = body?.result?.data?.json?.swarmRunId;
  if (!runId) throw new Error(`execute failed for ${name}: ${JSON.stringify(body).slice(0, 300)}`);

  const deadline = Date.now() + 10 * 60 * 1000;
  let status = "running";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    const [run] = await db.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, runId));
    status = run?.status ?? "missing";
    if (["completed", "failed", "cancelled"].includes(status)) break;
  }
  let outLen = 0;
  let cost: number | null = null;
  const [run] = await db.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, runId));
  if (run?.finalResponseId) {
    const [resp] = await db.select().from(schema.agentResponses).where(eq(schema.agentResponses.id, run.finalResponseId));
    outLen = resp?.content?.length ?? 0;
  }
  cost = (run as any)?.totalTokensUsed ?? null;
  return { status, cost, outLen };
}

for (const name of Object.keys(INPUTS)) {
  try {
    const r = await runOne(name);
    console.log(`${r.status === "completed" ? "✔" : "✗"} ${name}: ${r.status}, output ${r.outLen} chars`);
  } catch (e) {
    console.log(`✗ ${name}: ${e instanceof Error ? e.message : e}`);
  }
}
