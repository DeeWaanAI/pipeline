// The archive is what a user keeps when the platform stops being the store, so
// these tests are about completeness and honesty of the manifest, not formatting:
// a body that is gone must be NAMED as gone, and nothing secret may ride along.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildBenchmarkArchive, type BenchmarkArchiveInput } from "./benchmarkExport";
import { costDisclosure } from "./benchmarkLedger";

const PLAN_HASH = "a".repeat(64);

/** The disclosure the loader would reduce from these rows: 1 recorded operation,
 *  none of them priced — the shape that reads as "$0.00 spent" without a sentence. */
const partialCost = costDisclosure({
  totalCalls: 1, uncertainCalls: 0, pricedOperations: 0,
  knownCostUsd: "0.00000000", costCompleteness: "partial", pricingBases: [],
});

function input(overrides: Partial<BenchmarkArchiveInput> = {}): BenchmarkArchiveInput {
  return {
    benchmark: {
      id: 7, ownerId: 3, state: "completed", planHash: PLAN_HASH,
      executionMode: "grade_only", leaseToken: "lease-secret-do-not-export",
      totalObservedCost: "0.05", summary: { cases: 1 },
    },
    plan: {
      rubric: { versionRef: "preset-generic-v1", dimensions: [] },
      judges: [{ slot: 1, providerId: 4, model: "glm-5.2" }],
      judgmentKind: "rubric", executionMode: "grade_only",
    } as unknown as BenchmarkArchiveInput["plan"],
    judgePrompts: [
      { promptVersion: "judge-v1:anchored_scale:9f2c", messages: [
        { role: "system", content: "Score strictly by the rubric." },
        { role: "user", content: "Input: {{TASK_INPUT}}\nOutput: {{CANDIDATE_OUTPUT}}" },
      ] },
      { promptVersion: "judge-v1:narrative_first", messages: [{ role: "system", content: "Describe before scoring." }] },
    ],
    cases: [{ id: 1, stableCaseId: "case-1", caseOrder: 0, inputText: "Translate this contract.", origin: "user", expectedOutput: null }],
    candidates: [{ id: 1, stableCandidateId: "cand-solo", strategy: "solo" }],
    runs: [
      { id: 1, caseId: 1, candidateId: 1, replicationIndex: 1, status: "completed", outputText: "Translated contract.", linkedSwarmRunId: 55 },
      { id: 2, caseId: 1, candidateId: 1, replicationIndex: 2, status: "completed", outputText: null, linkedSwarmRunId: null },
    ],
    judgments: [{ id: 1, runId: 1, judgeSlot: 1, judgeModel: "glm-5.2", judgePromptVersion: "judge-v1:anchored_scale:9f2c", status: "completed" }],
    attempts: [{ id: 1, operationKind: "judgment", outcome: "success", estimatedCostUsd: "0.01" }],
    cost: partialCost,
    exportedAt: "2026-10-11T12:00:00.000Z",
    ...overrides,
  };
}

const manifestOf = (a: ReturnType<typeof buildBenchmarkArchive>) =>
  JSON.parse(a.files.find((f) => f.path === "manifest.json")!.content);

const paths = (a: ReturnType<typeof buildBenchmarkArchive>) => a.files.map((f) => f.path);

describe("the benchmark archive", () => {
  it("carries the plan, the judging prompts in full, the outputs, the judgments and the ledger", () => {
    const a = buildBenchmarkArchive(input());
    expect(paths(a)).toEqual(expect.arrayContaining([
      "benchmark.json", "plan.json", "cases.json", "candidates.json", "runs.json",
      "judgments.json", "ledger.json", "manifest.json", "linked-runs.json",
    ]));
    const prompt = a.files.find((f) => f.path.endsWith("anchored_scale-9f2c.md"))!;
    expect(prompt.content).toContain("Score strictly by the rubric.");
    expect(prompt.content).toContain("judge-v1:anchored_scale:9f2c");   // full version survives in the body
    expect(prompt.content).toContain("{{CANDIDATE_OUTPUT}}");           // the template, not a paraphrase
    const output = a.files.find((f) => f.path.startsWith("outputs/"))!;
    expect(output.content).toBe("Translated contract.");
  });

  it("writes filesystem-safe names for prompt versions that contain ':'", () => {
    const a = buildBenchmarkArchive(input());
    for (const f of a.files) {
      expect(f.path).not.toMatch(/:/);
      expect(f.path).not.toMatch(/(^|\/)\.\.(\/|$)/);
    }
  });

  it("names a body the server no longer holds instead of writing an empty file", () => {
    const a = buildBenchmarkArchive(input());
    expect(a.files.some((f) => f.path.startsWith("outputs/") && f.content === "")).toBe(false);
    const swept = a.incomplete.find((m) => m.path.includes("rep2"));
    expect(swept?.reason).toMatch(/swept from the server/);
    const manifest = JSON.parse(a.files.find((f) => f.path === "manifest.json")!.content);
    expect(manifest.incomplete).toHaveLength(a.incomplete.length);
    expect(manifest.counts).toMatchObject({ cases: 1, candidates: 1, runs: 2, judgments: 1, ledgerRows: 1, judgePromptVariants: 2 });
  });

  it("says a draft never had a plan, rather than exporting a silent hole", () => {
    const a = buildBenchmarkArchive(input({ plan: null, judgePrompts: [] }));
    expect(paths(a)).not.toContain("plan.json");
    expect(a.incomplete.find((m) => m.path === "plan.json")?.reason).toMatch(/never started/);
  });

  it("keeps the execution lease token on the server", () => {
    const a = buildBenchmarkArchive(input());
    for (const f of a.files) expect(f.content).not.toContain("lease-secret-do-not-export");
  });

  it("hashes what it ships, so a client can prove it wrote the bytes", () => {
    const a = buildBenchmarkArchive(input());
    const manifest = JSON.parse(a.files.find((f) => f.path === "manifest.json")!.content);
    for (const entry of manifest.files) {
      const file = a.files.find((f) => f.path === entry.path)!;
      expect(Buffer.byteLength(file.content, "utf8")).toBe(entry.bytes);
      expect(createHash("sha256").update(file.content, "utf8").digest("hex")).toBe(entry.sha256);
    }
    expect(manifest.directoryName ?? a.directoryName).toBe("benchmark-7");
    expect(manifest.planHash).toBe(PLAN_HASH);
  });

  it("points at export_run for step intermediates without inlining them", () => {
    const a = buildBenchmarkArchive(input());
    const linked = JSON.parse(a.files.find((f) => f.path === "linked-runs.json")!.content);
    expect(linked.linkedSwarmRunIds).toEqual([55]);
    expect(paths(a).some((p) => p.startsWith("steps/"))).toBe(false);
  });
});

// Why the cost is rebuilt rather than read off the row: `benchmarks.summary` and
// `total_observed_cost` are written once at finalisation, and every benchmark that
// finalised before the FLOOR wording shipped carries a bare `0.00000000` with a
// `partial` flag and no sentence saying which it is. An archive that a buyer reads
// without the platform present cannot afford the misreading.
describe("the cost a local archive carries", () => {
  it("puts the FLOOR sentence in the manifest next to the figure", () => {
    const a = buildBenchmarkArchive(input());
    const manifest = manifestOf(a);
    expect(manifest.cost.display).toMatch(/FLOOR and not the total owed/);
    expect(manifest.cost.knownUsd).toBeNull();
    expect(manifest.cost.pricedSoFarUsd).toBe("0.00000000");
    expect(manifest.cost.unpricedOperations).toBe(1);
    expect(a.instructions).toContain("manifest.cost.display");
  });

  it("says so plainly when every operation is priced", () => {
    const a = buildBenchmarkArchive(input({
      cost: costDisclosure({
        totalCalls: 4, uncertainCalls: 0, pricedOperations: 4,
        knownCostUsd: "0.02535202", costCompleteness: "complete", pricingBases: ["platform price vector v12"],
      }),
    }));
    const manifest = manifestOf(a);
    expect(manifest.cost.display).toBe(
      "$0.02535202 across 4 recorded operations, all of them priced priced from platform price vector v12.",
    );
    expect(manifest.cost.display).not.toMatch(/FLOOR/);
  });

  it("does not call a pre-start benchmark's zero a cost", () => {
    const a = buildBenchmarkArchive(input({
      attempts: [],
      cost: costDisclosure({
        totalCalls: 0, uncertainCalls: 0, pricedOperations: 0,
        knownCostUsd: "0.00000000", costCompleteness: "unknown", pricingBases: [],
      }),
    }));
    const manifest = manifestOf(a);
    expect(manifest.cost.display).toMatch(/nothing has been spent/i);
    expect(manifest.costBasis).toMatch(/reduced from this archive's own ledger.json/);
  });

  it("hashes the cost block like every other declared byte", () => {
    const a = buildBenchmarkArchive(input());
    const manifest = manifestOf(a);
    const file = a.files.find((f) => f.path === "manifest.json")!;
    expect(manifest.files.some((e: { path: string }) => e.path === "manifest.json")).toBe(false);
    expect(createHash("sha256").update(file.content, "utf8").digest("hex")).toBe(file.sha256);
    expect(file.content).toContain("FLOOR");
  });
});
