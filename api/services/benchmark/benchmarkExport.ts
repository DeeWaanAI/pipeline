// ═══════════════════════════════════════════════════════════════════
//  BENCHMARK EXPORT — one private evaluation as a local archive
// ═══════════════════════════════════════════════════════════════════
// `export_run` can already hand a RUN to the user's folder. A BENCHMARK could
// not be handed over at all, which is the wrong way round for the owner's
// purpose: a benchmark is where the research lives — the frozen plan, the case
// inputs, every candidate output, every judgment, the cost ledger, and the
// judging prompts themselves. Losing those is losing the work.
//
// The builder is pure and takes no connection, so the byte-for-byte shape of the
// archive is unit-testable, and the only thing the caller can get wrong is which
// rows it fetched.
//
// Two rules the builder exists to enforce:
//  · A content column that is NULL is reported as missing, never written as an
//    empty file. A swept body and a body that was always absent have to look
//    different in the manifest, or a user reads a silent gap as "that's all
//    there was".
//  · The lease token never leaves the server. It is an execution credential, not
//    the user's data.

import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  benchmarkCandidates, benchmarkCases, benchmarkJudgments, benchmarkRuns,
  benchmarks, callAttempts,
} from "@db/schema";
import type { BenchmarkCallPlan } from "./benchmarkTypes";
import { logger } from "../../lib/logger";
import { previewJudgePrompts } from "./judgeService";

export interface ArchiveFile {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
}

export interface BenchmarkArchiveInput {
  benchmark: Record<string, unknown> & { id: number };
  plan: BenchmarkCallPlan | null;
  judgePrompts: Array<{ promptVersion: string; messages: Array<{ role: string; content: string }> }>;
  cases: Array<Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  judgments: Array<Record<string, unknown>>;
  attempts: Array<Record<string, unknown>>;
  exportedAt: string;
}

/** ':' and '/' appear in prompt version tags (`judge-v1:anchored_scale:<hash>`),
 *  and ':' is illegal in a filename on Windows and hostile in a shell. The
 *  un-sanitized version stays in the file body and in the manifest. */
function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** The benchmark row as it may be written to disk. Redaction lives HERE rather
 *  than only in the loader: the builder is the last place that knows the bytes
 *  are about to leave the server, so a future caller that hands it a full row
 *  cannot ship an execution credential by accident. `leaseToken` authorizes a
 *  worker to run the benchmark — it is not the user's data. */
function publicBenchmarkRow(row: BenchmarkArchiveInput["benchmark"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (/token|secret|credential|apiKeyRef/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function buildBenchmarkArchive(input: BenchmarkArchiveInput) {
  const files: ArchiveFile[] = [];
  const missing: Array<{ path: string; reason: string }> = [];
  const add = (path: string, content: string) => {
    files.push({
      path,
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    });
  };
  const json = (path: string, value: unknown) => add(path, JSON.stringify(value, null, 2));

  const caseIdToStable = new Map<number, string>();
  for (const c of input.cases) {
    if (typeof c.id === "number" && typeof c.stableCaseId === "string") caseIdToStable.set(c.id, c.stableCaseId);
  }
  const candidateIdToStable = new Map<number, string>();
  for (const c of input.candidates) {
    if (typeof c.id === "number" && typeof c.stableCandidateId === "string") candidateIdToStable.set(c.id, c.stableCandidateId);
  }

  json("benchmark.json", publicBenchmarkRow(input.benchmark));

  if (input.plan) json("plan.json", input.plan);
  else missing.push({ path: "plan.json", reason: "no frozen plan — this benchmark was never started, so nothing was frozen" });

  input.judgePrompts.forEach((p, index) => {
    const body = [
      `# Judge prompt ${p.promptVersion}`,
      "",
      ...p.messages.map((m) => `## ${m.role.toUpperCase()}\n\n${m.content}`),
      "",
    ].join("\n");
    add(`judge-prompts/${String(index + 1).padStart(2, "0")}-${safeName(p.promptVersion)}.md`, body);
  });
  if (input.cases.length) {
    json("cases.json", input.cases);
    input.cases.forEach((c, index) => {
      const stable = str(c.stableCaseId) ?? `case-${index + 1}`;
      const text = str(c.inputText);
      if (text === null) {
        missing.push({
          path: `cases/${stable}.txt`,
          reason: c.inputArtifactRef
            ? "the input body lives in an artifact reference, not in this row"
            : "no input text stored for this case",
        });
        return;
      }
      add(`cases/${String(index + 1).padStart(3, "0")}-${safeName(stable)}.txt`, text);
    });
  }
  if (input.candidates.length) json("candidates.json", input.candidates);

  input.runs.forEach((r, index) => {
    const stableCase = caseIdToStable.get(num(r.caseId) ?? -1) ?? `case-${String(num(r.caseId) ?? index + 1)}`;
    const stableCandidate = candidateIdToStable.get(num(r.candidateId) ?? -1) ?? `candidate-${String(num(r.candidateId) ?? index + 1)}`;
    const rep = num(r.replicationIndex) ?? 1;
    const text = str(r.outputText);
    if (text === null) {
      missing.push({
        path: `outputs/${safeName(stableCandidate)}__${safeName(stableCase)}__rep${rep}.txt`,
        reason: r.status === "completed"
          ? "a completed run with no stored output text — its content was swept from the server earlier; the run record below still carries its hash"
          : `run status is ${str(r.status) ?? "unknown"}, so no output was produced`,
      });
    } else {
      add(`outputs/${safeName(stableCandidate)}__${safeName(stableCase)}__rep${rep}.txt`, text);
    }
  });
  if (input.runs.length) json("runs.json", input.runs);
  if (input.judgments.length) json("judgments.json", input.judgments);
  else missing.push({ path: "judgments.json", reason: "no judgments recorded — the judging phase never completed" });
  if (input.attempts.length) json("ledger.json", input.attempts);

  const runsWithLinkedRuns = input.runs
    .map((r) => num(r.linkedSwarmRunId))
    .filter((v): v is number => typeof v === "number");
  if (runsWithLinkedRuns.length) {
    json("linked-runs.json", {
      note: "Each entry is a pipeline run of this benchmark. Its step-by-step intermediates (per-step prompts, context input, tokens, latency) are NOT in this archive — call export_run for that id to get them.",
      linkedSwarmRunIds: runsWithLinkedRuns,
    });
  }

  json("manifest.json", {
    version: 1,
    kind: "benchmark",
    benchmarkId: input.benchmark.id,
    planHash: str(input.benchmark.planHash) ?? null,
    state: str(input.benchmark.state) ?? null,
    exportedAt: input.exportedAt,
    encoding: "utf8",
    counts: {
      cases: input.cases.length,
      candidates: input.candidates.length,
      runs: input.runs.length,
      judgments: input.judgments.length,
      ledgerRows: input.attempts.length,
      judgePromptVariants: input.judgePrompts.length,
    },
    // Declared before the client writes anything: a gap the user learns about
    // afterwards is not a disclosure.
    incomplete: missing,
    files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  });

  return {
    directoryName: `benchmark-${input.benchmark.id}`,
    encoding: "utf8" as const,
    localWriteRequired: true,
    incomplete: missing,
    files,
    instructions:
      "Use the client's filesystem tools to create this directory inside the user's selected folder. Write each content string exactly as UTF-8, without an added newline. Never overwrite an existing file silently — report the collision and ask. Read back each file's byte count and SHA-256 and compare them to manifest.json before reporting success. Report every entry in `incomplete` to the user: those are bodies the server no longer holds, and they cannot be recovered here. If the client cannot write files, say so plainly. This archive does not delete any server-side data; a sweep is a separate, explicit action.",
  };
}

/**
 * Owner-only projection of one benchmark and everything hanging off it.
 * Ownership is checked before any content is read, and the refusal is the same
 * for "not yours" and "does not exist" — a benchmark id is not public.
 */
export async function loadBenchmarkForExport(opts: { userId: number; benchmarkId: number }) {
  const db = getDb();
  const [bench] = await db.select().from(benchmarks)
    .where(eq(benchmarks.id, opts.benchmarkId)).limit(1);
  if (!bench || bench.ownerId !== opts.userId) throw new Error("not_found_or_not_authorized");

  const [cases, candidates, runs, judgments, attempts] = await Promise.all([
    db.select().from(benchmarkCases).where(eq(benchmarkCases.benchmarkId, bench.id)).orderBy(asc(benchmarkCases.caseOrder)),
    db.select().from(benchmarkCandidates).where(eq(benchmarkCandidates.benchmarkId, bench.id)),
    db.select().from(benchmarkRuns).where(eq(benchmarkRuns.benchmarkId, bench.id)),
    db.select().from(benchmarkJudgments).where(eq(benchmarkJudgments.benchmarkId, bench.id)),
    db.select().from(callAttempts).where(eq(callAttempts.benchmarkId, bench.id)),
  ]);

  // The builder is the one that decides what may leave the server (see
  // `publicBenchmarkRow`), so the row is handed over as loaded.
  let plan: BenchmarkCallPlan | null = null;
  try {
    if (bench.plan) plan = JSON.parse(String(bench.plan)) as BenchmarkCallPlan;
  } catch {
    plan = null;
    logger.warn("Benchmark plan could not be parsed for export", { benchmarkId: bench.id });
  }

  const judgePrompts = plan
    ? previewJudgePrompts({
      rubric: plan.rubric,
      judges: plan.judges,
      judgmentKind: plan.judgmentKind,
      judgePromptOverrides: plan.judgePromptOverrides,
      executionMode: plan.executionMode,
    }).map((p) => ({ promptVersion: p.promptVersion, messages: p.messages }))
    : [];

  // Runs may reference linked pipeline runs. Their step-by-step intermediates are
  // NOT copied here — `export_run` is the one projection that knows what a
  // caller may see about a run, so the archive names the ids and stops there.
  return {
    benchmark: bench as unknown as Record<string, unknown> & { id: number },
    plan,
    judgePrompts,
    cases: cases as unknown as Array<Record<string, unknown>>,
    candidates: candidates as unknown as Array<Record<string, unknown>>,
    runs: runs as unknown as Array<Record<string, unknown>>,
    judgments: judgments as unknown as Array<Record<string, unknown>>,
    attempts: attempts as unknown as Array<Record<string, unknown>>,
    exportedAt: new Date().toISOString(),
  };
}

export async function exportBenchmarkArchive(opts: { userId: number; benchmarkId: number }) {
  const data = await loadBenchmarkForExport(opts);
  logger.info("Benchmark exported for local archive", {
    userId: opts.userId,
    benchmarkId: opts.benchmarkId,
    files: buildBenchmarkArchive(data).files.length,
  });
  return { version: 1, ...data, archive: buildBenchmarkArchive(data) };
}
