# Consolidated Remaining-Fixes Handoff

**Date:** 2026-08-01
**Context:** Both prior handoffs were implemented and audited:
- `PIPELINE-OVERFLOW-FIX-HANDOFF.md` → commit `b0660bc` (Fixes A/B/C) ✅ code correct.
- `BATCH-FEATURE-AUDIT-HANDOFF.md` → commit `7db144b` (W1–W6) ✅ W1/W3/W4/W5 correct; **W6 partial + a regression**.

This document consolidates **every remaining item** — the batch regressions, the deployment blocker, and the minor nits — in priority order. Please address all of them.

---

## Batch audit summary (commit `7db144b`)

| Item | Status |
|------|--------|
| W1 stateless-by-default | ✅ Correct — `createBatch` sets `stateless:true`; flows via `run.runParams`→`params` ([swarmService L1293](../api/services/swarmService.ts)), gates `[PREVIOUS WORK]` (L1439) + `giteeFinalSave` (L1006). |
| W3 error in status/export | ✅ Correct — `getBatchStatus.runs[].error` (200-char) + CSV `error` column. |
| W4 reconciler | ✅ Mostly — heals stale pending/running + finalizes all-terminal batches. See **B3** (churn). |
| W5 CSV escaping | ✅ Correct — RFC-4180 double-quote via `esc()`. |
| W6 idempotency bypass | ⚠️ **Partial + regression** — see **B1**, **B2**. |

---

## P0 — Deployment blocker: apply migration 021

**Problem:** Migrations here are applied via per-file runner scripts; only `run-migration-019.mjs` / `run-migration-020.mjs` exist. There is **no `run-migration-021.mjs`**, and `drizzle-kit migrate` won't apply it (the journal tracks only the `0000` snapshot). Until 021 runs against the Railway DB, the columns are **still `TEXT` in production** and Fix A is inert — the overflow bug persists despite the correct code.

**Fix:**
1. Create `scripts/run-migration-021.mjs` mirroring `scripts/run-migration-020.mjs`, pointing at `db/migrations/021_widen_content_columns.sql`.
2. Run it against the production DB.
3. Verify:
   ```sql
   SHOW COLUMNS FROM agent_runs LIKE 'context_input';   -- expect mediumtext
   SHOW COLUMNS FROM swarm_runs LIKE 'error';           -- expect a row (text)
   ```

---

## P1 — B1 (regression): throttle retry lost its backoff delay

**Problem.** The W6 change rewrote the throttle callback ([`swarmWorker.ts` L53-56](../api/workers/swarmWorker.ts)) to `enqueueSwarmRun(swarmRunId, userId, { bypassDedup: true })`, **dropping the `delayMs`** the callback receives. Throttled runs now retry **immediately** instead of backing off — defeating the AIMD throttle. Under the c=100 ramp this becomes a tight retry loop that hammers the provider and distorts the 429/latency measurements.

**Fix.** Extend `enqueueSwarmRun` to carry `delayMs`, and pass it from the throttle callback:
```ts
// swarmWorker.ts
export async function enqueueSwarmRun(
  swarmRunId: number,
  userId: number,
  opts?: { bypassDedup?: boolean; delayMs?: number },
): Promise<string> {
  const payload: SwarmJobPayload = { swarmRunId, userId };
  return swarmQueue.enqueue(SWARM_JOB_EXECUTE, payload, {
    idempotencyKey: opts?.bypassDedup ? undefined : `run-${swarmRunId}`,
    ...(opts?.delayMs ? { delayMs: opts.delayMs } : {}),
  });
}

// throttle callback
await executeSwarmRun({ swarmRunId, userId }, async (delayMs) => {
  await enqueueSwarmRun(swarmRunId, userId, { bypassDedup: true, delayMs });
  logger.info("swarmWorker: requeued throttled run", { swarmRunId, delayMs });
});
```

---

## P2 — B2: `resumeBatch` still deduped (W6 incomplete)

**Problem.** [`batchService.ts` L266](../api/services/batchService.ts) still calls `enqueueSwarmRun(run.id, run.userId)` **without** `bypassDedup`. Within the 24 h dedup window, a resumed batch's re-enqueues are silently dropped → resume no-ops.

**Fix:**
```ts
await enqueueSwarmRun(run.id, run.userId, { bypassDedup: true });
```
(Keep `createBatch`'s first enqueue at L100 *with* dedup — client submission should still deduplicate.)

---

## P2 — B3: reconciler pending-heal churns legitimately-queued batch runs

**Problem.** The reconciler re-enqueues any run `pending` longer than **5 min** ([`boot.ts`](../api/boot.ts) step 1, and boot DB-heal step 2). But `createBatch` enqueues all members up-front and `startedAt` is set at insert, so batch tail-runs legitimately sit `pending` far longer than 5 min while waiting for the worker (e.g. ~hours at concurrency 2). Every 60 s the reconciler re-enqueues them → a flood of **duplicate queue jobs**. `claimRun` prevents double-*execution*, so this is operational churn (queue pollution + wasted worker cycles + distorted c=100 metrics), not data corruption.

**Fix (choose one):**
- **Preferred:** exclude batch members from the short pending-heal — add `isNull(swarmRuns.batchId)` to the pending-heal queries, and heal lost *batch* members via a longer, batch-aware threshold (or via queue-membership check).
- **Simpler:** raise `PENDING_STALE_MS` safely above the worst-case batch drain time at the intended concurrency (for c=100 the drain is fast; at low concurrency it is not — so the batch-exemption above is more robust).

---

## P3 — Minor: persist `error` on the two rare failure paths

The main outer catch persists `error` ([swarmService L1080](../api/services/swarmService.ts)), but two secondary paths set `status:"failed"` without it:
- **"No pipeline steps"** ([L950](../api/services/swarmService.ts)): add `error: "No pipeline steps configured"`.
- **Setup-failed safety net** ([L1346-1348](../api/services/swarmService.ts)): add `error: safeError(errorMsg)` (see below).

## P3 — Minor: error truncation should keep head **and** tail

[L1080](../api/services/swarmService.ts) uses `errorMsg.slice(0, 2000)` (head only). Drizzle embeds the full query+params, so the underlying MySQL reason often sits at the **tail**. Use a head+tail helper and apply it everywhere an error is persisted (L1080 and the two paths above):
```ts
const safeError = (msg: string) =>
  msg.length > 2000 ? `${msg.slice(0, 1000)} …[truncated]… ${msg.slice(-1000)}` : msg;
```

---

## Notes (no code change required)

- **Stateless reads but does not write project state.** A `stateless` run still injects the project's *pre-existing* accumulated state (goal/decisions/episodes) — it just skips `[PREVIOUS WORK]` and skips writeback. For fully clean experiment runs, **use a fresh project** per batch (already reflected in batch handoff W1).
- **Optional (reconciler edge):** step 2 resets `running`→`pending` purely by age (>30 min) without confirming the Redis claim expired. A legitimately-long run (>30 min, unlikely given the 15-min timeout) could be reset and re-run. Low priority; consider checking claim presence before resetting.

---

## Verification

- **P0:** `SHOW COLUMNS` reports `mediumtext` + `error` column exists (production).
- **B1:** force a 429 → the requeued job carries the intended delay (check log `requeued throttled run` and that retry is not immediate).
- **B2:** create a batch, cancel/let it stall, `resumeBatch` within 24 h → members actually re-run.
- **B3:** a 100-input batch at low concurrency → reconciler logs show **no** repeated re-enqueue of the same queued pending runs.
- **P3:** force "No pipeline steps" and a setup failure → `swarm_runs.error` populated; a >2000-char error stores head+tail.

## Definition of Done

- [ ] Migration 021 applied to production (runner created) and verified.
- [ ] Throttle retry preserves `delayMs` (B1).
- [ ] `resumeBatch` bypasses dedup (B2).
- [ ] Reconciler no longer churns queued batch runs (B3).
- [ ] `error` persisted on all failure paths; head+tail truncation.
- [ ] Security scan (L3) pre-push per standing policy; 0 findings or remediated.
