// ═══════════════════════════════════════════════════════════════════
//  STORAGE INVENTORY — what we hold, for whom, and why we hold it
// ═══════════════════════════════════════════════════════════════════
// The local-archive decision ("the user's folder is the archive") is a size
// argument as much as an ownership one, and nobody has measured it. This module
// is that measurement: bytes per account, grouped by the reason the bytes are
// here, so a sweep decision is a number rather than a feeling.
//
// Grouping is the point. `live-work` and `research` are the user's own weight —
// the part the folder should carry. `hosted-for-others` is what must stay here
// even after a sweep, because a buyer, a published listing or a refund window
// depends on it. Lumping the two together is how "delete the data" turns into
// "delete the evidence a customer relied on".
//
// MySQL's LENGTH() is bytes for utf8mb4 columns, so the totals are storage-
// relevant, not character counts. Every probe filters on an ownership column;
// none of them reach another account's work.

import { sql } from "drizzle-orm";
import { getDb, isSqlite } from "../queries/connection";
import { logger } from "../lib/logger";

export type HoldingGroup = "live-work" | "research" | "hosted-for-others";

export interface Holding {
  group: HoldingGroup;
  /** What the bytes actually are, in words a user can act on. */
  label: string;
  table: string;
  rows: number;
  bytes: number;
  /** Why this is here at all — and whether a sweep is allowed to touch it. */
  note: string;
}

const byteSum = (columns: string[]) =>
  sql`COALESCE(SUM(${sql.raw(columns.map((c) => `COALESCE(LENGTH(${c}), 0)`).join(" + "))}), 0)`;

interface Probe {
  group: HoldingGroup;
  label: string;
  table: string;
  note: string;
  /** `:uid` is the account being measured. */
  query: ReturnType<typeof sql>;
}

const probes = (uid: number): Probe[] => [
  {
    group: "live-work", label: "Pipeline runs — the brief you sent, and run state", table: "swarm_runs",
    note: "Yours. Delivered to your folder by export_run; a sweep may drop the body and keep the row's identity for the cost ledger.",
    query: sql`SELECT COUNT(*) AS rows_, ${byteSum(["user_prompt", "execution_state", "run_params", "error"])} AS bytes
      FROM swarm_runs WHERE user_id = ${uid}`,
  },
  {
    group: "live-work", label: "Step intermediates — prompts sent and context handed over", table: "agent_runs",
    note: "Yours, and the Human-in-the-Loop material you said must survive. Held while a gate is open; afterwards it belongs in your folder, not here.",
    query: sql`SELECT COUNT(*) AS rows_, ${byteSum(["ar.system_prompt", "ar.user_prompt", "ar.context_input"])} AS bytes
      FROM agent_runs ar JOIN swarm_runs sr ON sr.id = ar.swarm_run_id
      WHERE sr.user_id = ${uid}`,
  },
  {
    group: "live-work", label: "Step and final answers", table: "agent_responses",
    note: "Yours. The largest single carrier of text, and the thing an archive without it would be missing.",
    query: sql`SELECT COUNT(*) AS rows_, ${byteSum(["res.content", "res.human_notes"])} AS bytes
      FROM agent_responses res JOIN swarm_runs sr ON sr.id = res.swarm_run_id
      WHERE sr.user_id = ${uid}`,
  },
  {
    group: "live-work", label: "Pipeline steps as authored", table: "pipeline_steps",
    note: "Yours. export_pipeline carries these; a shared or published pipeline's copy is separate and stays.",
    query: sql`SELECT COUNT(*) AS rows_, ${byteSum(["ps.system_prompt", "ps.if_config", "ps.while_config"])} AS bytes
      FROM pipeline_steps ps JOIN projects p ON p.id = ps.project_id
      WHERE p.user_id = ${uid}`,
  },
  {
    group: "live-work", label: "Immutable pipeline versions", table: "pipeline_versions",
    note: "Yours, unless a listing or a purchase points at them — then they move to hosted-for-others and the manifest below says so.",
    query: sql`SELECT COUNT(*) AS rows_, ${byteSum(["definition"])} AS bytes
      FROM pipeline_versions WHERE owner_id = ${uid}`,
  },
  {
    group: "research", label: "Evaluation plans and summaries", table: "benchmarks",
    note: "Yours. export_benchmark now carries the plan and the judging prompts; the hash stays here so published evidence still resolves.",
    query: sql`SELECT COUNT(*) AS rows_, ${byteSum(["plan", "summary"])} AS bytes
      FROM benchmarks WHERE owner_id = ${uid}`,
  },
  {
    group: "research", label: "Test cases and reference material", table: "benchmark_cases",
    note: "Yours. The case text is also inside any published manifest — that copy is hosted-for-others, this one is not.",
    query: sql`SELECT COUNT(*) AS rows_, ${byteSum(["bc.input_text", "bc.expected_output", "bc.provenance_notes"])} AS bytes
      FROM benchmark_cases bc JOIN benchmarks b ON b.id = bc.benchmark_id
      WHERE b.owner_id = ${uid}`,
  },
  {
    group: "research", label: "Candidate outputs", table: "benchmark_runs",
    note: "Yours. Bodies the user already swept show as NULL here and count as zero, which is the point of measuring by column.",
    query: sql`SELECT COUNT(*) AS rows_, ${byteSum(["br.output_text", "br.error_summary"])} AS bytes
      FROM benchmark_runs br JOIN benchmarks b ON b.id = br.benchmark_id
      WHERE b.owner_id = ${uid}`,
  },
  {
    group: "research", label: "Judgments and their rationales", table: "benchmark_judgments",
    note: "Yours, and the judging prompts that produced them are in export_benchmark. Published evidence keeps its own immutable copy.",
    query: sql`SELECT COUNT(*) AS rows_, ${byteSum(["bj.rationale", "bj.dimension_scores", "bj.validation_notes"])} AS bytes
      FROM benchmark_judgments bj JOIN benchmarks b ON b.id = bj.benchmark_id
      WHERE b.owner_id = ${uid}`,
  },
  {
    group: "hosted-for-others", label: "Published evidence manifests", table: "evidence_publications",
    note: "Stays. A buyer checked this before paying; withdrawal removes the public representation but the row is the record of what was claimed when.",
    query: sql`SELECT COUNT(*) AS rows_, ${byteSum(["public_manifest", "withdrawal_reason"])} AS bytes
      FROM evidence_publications WHERE author_id = ${uid}`,
  },
  {
    group: "hosted-for-others", label: "Purchases and execution rights", table: "marketplace_purchases",
    note: "Stays. Delisting stops new sales; what was bought keeps running, and that promise is this table.",
    query: sql`SELECT COUNT(*) AS rows_, ${byteSum(["stripe_session_id", "stripe_payment_intent_id"])} AS bytes
      FROM marketplace_purchases WHERE buyer_id = ${uid}`,
  },
  {
    group: "hosted-for-others", label: "Cost ledger rows (what a call cost, not what it said)", table: "call_attempts",
    note: "Stays. Money records, and the floor on a spend display is computed from these — text bodies are not stored here.",
    query: sql`SELECT COUNT(*) AS rows_, ${byteSum(["error_message", "requested_model"])} AS bytes
      FROM call_attempts WHERE payer_id = ${uid}`,
  },
];

/** Bytes and row counts this account's work occupies, by the reason we hold it. */
export async function accountHoldings(userId: number): Promise<{
  userId: number;
  items: Holding[];
  totals: Record<HoldingGroup, { rows: number; bytes: number }>;
  sweepable: number;
  retained: number;
}> {
  const db = getDb();
  const items: Holding[] = [];
  for (const probe of probes(userId)) {
    // drizzle's raw execute returns [rows, fields] on mysql2; the guard keeps a
    // driver difference from turning the whole inventory into zeros silently.
    // better-sqlite3 has no .execute — .all() returns the row list directly.
    const result = (isSqlite()
      ? await (db as unknown as { all: (q: unknown) => Promise<unknown> }).all(probe.query)
      : await db.execute(probe.query)) as unknown;
    const rowList = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as
      Array<{ rows_?: number | string; bytes_?: number | string; bytes?: number | string }> | undefined;
    const first = rowList?.[0];
    items.push({
      group: probe.group, label: probe.label, table: probe.table, note: probe.note,
      rows: Number(first?.rows_ ?? 0), bytes: Number(first?.bytes ?? first?.bytes_ ?? 0),
    });
  }

  const totals: Record<HoldingGroup, { rows: number; bytes: number }> = {
    "live-work": { rows: 0, bytes: 0 },
    research: { rows: 0, bytes: 0 },
    "hosted-for-others": { rows: 0, bytes: 0 },
  };
  for (const h of items) {
    totals[h.group].rows += h.rows;
    totals[h.group].bytes += h.bytes;
  }
  const sweepable = totals["live-work"].bytes + totals.research.bytes;
  const retained = totals["hosted-for-others"].bytes;
  logger.info("Storage inventory computed", { userId, sweepable, retained });
  return { userId, items, totals, sweepable, retained };
}
