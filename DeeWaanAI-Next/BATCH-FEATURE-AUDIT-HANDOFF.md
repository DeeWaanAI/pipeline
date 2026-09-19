# Research-Mode Batch Feature — Audit & Fix Handoff

**Date:** 2026-07-31
**Scope:** Audit of the Research-Mode batch feature (`run_batch`, commit `6abf28d` / `1050b87`) + check for the same class of failure we hit in the pilot.
**Verdict:** The batch feature is functional but **inherits both pilot bugs** (because the prior overflow handoff was never implemented) **and adds four batch-specific weaknesses.** Several are critical for the planned c=100 concurrency run.

---

## 0. Audit verdict — read this first

We audited the implemented batch feature (`api/services/batchService.ts`, `api/mcp/tools/runBatch.ts`, batch wiring in `swarmService.ts`, the worker/queue, and boot DB-heal).

**⚠️ Prerequisite not done:** the prior handoff [`PIPELINE-OVERFLOW-FIX-HANDOFF.md`](./PIPELINE-OVERFLOW-FIX-HANDOFF.md) (Fixes A/B/C) was **not implemented**. Verified in code:
- No `mediumtext` anywhere; `db/schema.ts` still `text(...)` at L181/273/274/275/302 → **64 KB overflow is live.**
- `swarm_runs` has **no `error` column**; `getRunStatus.ts` L77 still returns the placeholder `"Pipeline run failed"`.
- No `stateless` flag; no migration `021`.

Because every batch member runs through the **same** `runPipelineAsync` path, the batch inherits all three pilot bugs — and at batch scale (up to 100 runs on one project). **Fixes A/B/C must land before the batch is used for the experiment or the c=100 test.**

### Findings
| ID | Severity | Issue | Same-as-pilot? |
|----|----------|-------|----------------|
| W1 | **Critical** | All batch members share one project → `[PREVIOUS WORK]` cross-contamination; runs are non-independent **and** non-deterministic | Yes (pilot Fix C, but structural here) |
| W2 | **Critical** | 64 KB `context_input` overflow (Fix A not done) → team runs die as the batch accumulates state | Yes (pilot root cause) |
| W6 | **Critical** | Idempotency-key reuse silently drops throttle-retries, `resumeBatch`, and DB-heal re-enqueues → runs orphaned under rate-limit pressure (c=100) | No (batch/worker-specific) |
| W3 | High | Batch failures are silent — no error in `batch_status` or CSV export (Fix B not done) | Yes (pilot observability gap) |
| W4 | High | No runtime reconciler; DB-heal runs only at boot and ignores `pending` → one orphaned run blocks batch completion forever | No (batch liveness) |
| W5 | Medium | CSV export uses triple-quote escaping (`"""`) → malformed RFC-4180 CSV | No (data quality) |

---

## 1. Prerequisite — implement PIPELINE-OVERFLOW-FIX-HANDOFF (A/B/C)

Do [`PIPELINE-OVERFLOW-FIX-HANDOFF.md`](./PIPELINE-OVERFLOW-FIX-HANDOFF.md) Fixes A (MEDIUMTEXT), B (error column + surface), C (stateless flag) first. W1–W3 below depend on them.

---

## 2. W1 — Batch runs must be stateless *by default*

**Problem.** `createBatch` inserts every member with the **same `projectId`** ([`batchService.ts` L86-93](../api/services/batchService.ts)) and does not set `memoryMode`/`stateless`. Each member therefore runs through the `[PREVIOUS WORK]` injection ([`swarmService.ts` L1436-1437](../api/services/swarmService.ts)): run *N* sees the most recently *completed* member's output. With worker concurrency ≥ 2 this is also **non-deterministic** (which prior output a run sees depends on finish timing). This violates run independence — fatal for the experiment — and monotonically grows context (feeding W2).

**Fix.** Build on pilot Fix C (`stateless` on `SwarmRunParams`), and make it the **default for batch members**:
- In `createBatch`, set `stateless: true` in each member's `runParams` ([`batchService.ts` L70-84](../api/services/batchService.ts)).
- In `runPipelineAsync`, when `stateless` is true: skip `loadLastPolisherOutput`/`[PREVIOUS WORK]` (L1436-1437) **and** skip project-state writeback (`giteeFinalSave`/state update).
- Keep single-run `run_pipeline` behavior unchanged (stateless stays opt-in there); batch turns it on automatically.

> If true isolation is required even for the project's Gitee state, run each batch on a dedicated project; but the `stateless` flag is the primary fix and is sufficient for run independence.

---

## 3. W6 — Idempotency key must not block internal re-enqueues

**Problem.** `enqueueSwarmRun` always uses `idempotencyKey: run-${swarmRunId}` ([`swarmWorker.ts` L27](../api/workers/swarmWorker.ts)), and the queue dedupes that key for **24 h** ([`queue.ts` L157-162 memory / L211-218 Redis](../api/infra/queue.ts)). The *same* key is reused for three legitimate internal re-enqueues, all of which get silently dropped within 24 h:
- **Throttle retry** — the worker's throttle callback re-enqueues with the same key ([`swarmWorker.ts` L48](../api/workers/swarmWorker.ts)) → under rate-limit pressure (exactly the c=100 case) the retry is deduped and the run is **lost**.
- **`resumeBatch`** — re-enqueues members with the same key ([`batchService.ts` L260-266](../api/services/batchService.ts)) → resume silently no-ops.
- **Boot DB-heal** — re-enqueues stale runs with the same key ([`boot.ts` L221-228](../api/boot.ts)) → reset to `pending` but never actually queued (compounds W4).

**Why it's safe to fix:** execution-safety is already guaranteed by the run **claim** (`claimRun`, Redis `NX` with 30-min TTL, [`swarmService.ts` L1112-1127](../api/services/swarmService.ts)). The enqueue idempotency only needs to prevent duplicate *client submission*, not internal retries.

**Fix.**
- Add an option to bypass dedup, e.g. `enqueueSwarmRun(swarmRunId, userId, { bypassDedup?: boolean })` that omits `idempotencyKey` (or uses `run-${id}-retry-${Date.now()}`).
- Use `bypassDedup: true` for the three internal re-enqueues: throttle retry (`swarmWorker.ts` L48), `resumeBatch` (`batchService.ts` L262), DB-heal (`boot.ts` L223).
- Keep dedup for client-facing submission (`createBatch` first enqueue, router `execute`).

---

## 4. W3 — Surface per-run errors in batch status & export

**Problem.** When a member fails, `incrementBatchProgress({failed:1})` bumps the counter and the batch ends `completed_with_failures`, but neither `getBatchStatus` ([`batchService.ts` L175-180](../api/services/batchService.ts)) nor `exportBatchResults` ([L296-312](../api/services/batchService.ts)) exposes **why**. With Fix B's `swarm_runs.error` column, surface it:
- `getBatchStatus`: add `error` to the `runs[]` select/map (truncate ~200 chars for the summary).
- `exportBatchResults`: add an `error` column to the CSV header + row.

---

## 5. W4 — Add a runtime reconciler; fix boot DB-heal

**Problem.** Batch completion depends on `incrementBatchProgress` firing for *every* member. If a run is orphaned (queue job lost while `pending`, or a lost increment), the batch stays `running` **forever** — there is no batch-level reconciler. The only healer runs **at boot** and only covers `status="running"` ([`boot.ts` L209-212](../api/boot.ts)), capped at 100 rows; it never touches stuck `pending` runs.

**Fix.**
- Add a periodic sweeper (e.g. `setInterval` in `boot.ts`, every ~60 s):
  1. Re-enqueue runs stuck `pending` longer than N minutes (lost job) — with `bypassDedup` (W6).
  2. Reset+re-enqueue runs stuck `running` past `CLAIM_TTL_MS` with no active claim.
  3. **Batch reconciliation:** for any batch `status="running"` whose members are all terminal, recompute `completedRuns`/`failedRuns` from the members and finalize (`completed` / `completed_with_failures`). This self-heals lost increments.
- Extend boot DB-heal to also cover stale `pending` runs and to use `bypassDedup`.

---

## 6. W5 — Fix CSV escaping

**Problem.** `exportBatchResults` escapes quotes by **tripling** them (`.replace(/"/g, '"""')`, [`batchService.ts` L309-310](../api/services/batchService.ts)) — RFC-4180 requires **doubling**. Output is malformed for any response containing `"`. The header also has unquoted spaces after commas.

**Fix.**
```ts
const esc = (s: string) => `"${(s ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
rows.push(["run_id","input_preview","status","final_response","error","total_tokens_used","total_latency_ms"].join(","));
// ...
rows.push([run.id, esc(inputPreview), run.status, esc(finalResponse), esc(run.error ?? ""), run.totalTokensUsed ?? 0, run.totalLatencyMs ?? 0].join(","));
```

---

## 7. Deployment note for the c=100 test

Effective concurrency = `SWARM_WORKER_CONCURRENCY` (default **2**, [`env.ts`](../api/lib/env.ts)), not the batch size — `createBatch` enqueues all members immediately and the worker drains them at its concurrency. For the c=100 ramp, raise `SWARM_WORKER_CONCURRENCY` per ramp step. **W6 must be fixed first**, or throttle-retries at high concurrency will be deduped away and runs will silently stall.

## 8. Verification

- **W1:** run a 3-input batch on one project; assert each member's builder prompt contains **no** `[PREVIOUS WORK]`, and project state is unchanged after the batch.
- **W2:** batch of `team_3step` claude-haiku runs completes; Refiner `context_input` > 64 KB stored intact (requires Fix A).
- **W6:** force a 429/throttle → the run retries (not dropped); `resumeBatch` within 24 h actually re-runs dead members.
- **W3:** force a member failure → `batch_status` `runs[]` and the CSV both show the real error.
- **W4:** kill a worker mid-run → sweeper re-queues it; a batch with one orphaned member still finalizes via reconciliation.
- **W5:** a response containing `"` and newlines exports as valid CSV (parse-check).

## 9. Definition of Done

- [ ] PIPELINE-OVERFLOW-FIX-HANDOFF A/B/C implemented (prerequisite).
- [ ] Batch members run stateless by default (no `[PREVIOUS WORK]`, no state writeback).
- [ ] Internal re-enqueues bypass idempotency; client submission keeps dedup.
- [ ] `batch_status` + CSV expose per-run `error`.
- [ ] Runtime reconciler + batch finalization sweeper live; boot heal covers `pending`.
- [ ] CSV escaping RFC-4180 compliant.
- [ ] Security scan (L3) pre-push per standing policy; 0 findings or remediated.

## 10. Out of scope / guardrails

- Do **not** truncate agent context or cap `maxTokens` to dodge W2 — widen the column (Fix A).
- Keep `stateless` opt-in for single `run_pipeline`; only batch defaults it on.
- Do **not** remove enqueue idempotency for client submissions — only bypass for internal retries (claims already guard execution).
