// Seed-content benchmarks (v3): runs an evidence-grade benchmark for each of
// the 7 local seed pipelines via the LOCAL server's real MCP surface —
// 3 judges from 3 different developers (Meta/Alibaba/DeepSeek) × 3 prompt
// variants, executor = Mistral (disjoint developer, per D12).
// Usage: seed instance on :3500, then npx tsx scripts/seed-benchmark.mts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { SEED_INPUTS, SEED_INPUTS_B } from "./seed-inputs.mts";

const BASE = "http://localhost:3500";
// Final lineup (Together serverless as verified live 2026-10-19):
// runners: OpenAI gpt-oss-120b + Moonshot Kimi-K3
// judges (D12: 3 vendors, disjoint from runners): Meta Llama, Zhipu GLM, MiniMax.
const EXECUTOR_MODEL = "openai/gpt-oss-120b";
const EXECUTOR_MODEL_B = "moonshotai/Kimi-K3";
const JUDGES = [
  { model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", variant: "anchored_scale" },
  { model: "zai-org/GLM-5.3-Flash", variant: "comment_first" },
  { model: "MiniMaxAI/MiniMax-M3", variant: "checklist_first" },
];

const db = drizzle(new Database(".seed-home/.deewaanai/deewaanai.db"), { schema });
const envFile = Object.fromEntries(
  readFileSync(".seed-home/env", "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);

async function mcpBearer(): Promise<string> {
  const key = createHash("sha256").update(envFile.APP_SECRET!).digest();
  return new SignJWT({ scope: "mcp:read mcp:write mcp:run", client_id: "seed" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("1").setIssuer("deewaanai").setIssuedAt().setExpirationTime("1h")
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
    if (method.startsWith("notifications/")) return null; // notifications have no response
    throw new Error(`${method}: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  }
  return parsed.result;
}

async function callTool(bearer: string, name: string, args: object): Promise<any> {
  const r = await mcp(bearer, "tools/call", { name, arguments: args });
  const sc = r?.structuredContent ?? r;
  const text = r?.content?.[0]?.text;
  if (r?.isError) throw new Error(`${name}: ${text?.slice(0, 400)}`);
  return text ? { ...sc, _text: text } : sc;
}

async function main() {
  // ── Prep: feature flags, model catalog (vendor per developer), provider models ──
  for (const key of ["v2Benchmarks", "v2Publication"]) {
    const [f] = await db.select().from(schema.featureFlags).where(eq(schema.featureFlags.key, key));
    if (!f) await db.insert(schema.featureFlags).values({ key, name: key, enabled: true, rolloutPercent: 100 });
    else if (!f.enabled) await db.update(schema.featureFlags).set({ enabled: true, rolloutPercent: 100 }).where(eq(schema.featureFlags.id, f.id));
  }
  const catalog: Array<[string, string]> = [
    ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Meta"],
    ["zai-org/GLM-5.3-Flash", "Zhipu"],
    ["MiniMaxAI/MiniMax-M3", "MiniMax"],
    ["openai/gpt-oss-120b", "OpenAI"],
    ["moonshotai/Kimi-K3", "Moonshot AI"],
  ];
  for (const [modelId, vendor] of catalog) {
    const [row] = await db.select().from(schema.modelCatalog).where(eq(schema.modelCatalog.modelId, modelId));
    if (!row) {
      await db.insert(schema.modelCatalog).values({ provider: "together", modelId, vendor, availabilitySource: "admin_reviewed" });
    } else if (!row.vendor) {
      await db.update(schema.modelCatalog).set({ vendor }).where(eq(schema.modelCatalog.id, row.id));
    }
  }
  const [prov] = await db.select().from(schema.llmProviders).where(eq(schema.llmProviders.id, 1));
  const models = new Set([...(prov?.models ?? []), EXECUTOR_MODEL, EXECUTOR_MODEL_B, ...JUDGES.map((j) => j.model)]);
  await db.update(schema.llmProviders).set({ models: [...models] }).where(eq(schema.llmProviders.id, 1));
  console.log("✔ flags on, catalog seeded (4 vendors), provider models updated");

  const bearer = await mcpBearer();
  await mcp(bearer, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "seed", version: "0" } });
  await mcp(bearer, "notifications/initialized");

  const projects = await db.select().from(schema.projects);
  for (const proj of projects) {
    console.log(`\n═══ ${proj.name} ═══`);
    // Idempotent: reuse an existing completed benchmark for this project.
    const [existing] = await db.select().from(schema.benchmarks)
      .where(eq(schema.benchmarks.sourceProjectId, proj.id));
    if (existing && existing.state === "completed") {
      console.log(`• benchmark ${existing.id} already completed — skipping`);
      continue;
    }

    const created = await callTool(bearer, "create_benchmark", {
      projectId: proj.id,
      executionMode: "compare_models",
      cases: [
        { inputText: SEED_INPUTS[proj.name], origin: "user" },
        { inputText: SEED_INPUTS_B[proj.name], origin: "user" },
      ],
      judges: JUDGES.map((j) => ({ providerId: 1, model: j.model, variant: j.variant })),
      candidates: [
        { label: "gpt-oss-120b", overrideModel: EXECUTOR_MODEL, overrideProviderId: 1 },
        { label: "kimi-k3", overrideModel: EXECUTOR_MODEL_B, overrideProviderId: 1 },
      ],
      rubricPreset: { "CV Multi-Language Pack": "translation", "PR Review Companion": "code", "Commit-to-Changelog": "code" }[proj.name] ?? "generic",
    });
    const benchmarkId = created.benchmarkId ?? created.id;
    console.log(`• benchmark draft ${benchmarkId}`);

    const quote = await callTool(bearer, "quote_benchmark", { benchmarkId });
    console.log(`• quote: ~$${quote.estimatedCostUsd ?? quote.totalEstimatedCostUsd ?? "?"} | evidenceGrade=${quote.panel?.evidenceGrade} | blocking=${JSON.stringify(quote.blockingErrors ?? [])}`);
    if (quote.panel && quote.panel.evidenceGrade === false) {
      console.log(`  ⚠ NOT evidence-grade: ${JSON.stringify(quote.warnings ?? quote.panel).slice(0, 300)}`);
    }
    if ((quote.blockingErrors ?? []).length) throw new Error(`blocking errors: ${quote.blockingErrors}`);
    const planHash = quote.planHash;
    if (!planHash) throw new Error(`no planHash in quote: ${JSON.stringify(quote).slice(0, 300)}`);

    const approval = await callTool(bearer, "approve_benchmark_spend", { benchmarkId, planHash });
    await callTool(bearer, "start_benchmark", { benchmarkId, planHash, spendApprovalId: approval.spendApprovalId });
    console.log("• started");

    const deadline = Date.now() + 25 * 60 * 1000;
    let state = "queued";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15000));
      const st = await callTool(bearer, "benchmark_status", { benchmarkId });
      state = st.state ?? st.status ?? "unknown";
      if (["completed", "failed", "cancelled", "partial"].includes(state)) break;
    }
    console.log(`${state === "completed" ? "✔" : "✗"} ${proj.name}: benchmark ${benchmarkId} → ${state}`);
  }
  console.log("\ndone");
}

main().catch((e) => { console.error(e); process.exit(1); });
