// L3 gate (V3 spec): END-TO-END local ↔ hosted protocol.
//   hosted instance (port 3401)  = the marketplace (same code, its own HOME)
//   local instance  (port 3402)  = a user's machine (its own HOME)
// Proves: device-flow link → fork a published-with-evidence listing down →
// run it locally against a stub LLM (user's own "key", zero platform cost) →
// publish an own pipeline up → hosted draft listing owned by the marketplace
// account.
// Usage: npm run build:local && npx tsx scripts/smoke-l3-e2e.mts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.sqlite";
import { stableJson } from "../api/services/benchmark/versionService";
import { encrypt } from "../api/services/cryptoService";

const HOSTED_PORT = 3401;
const LOCAL_PORT = 3402;
const STUB_PORT = 3499;
const HOSTED = `http://localhost:${HOSTED_PORT}`;
const LOCAL = `http://localhost:${LOCAL_PORT}`;

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function openDb(file: string) {
  return drizzle(new Database(file), { schema });
}

async function waitBanner(child: ChildProcess, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`boot timeout:\n${out}`)), timeoutMs);
    child.stdout?.on("data", (d) => {
      out += String(d);
      if (out.includes("auth_token=")) { clearTimeout(timer); resolve(out); }
    });
    child.stderr?.on("data", (d) => { out += String(d); });
    child.on("exit", (c) => { clearTimeout(timer); reject(new Error(`exited ${c}:\n${out}`)); });
  });
}

const childLogs: string[] = [];
async function boot(home: string, port: number, extra: Record<string, string>): Promise<ChildProcess> {
  const child = spawn("node", ["dist/boot.js"], {
    env: {
      PATH: process.env.PATH!, HOME: home, PORT: String(port),
      DB_DRIVER: "sqlite", SQLITE_PATH: join(home, ".deewaanai", "deewaanai.db"),
      NODE_ENV: "production", APP_SECRET: `s-${port}`, APP_ID: "smoke",
      // Isolate from the repo's .env (dotenv never overrides an existing
      // var): no Redis → in-memory queue, exactly what a real user has.
      REDIS_URL: "",
      AI_SWARM_MASTER_KEY: `k-${port}`, MARKETPLACE_MASTER_KEY: `m-${port}`,
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => childLogs.push(String(d)));
  child.stderr?.on("data", (d) => childLogs.push(String(d)));
  await waitBanner(child);
  return child;
}

function tokenOf(home: string): string {
  return readFileSync(join(home, ".deewaanai", "auth-token"), "utf8").trim();
}

async function trpc(base: string, token: string, proc: string, input?: unknown, isQuery = false): Promise<any> {
  const url = isQuery
    ? `${base}/api/trpc/${proc}?input=${encodeURIComponent(JSON.stringify({ json: input ?? null }))}`
    : `${base}/api/trpc/${proc}`;
  const res = await fetch(url, {
    method: isQuery ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-local-auth-token": token },
    ...(isQuery ? {} : { body: JSON.stringify({ json: input }) }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.error) {
    throw new Error(`${proc} failed: HTTP ${res.status} ${JSON.stringify(body?.error ?? body)}`);
  }
  return body?.result?.data?.json;
}

async function main() {
  const sandbox = mkdtempSync(join(tmpdir(), "deewaanai-l3-"));
  const hostedHome = join(sandbox, "hosted");
  const localHome = join(sandbox, "local");
  console.log(`sandbox: ${sandbox}`);
  let hosted: ChildProcess | undefined;
  let local: ChildProcess | undefined;
  let stub: ReturnType<typeof createServer> | undefined;

  try {
    // ── Stub LLM provider (stands in for the user's own key/endpoint) ──
    stub = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "STUB PIPELINE OUTPUT" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
      } else {
        res.writeHead(404); res.end();
      }
    });
    await new Promise<void>((r) => stub!.listen(STUB_PORT, "127.0.0.1", r));

    // ── Boot both instances ─────────────────────────────────────────
    hosted = await boot(hostedHome, HOSTED_PORT, {
      START_WORKER: "false", HOSTED_WEB_URL: HOSTED,
    });
    local = await boot(localHome, LOCAL_PORT, { DEEWAANAI_HOSTED_URL: HOSTED });
    const hostedToken = tokenOf(hostedHome);
    const localToken = tokenOf(localHome);
    console.log("✔ both instances booted (hosted marketplace + local install)");

    const hostedDb = openDb(join(hostedHome, ".deewaanai", "deewaanai.db"));
    const localDb = openDb(join(localHome, ".deewaanai", "deewaanai.db"));

    // ── 1. Device-flow link ─────────────────────────────────────────
    const begin = await trpc(LOCAL, localToken, "hostedLink.begin");
    if (!begin.userCode || !begin.verificationUrl.includes(HOSTED)) {
      fail(`begin: ${JSON.stringify(begin)}`);
    }
    const approve = await fetch(`${HOSTED}/api/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-local-auth-token": hostedToken },
      body: JSON.stringify({ userCode: begin.userCode }),
    });
    if (!approve.ok) fail(`approve: HTTP ${approve.status}`);
    let linked: any;
    for (let i = 0; i < 10; i++) {
      linked = await trpc(LOCAL, localToken, "hostedLink.status", undefined, true);
      if (linked.state === "linked") break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (linked?.state !== "linked") fail(`never linked: ${JSON.stringify(linked)}`);
    console.log("✔ device flow: code shown → approved on hosted → token stored locally");

    // ── 2. Fixture on hosted: a published listing with evidence ─────
    const steps = [{
      stepOrder: 1, name: "Draft", role: "builder", systemPrompt: "Reply briefly.",
      stepType: "agent", model: null, temperature: null, maxTokens: null,
      ifConfig: null, whileConfig: null,
    }];
    const tpl = hostedDb.insert(schema.pipelineTemplates).values({
      userId: 1, name: "Demo Pipeline", description: "fixture", steps,
    }).run();
    const templateId = Number(tpl.lastInsertRowid);
    const lst = hostedDb.insert(schema.marketplaceListings).values({
      creatorId: 1, templateId, title: "Demo Pipeline", description: "fixture",
      category: "other", price: "0", status: "published",
    }).run();
    const listingId = Number(lst.lastInsertRowid);
    const definition = { schemaVersion: 1, steps, pipelineConfig: null };
    const definitionHash = createHash("sha256").update(stableJson(definition)).digest("hex");
    const ver = hostedDb.insert(schema.pipelineVersions).values({
      ownerId: 1, sourceTemplateId: templateId, versionNumber: 1,
      definitionSchemaVersion: 1, definition: JSON.stringify(definition),
      definitionHash, designerMethod: "manual",
    }).run();
    const versionId = Number(ver.lastInsertRowid);
    const manifest = {
      versionIdentity: { listingId, workflowVersionId: versionId, definitionHash },
      summary: "fixture evidence",
    };
    const manifestHash = createHash("sha256").update(stableJson(manifest)).digest("hex");
    const pub = hostedDb.insert(schema.evidencePublications).values({
      authorId: 1, listingId, listingWorkflowVersionId: versionId,
      publicationKind: "seller", provenance: "platform_recorded",
      publicManifest: JSON.stringify(manifest), manifestHash,
      consentVersion: "v1", state: "published", testedAt: new Date(),
    }).run();
    hostedDb.insert(schema.marketplaceListingV2).values({
      listingId, publicationMode: "v2",
      currentWorkflowVersionId: versionId,
      currentEvidencePublicationId: Number(pub.lastInsertRowid),
    }).run();
    console.log("✔ hosted fixture: published listing with evidence");

    // ── 3. Fork down to the local install ───────────────────────────
    const forked = await trpc(LOCAL, localToken, "hostedLink.forkFromHosted", { listingId });
    if (!forked?.projectId) fail(`fork: ${JSON.stringify(forked)}`);
    const [forkedProject] = await localDb.select().from(schema.projects)
      .where(eq(schema.projects.id, forked.projectId));
    if (!forkedProject || forkedProject.userId !== 1) fail("forked project missing locally");
    console.log(`✔ fork: listing ${listingId} → local project ${forked.projectId} (verified offline)`);

    // ── 4. Run the forked pipeline locally against the stub LLM ─────
    const masterKey = `k-${LOCAL_PORT}`;
    const enc = encrypt("sk-stub", masterKey);
    const prov = localDb.insert(schema.llmProviders).values({
      userId: 1, name: "Stub", slug: "openai", baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`,
      apiKeyRef: enc.encrypted, defaultModel: "stub-1", isEnabled: true,
    }).run();
    localDb.update(schema.users)
      .set({ defaultProviderId: Number(prov.lastInsertRowid), defaultModel: "stub-1" })
      .where(eq(schema.users.id, 1)).run();
    const run = await trpc(LOCAL, localToken, "swarm.execute", {
      projectId: forked.projectId, prompt: "hello", isTestRun: true, autoApprove: true,
    });
    if (!run?.swarmRunId) fail(`execute: ${JSON.stringify(run)}`);
    let finalStatus = "";
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const [r] = await localDb.select().from(schema.swarmRuns)
        .where(eq(schema.swarmRuns.id, run.swarmRunId));
      finalStatus = r?.status ?? "";
      if (["completed", "failed", "cancelled"].includes(finalStatus)) break;
    }
    if (finalStatus !== "completed") {
      const [r] = await localDb.select().from(schema.swarmRuns)
        .where(eq(schema.swarmRuns.id, run.swarmRunId));
      console.error(childLogs.slice(-30).join("")); fail(`run ended with status "${finalStatus}" error=${JSON.stringify((r as any)?.error ?? null)}`);
    }
    console.log(`✔ run: forked pipeline completed locally (run ${run.swarmRunId}, user's own provider)`);

    // ── 5. Publish an own pipeline up to the marketplace ────────────
    const ownSteps = [{
      stepOrder: 1, name: "Write", role: "writer", systemPrompt: "Write something.",
      stepType: "agent", model: null, temperature: null, maxTokens: null,
      ifConfig: null, whileConfig: null,
    }];
    const ownTpl = localDb.insert(schema.pipelineTemplates).values({
      userId: 1, name: "My Local Pipeline", steps: ownSteps,
    }).run();
    const ownProj = localDb.insert(schema.projects).values({
      userId: 1, name: "My Local Pipeline",
      pipelineTemplateId: Number(ownTpl.lastInsertRowid),
    }).run();
    const published = await trpc(LOCAL, localToken, "hostedLink.publishToHosted", {
      projectId: Number(ownProj.lastInsertRowid),
      title: "My Local Pipeline",
      description: "Authored locally, published via device link",
      category: "writing",
    });
    if (!published?.id) fail(`publish: ${JSON.stringify(published)}`);
    const [hostedListing] = await hostedDb.select().from(schema.marketplaceListings)
      .where(eq(schema.marketplaceListings.id, published.id));
    if (!hostedListing || hostedListing.creatorId !== 1 || hostedListing.status !== "draft") {
      fail(`hosted listing wrong: ${JSON.stringify(hostedListing)}`);
    }
    console.log(`✔ publish: local pipeline → hosted draft listing ${published.id} owned by the marketplace account`);

    console.log("\n✅ L3 END-TO-END PASSED (link → fork → run → publish)");
  } finally {
    local?.kill("SIGKILL");
    hosted?.kill("SIGKILL");
    stub?.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
