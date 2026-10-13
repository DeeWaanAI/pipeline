// DB-backed evidence-publication drill (offering redesign v2, P3: spec §7.3,
// §6.2, §10.2; acceptance tests A09/A10/A13 and the publication half of the
// A12 leakage check). Own throwaway schema (`swarm_v2test_evidence`) so it
// never collides with the other parallel integration files.
//
// Engine + judge are faked exactly as in the execution drill; freeze, ledger,
// manifest, hashing, publication and withdrawal are the real code.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";
import { generateKeyPairSync } from "node:crypto";

// A throwaway signing key for the stack. Generated per RUN, never committed, and
// the private half only ever exists in this process's env — the same rule the
// service documents for production.
const TEST_SIGNING = generateKeyPairSync("ed25519");
const TEST_SIGNING_PUBLIC_PEM = TEST_SIGNING.publicKey.export({ type: "spki", format: "pem" }).toString();
const TEST_SIGNING_KEY_ID = "test-attestation-key";

const exec = vi.hoisted(() => ({ calls: [] as number[] }));

vi.mock("./swarmService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./swarmService")>();
  return {
    ...actual,
    executeSwarmRun: async (params: { swarmRunId: number }) => {
      const { getDb } = await import("../queries/connection");
      const schema = await import("@db/schema");
      const { eq } = await import("drizzle-orm");
      const db = getDb();
      const [run] = await db.select().from(schema.swarmRuns).where(eq(schema.swarmRuns.id, params.swarmRunId)).limit(1);
      exec.calls.push(params.swarmRunId);
      const [ar] = await db.insert(schema.agentRuns).values({
        swarmRunId: params.swarmRunId, projectId: run.projectId, agentName: "Fake", agentRole: "builder",
        pipelineStep: 1, userPrompt: run.userPrompt, status: "completed",
      });
      const [resp] = await db.insert(schema.agentResponses).values({
        agentRunId: Number((ar as { insertId: number }).insertId), swarmRunId: params.swarmRunId,
        projectId: run.projectId, responseType: "final", content: `public-looking output for ${run.userPrompt}`,
        metadata: {
          model: "fake-model", provider: "fake", providerSlug: "fake",
          tokensUsed: { prompt: 100, completion: 20, total: 120 }, latencyMs: 5, temperature: 0.7, maxTokens: 1024,
          agentName: "Fake", agentRole: "builder", agentSlug: "fake", pipelineStep: 1, iteration: 1,
          buildMethod: "manual", sourceResponseIds: [],
        },
      });
      await db.update(schema.swarmRuns).set({
        status: "completed", finalResponseId: Number((resp as { insertId: number }).insertId), completedAt: new Date(),
      }).where(eq(schema.swarmRuns.id, params.swarmRunId));
    },
  };
});

const judgeInputs = vi.hoisted(() => [] as string[]);
vi.mock("./benchmark/judgeService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./benchmark/judgeService")>();
  return {
    ...actual,
    generateJudgeCall: async (args: { prompt: { messages: Array<{ content: string }> } }) => {
      judgeInputs.push(args.prompt.messages.map((m) => m.content).join("\n"));
      return {
      content: JSON.stringify({
        scores: { accuracy: 8, completeness: 7, instructionFit: 9, clarity: 6 },
        rationale: "solid but terse",
      }),
      model: "judge-model", promptTokens: 400, completionTokens: 60,
      };
    },
  };
});

const TEST_DB = "swarm_v2test_evidence";
const ROOT_MYSQL = process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307";

let svc: typeof import("./benchmark/benchmarkService");
let ev: typeof import("./evidenceService");
let schema: typeof import("@db/schema");
let eq: typeof import("drizzle-orm").eq;
let admin: mysql.Connection;

beforeAll(async () => {
  admin = await mysql.createConnection(ROOT_MYSQL);
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.query(`GRANT ALL PRIVILEGES ON \`${TEST_DB}\`.* TO 'swarm'@'%'`);
  await admin.query("FLUSH PRIVILEGES");
  process.env.DATABASE_URL = `mysql://swarm:swarmpass@localhost:3307/${TEST_DB}`;
  process.env.REDIS_URL = "";
  process.env.NODE_ENV = "development";
  process.env.APP_SECRET ||= "1".repeat(64);
  process.env.AI_SWARM_MASTER_KEY ||= "2".repeat(64);
  process.env.MARKETPLACE_MASTER_KEY ||= "3".repeat(64);
  // Must be set BEFORE `evidenceService` is imported: `env` reads process.env at
  // module load, so a key set after the import would be invisible to the signer.
  process.env.EVIDENCE_SIGNING_PRIVATE_KEY = TEST_SIGNING.privateKey
    .export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n");
  process.env.EVIDENCE_SIGNING_KEY_ID = TEST_SIGNING_KEY_ID;
  await pushSchema();
  svc = await import("./benchmark/benchmarkService");
  ev = await import("./evidenceService");
  schema = await import("@db/schema");
  eq = (await import("drizzle-orm")).eq;
}, 300_000);

afterAll(async () => {
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`REVOKE ALL PRIVILEGES ON \`${TEST_DB}\`.* FROM 'swarm'@'%'`);
    await admin.end();
  }
});

async function pushSchema() {
  const { execFileSync } = await import("node:child_process");
  execFileSync("npx", ["drizzle-kit", "push", "--force"], {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL }, stdio: "ignore", timeout: 150_000,
  });
}

async function connection() {
  return (await import("../queries/connection")).getDb();
}

const SECRET_PROMPT = "Translate the clause. Internal note: use customer PII from /vault and the key sk-ABCDEFGHIJKL1234567890.";

async function seedFixture() {
  const db = await connection();
  const stamp = `${Date.now()}-${Math.random()}`;
  const [u] = await db.insert(schema.users).values({ name: "Publisher", email: `p-${stamp}@example.test`, tier: "pro_auto" });
  const userId = Number((u as { insertId: number }).insertId);
  const [p] = await db.insert(schema.projects).values({ userId, name: "Publisher Project" });
  const projectId = Number((p as { insertId: number }).insertId);
  const [prov] = await db.insert(schema.llmProviders).values({
    userId, name: `fake-${stamp}`, slug: `fake-${stamp}`, baseUrl: "http://localhost:1", apiKeyRef: "dummy", defaultModel: "fake-model",
  });
  const providerId = Number((prov as { insertId: number }).insertId);
  await db.insert(schema.pipelineSteps).values([
    { projectId, stepOrder: 1, stepType: "agent", name: "Draft", role: "builder", systemPrompt: SECRET_PROMPT, isEnabled: true, providerId, model: "fake-model" },
    { projectId, stepOrder: 2, stepType: "agent", name: "Polish", role: "polisher", systemPrompt: "polish it", isEnabled: true, providerId, model: "fake-model" },
  ]);
  // D12 needs reviewed vendors in the catalog: the generator is one developer's
  // model and the three judges are three OTHER developers — all served by the
  // ONE hosting provider above, which is exactly the point: developer comes
  // from the catalog column, never from whose key served the call.
  // `.ignore()` — the unique (provider, modelId) index makes these global.
  await db.insert(schema.modelCatalog).ignore().values([
    { provider: "fake-host", modelId: "fake-model", vendor: "qwen" },
    { provider: "fake-host", modelId: "judge-ds", vendor: "deepseek" },
    { provider: "fake-host", modelId: "judge-glm", vendor: "zhipu" },
    { provider: "fake-host", modelId: "judge-llama", vendor: "meta" },
    { provider: "fake-host", modelId: "judge-model", vendor: null },
  ]);
  return { db, userId, projectId, providerId };
}

/** An evidence-grade D12 panel — 3 developers × 3 prompt variants — all
 *  served through the fixture's single hosting provider on purpose. */
const evidencePanel = (f: { providerId: number }) => [
  { providerId: f.providerId, model: "judge-ds", variant: "anchored_scale" as const },
  { providerId: f.providerId, model: "judge-glm", variant: "comment_first" as const },
  { providerId: f.providerId, model: "judge-llama", variant: "checklist_first" as const },
];

/** A completed benchmark whose children were really executed by the plan. */
async function completedBenchmark(f: Awaited<ReturnType<typeof seedFixture>>, judgePromptOverrides?: import("../../contracts/offeringV2").JudgePromptOverrides) {
  const benchmarkId = await svc.createBenchmarkDraft({
    userId: f.userId, projectId: f.projectId,
    cases: [{ inputText: "clause one" }, { inputText: "clause two" }],
    judges: evidencePanel(f),
    ...(judgePromptOverrides ? { judgePromptOverrides } : {}),
  });
  const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
  const approval = await svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: quote.planHash });
  const started = await svc.startBenchmark({ userId: f.userId, benchmarkId, planHash: quote.planHash, spendApprovalId: approval });
  expect(started.ok).toBe(true);
  const lease = await svc.acquireBenchmark(benchmarkId);
  await svc.executeBenchmark({ benchmarkId, leaseToken: lease! });
  const db = await connection();
  const [bench] = await db.select().from(schema.benchmarks).where(eq(schema.benchmarks.id, benchmarkId)).limit(1);
  return { benchmarkId, bench };
}

const publicationRow = async (id: number) => {
  const db = await connection();
  const [row] = await db.select().from(schema.evidencePublications).where(eq(schema.evidencePublications.id, id)).limit(1);
  return row;
};

/** The v2 flag gates every write. Inserted per-test (with the cache dropped)
 *  so the "flag off" case is a real gate, not an ordering accident. */
async function setPublicationFlag(enabled: boolean) {
  const db = await connection();
  const [existing] = await db.select({ id: schema.featureFlags.id }).from(schema.featureFlags)
    .where(eq(schema.featureFlags.key, "v2Publication")).limit(1);
  if (existing) {
    await db.update(schema.featureFlags).set({ enabled }).where(eq(schema.featureFlags.id, existing.id));
  } else {
    await db.insert(schema.featureFlags).values({
      key: "v2Publication", name: "V2 — Evidence Publication", description: "test", enabled, rolloutPercent: 0,
    });
  }
  (await import("../plugins/featureFlags")).resetFlagCache();
}

/** A listing in `draft` plus the template lineage the boundary expects. */
async function seedListing(f: Awaited<ReturnType<typeof seedFixture>>, sourceProjectId: number | null = f.projectId) {
  const db = await connection();
  const [t] = await db.insert(schema.pipelineTemplates).values({
    userId: f.userId, name: `tpl-${Date.now()}`, steps: [{ name: "Draft", role: "builder", systemPrompt: "x" }],
    sourceProjectId,
  });
  const templateId = Number((t as { insertId: number }).insertId);
  const [l] = await db.insert(schema.marketplaceListings).values({
    creatorId: f.userId, templateId, title: "Contract Redliner", price: "4.99", status: "draft",
  });
  const listingId = Number((l as { insertId: number }).insertId);
  return { listingId, templateId };
}

const listingRow = async (id: number) => {
  const db = await connection();
  const [row] = await db.select().from(schema.marketplaceListings).where(eq(schema.marketplaceListings.id, id)).limit(1);
  const [v2] = await db.select().from(schema.marketplaceListingV2).where(eq(schema.marketplaceListingV2.listingId, id)).limit(1);
  return { listing: row, v2 };
};

describe("evidence publication (DB-backed)", () => {
  beforeAll(async () => { await setPublicationFlag(true); });

  it("executes edited judging instructions and discloses their recorded versions", async () => {
    const f = await seedFixture();
    const overrides = { anchored_scale: { system: "Review business usefulness.", preface: "Check practical recommendations before assigning scores." } };
    const offset = judgeInputs.length;
    const { benchmarkId } = await completedBenchmark(f, overrides);
    const calls = judgeInputs.slice(offset);
    expect(calls.filter((text) => text.includes(overrides.anchored_scale.system))).toHaveLength(6);
    expect(calls.filter((text) => text.includes(overrides.anchored_scale.preface))).toHaveLength(6);
    const preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1" });
    const { judgePromptVersionFor } = await import("./benchmark/judgeService");
    const version = judgePromptVersionFor("anchored_scale", overrides);
    expect(preview.manifest.judging.judgePrompts.find((p) => p.judgePromptVersion === version)?.promptText).toContain(overrides.anchored_scale.preface);
    expect(preview.manifest.judging.judgments.filter((j) => j.judgePromptVersion === version)).toHaveLength(6);
    expect(preview.manifest.judging.judges.filter((j) => j.judgePromptVersion === version)).toHaveLength(3);
  });

  it("builds a manifest that satisfies the frozen public contract and repeats byte-for-byte", async () => {
    const f = await seedFixture();
    const { benchmarkId } = await completedBenchmark(f);

    const first = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1" });
    const second = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1" });

    expect(first.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.previewHash).toBe(first.previewHash);
    expect(first.eligibilityIssues).toEqual([]);
    expect(first.secretFindings).toEqual([]);
    expect(first.manifest.versionIdentity.includesPrivateDefinition).toBe(false);
    // D12: 2 cases × 1 candidate × 1 repeat × (3 judges × 3 variants) = 18 ratings.
    expect(first.manifest.judging.judgments.length).toBe(18);
    expect(first.manifest.judging.judgePrompts.length).toBe(3);
    expect(first.manifest.attempts.planned.judgments).toBe(18);
    expect(first.manifest.attempts.completed.judgments).toBe(18);
    expect(first.manifest.attempts.allSelectedPlanAttemptsDisclosed).toBe(true);
    expect(first.panelIssues).toEqual([]);
    expect(first.evidenceGradePanel).toBe(true);
  });

  it("discloses the things a reader needs and never the private workflow definition (A12 publication half)", async () => {
    const f = await seedFixture();
    const { benchmarkId } = await completedBenchmark(f);
    const { manifest } = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1" });
    const flat = JSON.stringify(manifest);

    // The seller's step prompt carries a fake secret; it must not leak.
    expect(flat).not.toContain("/vault");
    expect(flat).not.toContain("sk-ABCDEFGHIJKL1234567890");
    expect(flat).not.toContain("Internal note");

    // What §7.3 does require, explicitly.
    expect(flat).toContain("judge-v1");
    expect(flat).toContain("{{CANDIDATE_OUTPUT}}");           // exact judging template
    expect(flat).toContain("not_exposed_by_provider");        // revision stated, not inferred
    expect(manifest.judging.rubric.dimensions.reduce((a, d) => a + Number(d.weight), 0)).toBeCloseTo(1, 9);
    expect(manifest.attempts.reproducibilityLimitations.join(" ")).toContain("validators were disabled");
    expect(manifest.costs.designCostUsd).toBe("unknown");     // unknown, never zero
    expect(manifest.costs.missingItems.length).toBeGreaterThan(0);
    expect(manifest.judging.resolvedJudgeInputs.every((i) => i.hiddenSellerInstructionsIncluded === false)).toBe(true);
  });

  it("publishes only after an explicit preview hash + consent, is idempotent, and never re-dates the test", async () => {
    const f = await seedFixture();
    const { benchmarkId, bench } = await completedBenchmark(f);
    const { listingId } = await seedListing(f);
    const preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", listingId, consentVersion: "consent-v1" });
    const versionId = Number(preview.manifest.versionIdentity.workflowVersionId);

    // A01/A10: consent is to a hash. The wrong hash never publishes anything.
    await expect(ev.publishVersion({
      userId: f.userId, listingId, workflowVersionId: versionId, benchmarkId,
      previewHash: "0".repeat(64), consentVersion: "consent-v1",
    })).rejects.toThrow(/preview_changed/);
    expect((await listingRow(listingId)).listing.status).toBe("draft");

    // Naming a version the evidence did not test is refused (A11). A SECOND,
    // real version of the same project is used so the refusal is about the
    // binding, not about the version existing.
    const db = await connection();
    const [otherVersion] = await db.insert(schema.pipelineVersions).values({
      ownerId: f.userId, sourceProjectId: f.projectId, versionNumber: 987,
      definition: JSON.stringify({ steps: [] }), definitionHash: "f".repeat(64),
    });
    await expect(ev.publishVersion({
      userId: f.userId, listingId, workflowVersionId: Number((otherVersion as { insertId: number }).insertId),
      benchmarkId, previewHash: preview.previewHash, consentVersion: "consent-v1",
    })).rejects.toThrow(/version_mismatch/);
    // A version that is not yours at all is not even described as existing.
    await expect(ev.publishVersion({
      userId: f.userId, listingId, workflowVersionId: 999_999, benchmarkId,
      previewHash: preview.previewHash, consentVersion: "consent-v1",
    })).rejects.toThrow(/not_found_or_not_authorized/);

    const published = await ev.publishVersion({
      userId: f.userId, listingId, workflowVersionId: versionId, benchmarkId,
      previewHash: preview.previewHash, consentVersion: "consent-v1",
    });
    expect(published.reused).toBe(false);
    expect(published.previousListingStatus).toBe("draft");
    const row = await publicationRow(published.publicationId);
    expect(row.state).toBe("published");
    expect(row.manifestHash).toBe(preview.previewHash);
    // ATTESTATION (v3). The published record carries a signature over the manifest
    // hash AND the listing/version/definition/author it belongs to; the columns
    // exist so an operator can query for unsigned evidence. What is proved here is
    // the part a pure crypto test cannot: the real public read path still parses a
    // manifest that now has an `attestation` member — safeParse failing would have
    // returned null and silently unpublished the record from its own canonical URL.
    const sign = await import("./evidenceSigning");
    expect(row.signingKeyId).toBe(TEST_SIGNING_KEY_ID);
    expect(String(row.signature).length).toBeGreaterThan(40);
    expect(row.signedAt).not.toBeNull();

    const readBack = await ev.getPublishedManifestByHash(preview.previewHash);
    expect(readBack).not.toBeNull();
    const att = (readBack as unknown as { attestation: NonNullable<ReturnType<typeof sign.attestEvidenceManifest>> }).attestation;
    expect(att.publicKeyPem).toBe(TEST_SIGNING_PUBLIC_PEM);
    expect(att.hashExcludes).toEqual(["attestation"]);
    const vi0 = readBack!.versionIdentity;
    const identityOf = {
      manifestHash: preview.previewHash,
      listingId: Number(vi0.listingId ?? listingId),
      workflowVersionId: Number(vi0.workflowVersionId),
      definitionHash: String(vi0.definitionHash),
      authorId: f.userId,
    };
    expect(sign.verifyEvidenceAttestation(att, identityOf, TEST_SIGNING_PUBLIC_PEM).valid).toBe(true);
    // And the same record read against a different listing fails — the signature
    // is not portable between artifacts even though it is perfectly formed.
    expect(sign.verifyEvidenceAttestation(
      att, { ...identityOf, listingId: identityOf.listingId + 1 }, TEST_SIGNING_PUBLIC_PEM,
    ).valid).toBe(false);
    // testedAt is the benchmark's own completion time, not the publish time.
    expect(new Date(row.testedAt).getTime()).toBe(new Date(bench.finishedAt!).getTime());
    expect(new Date(row.publishedAt!).getTime()).toBeGreaterThanOrEqual(new Date(row.testedAt).getTime());

    // The listing now sells exactly that version under the v2 rules.
    const after = await listingRow(listingId);
    expect(after.listing.status).toBe("published");
    expect(after.v2?.publicationMode).toBe("v2");
    // No `certifying` transition was introduced for the v2 listing (§10.2).
    expect(after.listing.status).not.toBe("certifying");
    expect(after.v2?.currentWorkflowVersionId).toBe(versionId);
    expect(after.v2?.currentEvidencePublicationId).toBe(published.publicationId);
    expect(after.v2?.evidenceSummaryRevision).toBe(1);

    const again = await ev.publishVersion({
      userId: f.userId, listingId, workflowVersionId: versionId, benchmarkId,
      previewHash: preview.previewHash, consentVersion: "consent-v1",
    });
    expect(again.publicationId).toBe(published.publicationId);
    expect(again.reused).toBe(true);

    // A stale revision token cannot clobber the current pointer.
    await expect(ev.publishVersion({
      userId: f.userId, listingId, workflowVersionId: versionId, benchmarkId,
      previewHash: preview.previewHash, consentVersion: "consent-v1", expectedListingRevision: 0,
    })).rejects.toThrow(/revision_conflict/);
  });

  it("the v2Publication flag is a real gate: off means nothing can be made public", async () => {
    const f = await seedFixture();
    const { benchmarkId } = await completedBenchmark(f);
    const { listingId } = await seedListing(f);
    const preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", listingId, consentVersion: "consent-v1" });
    const versionId = Number(preview.manifest.versionIdentity.workflowVersionId);

    await setPublicationFlag(false);
    await expect(ev.publishVersion({
      userId: f.userId, listingId, workflowVersionId: versionId, benchmarkId,
      previewHash: preview.previewHash, consentVersion: "consent-v1",
    })).rejects.toThrow(/publication_disabled/);
    await expect(ev.publishCommunityEvidence({
      userId: f.userId, benchmarkId, previewHash: preview.previewHash, consentVersion: "consent-v1",
    })).rejects.toThrow(/publication_disabled/);
    await expect(ev.withdrawPublication({ userId: f.userId, publicationId: 1, reason: "test" }))
      .rejects.toThrow(/publication_disabled/);
    expect((await listingRow(listingId)).listing.status).toBe("draft");

    await setPublicationFlag(true);
    const ok = await ev.publishVersion({
      userId: f.userId, listingId, workflowVersionId: versionId, benchmarkId,
      previewHash: preview.previewHash, consentVersion: "consent-v1",
    });
    expect(ok.publicationId).toBeGreaterThan(0);
  });

  it("the legacy certification pipeline cannot touch a v2 listing's standing (plan §4)", async () => {
    const f = await seedFixture();
    const { benchmarkId } = await completedBenchmark(f);
    const { listingId } = await seedListing(f);
    const preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", listingId, consentVersion: "consent-v1" });
    await ev.publishVersion({
      userId: f.userId, listingId, workflowVersionId: Number(preview.manifest.versionIdentity.workflowVersionId),
      benchmarkId, previewHash: preview.previewHash, consentVersion: "consent-v1",
    });

    const guard = await import("./marketplacePublication");
    // Re-certifying, rejecting, requeueing or republishing through legacy flows: all refused.
    for (const status of ["certifying", "rejected", "published", "approved", "draft", "generating"] as const) {
      await expect(guard.setLegacyListingStatus(listingId, { status })).rejects.toThrow(/v2_publication_locked/);
    }
    // Delisting is the one legacy write a v2 listing still allows.
    await guard.setLegacyListingStatus(listingId, { status: "unpublished" });
    expect((await listingRow(listingId)).listing.status).toBe("unpublished");

    // A legacy listing (no v2 row) is untouched by the guard.
    const other = await seedListing(f);
    await guard.setLegacyListingStatus(other.listingId, { status: "certifying" });
    expect((await listingRow(other.listingId)).listing.status).toBe("certifying");
    expect(await guard.getPublicationMode(await connection(), other.listingId)).toBe("legacy");
  });

  it("public reads expose the manifest only, and withdrawal unpublishes in the same transaction", async () => {
    const f = await seedFixture();
    const { benchmarkId } = await completedBenchmark(f);
    const { listingId } = await seedListing(f);
    const preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", listingId, consentVersion: "consent-v1" });
    const published = await ev.publishVersion({
      userId: f.userId, listingId, workflowVersionId: Number(preview.manifest.versionIdentity.workflowVersionId),
      benchmarkId, previewHash: preview.previewHash, consentVersion: "consent-v1",
    });

    const manifest = await ev.getPublicEvidenceForListing(listingId);
    expect(manifest?.publicationKind).toBe("seller");
    expect(JSON.stringify(manifest)).not.toContain(SECRET_PROMPT.slice(0, 40));

    const summaries = await ev.listPublicEvidenceForListing(listingId, { kind: "seller" });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].state).toBe("published");
    // Summaries carry no private payload at all — only published manifest fields.
    expect(JSON.stringify(summaries)).not.toContain("systemPrompt");

    const withdrawn = await ev.withdrawPublication({ userId: f.userId, publicationId: published.publicationId, reason: "no longer supported" });
    expect(withdrawn.ok).toBe(true);
    // A10: the listing may not stay buyable with no current evidence.
    const after = await listingRow(listingId);
    expect(after.listing.status).toBe("unpublished");
    expect(after.v2?.currentEvidencePublicationId).toBeNull();
    expect(await ev.getPublicEvidenceForListing(listingId)).toBeNull();
    // The shop front's publication list asks for both kinds and does NOT hide
    // withdrawals: a reader handed a link deserves to learn the record was
    // pulled, rather than that it apparently never existed.
    const asTheListingPageSeesIt = await ev.listPublicEvidenceForListing(listingId, { includeWithdrawn: true, limit: 50 });
    expect(asTheListingPageSeesIt).toHaveLength(1);
    expect(asTheListingPageSeesIt[0]).toMatchObject({ publicationKind: "seller", state: "withdrawn" });
    expect(asTheListingPageSeesIt[0].withdrawnAt).not.toBeNull();
    // …while the default read still shows nothing published.
    expect(await ev.listPublicEvidenceForListing(listingId, {})).toHaveLength(0);
    // The withdrawn row is still addressable by hash — history is not deleted.
    const db = await connection();
    const [row] = await db.select().from(schema.evidencePublications).where(eq(schema.evidencePublications.id, published.publicationId)).limit(1);
    expect(row.state).toBe("withdrawn");
    expect(await ev.getPublishedManifestByHash(published.manifestHash)).toBeNull();
  });


  it("retains the purchased evidence after delisting without exposing it to strangers or refund recipients", async () => {
    const seller = await seedFixture();
    const buyer = await seedFixture();
    const stranger = await seedFixture();
    const { benchmarkId } = await completedBenchmark(seller);
    const { listingId } = await seedListing(seller);
    const preview = await ev.buildEvidencePreview({ userId: seller.userId, benchmarkId, publicationKind: "seller", listingId, consentVersion: "consent-v1" });
    const versionId = Number(preview.manifest.versionIdentity.workflowVersionId);
    const publication = await ev.publishVersion({
      userId: seller.userId, listingId, workflowVersionId: versionId, benchmarkId,
      previewHash: preview.previewHash, consentVersion: "consent-v1",
    });
    const { fulfillMarketplacePurchase } = await import("./entitlementSync");
    const { purchaseId } = await fulfillMarketplacePurchase({
      userId: buyer.userId, listingId, amountPaid: 4.99, stripeSessionId: `test-receipt-${listingId}`,
      stripePaymentIntentId: null,
    });
    const db = await connection();
    const [purchase] = await db.select().from(schema.marketplacePurchases).where(eq(schema.marketplacePurchases.id, purchaseId));
    expect(purchase.workflowVersionId).toBe(versionId);
    expect(purchase.evidencePublicationId).toBe(publication.publicationId);
    const original = (await publicationRow(publication.publicationId)).publicManifest;
    await ev.withdrawPublication({ userId: seller.userId, publicationId: publication.publicationId, reason: "Seller no longer offers this version" });
    expect(await ev.getPublishedManifestByHash(publication.manifestHash)).toBeNull();
    expect(await ev.getPublicEvidenceForListing(listingId)).toBeNull();
    expect(await ev.getEvidenceForViewer({ userId: stranger.userId, publicationId: publication.publicationId })).toBeNull();
    expect(await ev.getPurchasedEvidenceForListing({ userId: stranger.userId, listingId })).toBeNull();
    const receipt = await ev.getPurchasedEvidenceForListing({ userId: buyer.userId, listingId });
    expect(receipt?.state).toBe("withdrawn");
    expect(receipt?.withdrawnAt).toBeTruthy();
    expect(receipt?.manifestHash).toBe(publication.manifestHash);
    expect(receipt?.versionBinding).toBe("purchase_receipt");
    expect(receipt?.manifest).toEqual(JSON.parse(String(original)));
    expect((await publicationRow(publication.publicationId)).publicManifest).toBe(original);
    const { getPublicEvidenceTool } = await import("../mcp/tools/publicationTools");
    const context = { userId: buyer.userId, scopes: new Set(["mcp:read"]), clientId: "test", requestId: "receipt", locale: "en" as const };
    expect(await getPublicEvidenceTool.handler({ listingId }, context)).toMatchObject({ purchasedEvidence: { state: "withdrawn", manifestHash: publication.manifestHash } });
    expect(await getPublicEvidenceTool.handler({ publicationId: publication.publicationId }, context)).toMatchObject({ state: "withdrawn" });
    await expect(getPublicEvidenceTool.handler({ publicationId: publication.publicationId }, { ...context, userId: stranger.userId })).rejects.toThrow(/not_found_or_not_authorized/);
    await expect(fulfillMarketplacePurchase({ userId: stranger.userId, listingId, amountPaid: 4.99, stripeSessionId: "test-delisted", stripePaymentIntentId: null }))
      .rejects.toThrow(/not buyable/);
    await db.update(schema.marketplacePurchases).set({ status: "refunded" }).where(eq(schema.marketplacePurchases.id, purchaseId));
    expect(await ev.getPurchasedEvidenceForListing({ userId: buyer.userId, listingId })).toBeNull();
    expect(await ev.getEvidenceForViewer({ userId: buyer.userId, manifestHash: publication.manifestHash })).toBeNull();
    expect(await ev.getEvidenceForViewer({ userId: seller.userId, publicationId: publication.publicationId })).not.toBeNull();
  });

  it("a stranger cannot publish someone else's benchmark, and cannot read its manifest", async () => {
    const owner = await seedFixture();
    const intruder = await seedFixture();
    const { benchmarkId } = await completedBenchmark(owner);
    await expect(ev.buildEvidencePreview({
      userId: intruder.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1",
    })).rejects.toThrow(/not_found_or_not_authorized/);
  });

  it("refuses a seller publication whose evidence is graded from existing outputs only (§4.3)", async () => {
    const f = await seedFixture();
    const db = await connection();
    // Prior owned output to import.
    const [run] = await db.insert(schema.swarmRuns).values({ projectId: f.projectId, userId: f.userId, userPrompt: "earlier", status: "completed" });
    const swarmRunId = Number((run as { insertId: number }).insertId);
    const [ar] = await db.insert(schema.agentRuns).values({
      swarmRunId, projectId: f.projectId, agentName: "Earlier", agentRole: "builder", pipelineStep: 1, userPrompt: "earlier", status: "completed",
    });
    const [resp] = await db.insert(schema.agentResponses).values({
      agentRunId: Number((ar as { insertId: number }).insertId), swarmRunId, projectId: f.projectId,
      responseType: "final", content: "a result from last week",
      metadata: {
        model: "older-model", provider: "fake", providerSlug: "fake",
        tokensUsed: { prompt: 1, completion: 1, total: 2 }, latencyMs: 1, temperature: 0.7, maxTokens: 512,
        agentName: "Earlier", agentRole: "builder", agentSlug: "earlier", pipelineStep: 1, iteration: 1,
        buildMethod: "manual", sourceResponseIds: [],
      },
    });

    const benchmarkId = await svc.createBenchmarkDraft({
      userId: f.userId, projectId: f.projectId,
      cases: [{ inputText: "clause one" }],
      judges: [{ providerId: f.providerId, model: "judge-model" }],
      candidates: [{ label: "last-week", existingResponseId: Number((resp as { insertId: number }).insertId) }],
    });
    const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    const approval = await svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: quote.planHash });
    await svc.startBenchmark({ userId: f.userId, benchmarkId, planHash: quote.planHash, spendApprovalId: approval });
    const lease = await svc.acquireBenchmark(benchmarkId);
    await svc.executeBenchmark({ benchmarkId, leaseToken: lease! });

    // There is no manifest to disclose at all: without an executed version
    // the §4.3 gate is a refusal at the preview, so it cannot be published by
    // either boundary — and there is no version to even name in a seller call.
    await expect(ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1" }))
      .rejects.toThrow(/not_publishable/);
    await expect(ev.publishCommunityEvidence({
      userId: f.userId, benchmarkId, previewHash: "0".repeat(64), consentVersion: "consent-v1",
    })).rejects.toThrow(/not_publishable|preview_changed/);
  });

  it("refuses to publish a manifest that would leak a credential, and offers the limited path instead", async () => {
    const f = await seedFixture();
    const benchmarkId = await svc.createBenchmarkDraft({
      userId: f.userId, projectId: f.projectId,
      // The secret is in the TEST INPUT this time, which is published material.
      cases: [{ inputText: "translate this; token sk-ABCDEFGHIJKL1234567890 attached" }],
      // Evidence-grade panel on purpose: the refusal under test must be the
      // SECRET, not the panel — the panel gate would otherwise fire first.
      judges: evidencePanel(f),
    });
    const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    const approval = await svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: quote.planHash });
    await svc.startBenchmark({ userId: f.userId, benchmarkId, planHash: quote.planHash, spendApprovalId: approval });
    const lease = await svc.acquireBenchmark(benchmarkId);
    await svc.executeBenchmark({ benchmarkId, leaseToken: lease! });

    const { listingId } = await seedListing(f);
    const preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", listingId, consentVersion: "consent-v1" });
    expect(preview.secretFindings).toContain("api-key-shaped token");
    await expect(ev.publishVersion({
      userId: f.userId, listingId, workflowVersionId: Number(preview.manifest.versionIdentity.workflowVersionId),
      benchmarkId, previewHash: preview.previewHash, consentVersion: "consent-v1",
    })).rejects.toThrow(/api-key-shaped token/);
    expect((await listingRow(listingId)).listing.status).toBe("draft");

    // Withholding the inputs is allowed, but the resulting limited report can
    // never BE the seller's qualifying evidence — refused with the §7.3 reason.
    await expect(ev.buildEvidencePreview({
      userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1",
      withholdInputs: true, withheldReason: "case text contains a customer token",
    })).rejects.toThrow(/limited-disclosure report cannot satisfy the v2 seller gate/);

    // As community evidence the same withheld report is honest and publishable.
    const limited = await ev.buildEvidencePreview({
      userId: f.userId, benchmarkId, publicationKind: "community", consentVersion: "consent-v1",
      withholdInputs: true, withheldReason: "case text contains a customer token",
    });
    expect(limited.disclosureClass).toBe("limited");
    expect(limited.secretFindings).toEqual([]);
    expect(limited.manifest.cases.every((c) => c.inputText === null)).toBe(true);
    const community = await ev.publishCommunityEvidence({
      userId: f.userId, benchmarkId, previewHash: limited.previewHash, consentVersion: "consent-v1",
      withholdInputs: true, withheldReason: "case text contains a customer token",
    });
    expect(community.publicationId).toBeGreaterThan(0);
    const stored = await publicationRow(community.publicationId);
    expect(stored.provenance).toBe("platform_recorded");
    expect(JSON.parse(String(stored.publicManifest)).costs.currency).toBe("USD");
  });

  it("D12: a private single-judge panel runs fine but its result is NOT publishable as evidence, by either boundary", async () => {
    const f = await seedFixture();
    // The finding-5 shape: one judge, self-graded, everything else complete.
    const benchmarkId = await svc.createBenchmarkDraft({
      userId: f.userId, projectId: f.projectId,
      cases: [{ inputText: "clause one" }, { inputText: "clause two" }],
      judges: [{ providerId: f.providerId, model: "judge-model" }],
    });
    const quote = await svc.quoteBenchmark({ userId: f.userId, benchmarkId });
    // Private evaluation stays fully quotable/approvable/runnable:
    expect(quote.blockingErrors).toEqual([]);
    expect(quote.panel.evidenceGrade).toBe(false);
    expect(quote.warnings.join(" ")).toContain("private-only panel (D12)");
    const approval = await svc.approveBenchmarkSpend({ userId: f.userId, benchmarkId, planHash: quote.planHash });
    const started = await svc.startBenchmark({ userId: f.userId, benchmarkId, planHash: quote.planHash, spendApprovalId: approval });
    expect(started.ok).toBe(true);
    const lease = await svc.acquireBenchmark(benchmarkId);
    await svc.executeBenchmark({ benchmarkId, leaseToken: lease! });

    const preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "community", consentVersion: "consent-v1" });
    expect(preview.evidenceGradePanel).toBe(false);
    expect(preview.panelIssues.join(" ")).toContain("panel_needs_three_judges");
    await expect(ev.publishCommunityEvidence({
      userId: f.userId, benchmarkId, previewHash: preview.previewHash, consentVersion: "consent-v1",
    })).rejects.toThrow(/publication_refused: the judging panel of this evidence is not evidence-grade \(decision D12\)/);

    // Same refusal on the seller side, with the "run an evidence-grade panel
    // or keep it private" sentence a user can act on.
    const { listingId } = await seedListing(f);
    const sellerPreview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", listingId, consentVersion: "consent-v1" });
    await expect(ev.publishVersion({
      userId: f.userId, listingId, workflowVersionId: Number(sellerPreview.manifest.versionIdentity.workflowVersionId),
      benchmarkId, previewHash: sellerPreview.previewHash, consentVersion: "consent-v1",
    })).rejects.toThrow(/keep this result private/);
  });

  it("D12: an evidence-grade panel gets nine ratings per output, and each variant is disclosed", async () => {
    const f = await seedFixture();
    const { benchmarkId } = await completedBenchmark(f);
    const db = await connection();
    const judgments = await db.select().from(schema.benchmarkJudgments).where(eq(schema.benchmarkJudgments.benchmarkId, benchmarkId));
    // 2 cases × 1 candidate × 1 repeat × 3 judges × 3 variants — the money
    // rule: the approved arithmetic is exactly what ran.
    expect(judgments).toHaveLength(18);
    expect(new Set(judgments.map((j) => j.judgePromptVersion))).toEqual(new Set([
      "judge-v1:anchored_scale", "judge-v1:comment_first", "judge-v1:checklist_first",
    ]));
    // every (run, slot, variant) triple appears exactly once
    const keys = judgments.map((j) => `${j.runId}|${j.judgeSlot}|${j.judgePromptVersion}`);
    expect(new Set(keys).size).toBe(18);
    const preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", consentVersion: "consent-v1" });
    // §7.3: the reader sees all three exact prompt templates, each tagged.
    expect(preview.manifest.judging.judgePrompts.map((p) => p.judgePromptVersion)).toEqual([
      "judge-v1:anchored_scale", "judge-v1:comment_first", "judge-v1:checklist_first",
    ]);
    expect(JSON.stringify(preview.manifest)).toContain("SCORING PROCEDURE (checklist_first)");
    expect(JSON.stringify(preview.manifest)).toContain("SCORING PROCEDURE (comment_first)");
  });

  it("withdrawal and replacement are separate immutable rows; testedAt never moves", async () => {
    const f = await seedFixture();
    const { benchmarkId } = await completedBenchmark(f);
    const { listingId } = await seedListing(f);
    const preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", listingId, consentVersion: "consent-v1" });
    const versionId = Number(preview.manifest.versionIdentity.workflowVersionId);
    const first = await ev.publishVersion({
      userId: f.userId, listingId, workflowVersionId: versionId, benchmarkId,
      previewHash: preview.previewHash, consentVersion: "consent-v1",
    });
    const firstRow = await publicationRow(first.publicationId);

    // consentVersion is part of the disclosed document, so the replacement must
    // be previewed UNDER consent-v2 — otherwise the hash legitimately differs.
    const v2Preview = await ev.buildEvidencePreview({ userId: f.userId, benchmarkId, publicationKind: "seller", listingId, consentVersion: "consent-v2" });
    const replaced = await ev.supersedePublication({
      userId: f.userId, supersededPublicationId: first.publicationId, benchmarkId, listingId,
      workflowVersionId: versionId, previewHash: v2Preview.previewHash, consentVersion: "consent-v2",
      expectedListingRevision: first.evidenceSummaryRevision,
    });
    expect(replaced.publicationId).not.toBe(first.publicationId);
    const oldRow = await publicationRow(first.publicationId);
    const newRow = await publicationRow(replaced.publicationId);
    expect(oldRow.state).toBe("withdrawn");
    expect(oldRow.withdrawalReason).toContain("superseded by");
    expect(newRow.state).toBe("published");
    expect(newRow.supersedesPublicationId).toBe(first.publicationId);
    expect(newRow.consentVersion).toBe("consent-v2");
    // Same test, same test date — only the publication date is new.
    expect(new Date(newRow.testedAt).getTime()).toBe(new Date(firstRow.testedAt).getTime());
    expect((await listingRow(listingId)).v2?.evidenceSummaryRevision).toBe(2);

    const withdrawn = await ev.withdrawPublication({ userId: f.userId, publicationId: replaced.publicationId, reason: "seller withdrew" });
    expect(withdrawn.ok).toBe(true);
    expect((await publicationRow(replaced.publicationId)).state).toBe("withdrawn");
    // The listing the withdrawn manifest supported is no longer buyable.
    expect((await listingRow(listingId)).listing.status).toBe("unpublished");
  });
  it("hands a whole evaluation to the client as files it can verify (local-archive half of #69)", async () => {
    const { createHash } = await import("node:crypto");
    const f = await seedFixture();
    const { benchmarkId } = await completedBenchmark(f);
    const bx = await import("./benchmark/benchmarkExport");
    const { archive, benchmark } = await bx.exportBenchmarkArchive({ userId: f.userId, benchmarkId });

    const paths = archive.files.map((x) => x.path);
    expect(paths).toContain("plan.json");
    // D12: the reader gets every framing the panel used, not one representative.
    expect(paths.filter((x) => x.startsWith("judge-prompts/"))).toHaveLength(3);
    expect(paths.filter((x) => x.startsWith("cases/")).length).toBeGreaterThan(0);
    expect(paths).toEqual(expect.arrayContaining(["judgments.json", "ledger.json", "manifest.json", "benchmark.json"]));
    const prompt = archive.files.find((x) => x.path.startsWith("judge-prompts/"))!;
    expect(prompt.content).toContain("{{CANDIDATE_OUTPUT}}");   // the template, not a summary of it

    for (const file of archive.files) {
      expect(file.bytes).toBe(Buffer.byteLength(file.content, "utf8"));
      expect(file.sha256).toBe(createHash("sha256").update(file.content, "utf8").digest("hex"));
    }
    // The hash a third party will match published evidence against, and the
    // execution credential that must never travel.
    expect(String(benchmark.planHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(JSON.parse(archive.files.find((x) => x.path === "benchmark.json")!.content))).not.toContain("leaseToken");

    // Another account is refused exactly as a non-existent benchmark would be.
    const stranger = await seedFixture();
    await expect(bx.exportBenchmarkArchive({ userId: stranger.userId, benchmarkId }))
      .rejects.toThrow(/not_found_or_not_authorized/);
  });
});

