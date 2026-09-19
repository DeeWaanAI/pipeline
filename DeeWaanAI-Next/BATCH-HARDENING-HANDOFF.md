# Batch Hardening Handoff — 7 Non-Blocking Robustness Fixes

**Context.** The Research-Mode batch system is **production-ready**: the D34 Stage A
hello-translator smoke passed 100/100 (0 failures) on production, and the pilot fixes
(#21/#22/#23) are audited and live. The items below are **robustness hardening** found
during full-system re-audit. **None block the experiment**; address them to harden the
batch path for the main run and general use. Ordered by priority.

Conventions: same as prior handoffs. Verify each fix against the stated check. Do not
widen scope.

---

## P1 — Correctness under edge cases

### H1. Cancel-vs-inflight race can flip a `cancelled` batch to `completed`
**Location:** `api/services/batchService.ts`, `incrementBatchProgress` finalization (~L134–139).

**Problem.** `cancelBatch` sets the batch to `cancelled` and its non-terminal runs to
`cancelled`. But a worker still executing a just-cancelled run can finish, mark that run
`completed`, and call `incrementBatchProgress`. The finalization block updates status
**without checking the current batch status**, so if the counters reach `totalRuns` it
overwrites `cancelled` → `completed`/`completed_with_failures`.

**Fix.** Guard the finalization so it only fires on a still-`running` batch:
```ts
if (batch && batch.completedRuns + batch.failedRuns >= batch.totalRuns) {
  const finalStatus = batch.failedRuns > 0 ? "completed_with_failures" : "completed";
  await db.update(swarmBatches)
    .set({ status: finalStatus, completedAt: new Date() })
    .where(and(eq(swarmBatches.id, batchId), eq(swarmBatches.status, "running")));
}
```
(`and` is already imported.) This also protects `paused_*` batches from being finalized.

**Verify.** Cancel a batch while a member is mid-run; after the member completes, the
batch must remain `cancelled` (not flip to `completed`).

---

### H2. Credit-pause leaves the triggering run `running` → premature re-activation
**Location:** `api/services/swarmService.ts`, credit-pause path (~L1064–1079); reconciler
running-heal `api/boot.ts` (~L300–320).

**Problem (corrected framing).** The triggering run is **not** lost — it keeps its saved
`executionState` and `resumeBatch` *does* re-enqueue it (it selects `pending` OR `running`
members). The real defect: the run is left in status `running` while the batch is
`paused_credit`. The reconciler running-heal resets any `running` run older than
`CLAIM_TTL_MS` (30 min) back to `pending` and re-enqueues it — **it does not know the batch
is paused**. So a batch paused >30 min (waiting for a top-up) gets its triggering run
auto-re-enqueued against still-exhausted credit → fails → re-pauses → churn loop. It also
shows as `running` in `getBatchStatus` while nothing is processing it.

**Fix.** In the credit-pause path, set the triggering run to `pending` (retryable, clearly
awaiting resume) instead of leaving it `running`. `executionState` is already saved:
```ts
if (isCredit && batchId) {
  await db.update(swarmRuns).set({
    status: "pending",                       // ← add: cleanly retryable on resume
    executionState: serializeCtx(execCtx),
  }).where(eq(swarmRuns.id, swarmRunId));
  await db.update(swarmBatches).set({ status: "paused_credit" }).where(eq(swarmBatches.id, batchId));
  // ...notification unchanged...
  throw new BatchPausedError("credit");
}
```
This is safe because: (a) the reconciler **pending**-heal already excludes batch members
(`isNull(batchId)`), so the run won't be auto-re-enqueued while paused; (b) `resumeBatch`
re-enqueues `pending` members, so it still resumes on top-up.

**Verify.** Force a credit-exhaustion failure mid-batch → the triggering run is `pending`
(not `running`), the batch is `paused_credit`, and after >30 min the reconciler does **not**
re-enqueue it. After `resumeBatch`, the run retries from saved state.

---

## P2 — Robustness / recovery

### H3. `createBatch` is not transactional — partial batch on mid-loop failure
**Location:** `api/services/batchService.ts`, `createBatch` (~L46–105).

**Problem.** The batch row insert, the per-input `swarm_runs` inserts, and the enqueues are
not atomic. If an insert/enqueue throws mid-loop (e.g. DB blip at input 51/100), you get a
batch with `totalRuns=100` but only ~51 run rows — it can never finalize via
`incrementBatchProgress` (counters never reach 100). No rollback occurs.

**Fix.** Wrap the batch + run inserts in a DB transaction; enqueue **after** commit
(enqueue is a non-transactional side effect and must not run inside the tx):
```ts
const { batchId, runIds } = await db.transaction(async (tx) => {
  const [batchRow] = await tx.insert(swarmBatches).values({
    userId, projectId, name: name ?? `Batch ${new Date().toISOString()}`,
    totalRuns: inputs.length, status: "running",
  });
  const batchId = Number(batchRow.insertId);
  const runIds: number[] = [];
  for (const prompt of inputs) {
    const runParams: SwarmRunParams = { /* unchanged */ };
    const [runRow] = await tx.insert(swarmRuns).values({
      projectId, userId, userPrompt: prompt, status: "pending", batchId, runParams,
    });
    runIds.push(Number(runRow.insertId));
  }
  return { batchId, runIds };
});
// Enqueue after commit. If one enqueue fails, the runs exist (pending) and are
// recoverable via H4's long-horizon heal or manual resumeBatch.
for (const runId of runIds) {
  try { await enqueueSwarmRun(runId, userId); }
  catch (err) { logger.error("[batchService] enqueue failed", { batchId, runId, error: (err as Error).message }); }
}
return { batchId, runIds, status: "queued" };
```

**Verify.** Simulate an insert failure mid-loop (e.g. bad row) → no orphaned partial batch
(the whole tx rolls back). Simulate an enqueue failure → all run rows exist and the batch is
recoverable.

---

### H4. Lost *pending* batch members are never auto-recovered
**Location:** `api/boot.ts` reconciler step 1 (~L280–298) and DB-heal step 2 (~L232–259).

**Problem.** The B3 fix excludes batch members (`isNull(batchId)`) from the short 5-min
pending-heal to prevent churn. Side effect: a batch member whose **queue job is genuinely
lost** (e.g. in-memory queue + server restart, or Redis eviction) stays `pending` forever —
nothing re-enqueues it, and the batch never finalizes. (Stuck-**running** members are still
covered by the running-heal.)

**Fix.** Add a **long-horizon** safety net for batch members, well clear of the churn window
(e.g. 2 h), so legitimately-queued members are untouched but truly-lost ones recover:
```ts
// In the reconciler, after step 1:
const BATCH_PENDING_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours
const staleBatchPending = await db
  .select({ id: swarmRuns.id, userId: swarmRuns.userId, startedAt: swarmRuns.startedAt })
  .from(swarmRuns)
  .where(and(eq(swarmRuns.status, "pending"), isNotNull(swarmRuns.batchId)))
  .limit(50);
for (const run of staleBatchPending) {
  const startedMs = run.startedAt ? new Date(run.startedAt).getTime() : 0;
  if (startedMs > 0 && now - startedMs > BATCH_PENDING_STALE_MS) {
    try { await enqueueSwarmRun(run.id, run.userId, { bypassDedup: true }); }
    catch (err) { logger.error("RECONCILER: failed to recover batch member", { runId: run.id, error: (err as Error).message }); }
  }
}
```
Import `isNotNull` from `drizzle-orm`. Keep the short 5-min heal excluding batch members.

**Verify.** A batch member left `pending` with no queue job is re-enqueued after the
long-horizon threshold; a freshly-queued batch member is **not** touched before then.

---

### H5. Claim TTL (30 min) < very long runs → theoretical double-execution
**Location:** `api/services/swarmService.ts` `CLAIM_TTL_MS` (~L1115), `claimRun` (~L1119–1134);
`api/boot.ts` running-heal (~L300–320, uses its own `CLAIM_TTL_MS` at ~L269).

**Problem.** `claimRun` sets a Redis claim with a fixed 30-min TTL and there is **no
refresh**. A run executing longer than 30 min loses its claim; the reconciler running-heal
then resets it to `pending` and re-enqueues it **while the original worker is still running**
→ two workers execute the same run → duplicate LLM spend + double `incrementBatchProgress`.
Hello/confirmatory runs are short, so this is theoretical for the experiment — but team runs
with large contexts can exceed 30 min.

**Fix (two parts).**
1. **Claim heartbeat:** refresh the claim TTL on progress (e.g. after each pipeline step
   completes) so an actively-running run never loses its claim:
```ts
// swarmService — add near claimRun:
export async function refreshClaim(swarmRunId: number): Promise<void> {
  try {
    const { getRedis } = await import("../infra/redis");
    const redis = getRedis();
    if (redis) await redis.set(`claim:swarm:${swarmRunId}`, INSTANCE_ID, "PX", CLAIM_TTL_MS); // no NX → refresh
    else localClaims.set(swarmRunId, Date.now() + CLAIM_TTL_MS);
  } catch { /* best-effort */ }
}
```
   Call `refreshClaim(swarmRunId)` at the end of each step iteration in `runPipelineAsync`.
2. **Claim-aware running-heal:** in `boot.ts`, before resetting a `running` run, skip it if
   its claim key still exists (actively held):
```ts
const redis = getRedis();
const held = redis ? await redis.exists(`claim:swarm:${run.id}`) : false;
if (held) continue; // claim still live → worker is active, do not reset
```
   (Keep the `startedAt > CLAIM_TTL_MS` age check as the trigger, but require the claim to be
   absent before resetting.)

**Verify.** A run that runs >30 min but refreshes its claim is **not** reset/re-enqueued by
the reconciler. A run whose worker truly died (claim expired/absent) **is** recovered.

---

### H6. `batch_mode` flag not enforced on the MCP batch tools
**Location:** `api/mcp/tools/runBatch.ts`, `batchStatus.ts`, `resumeBatch.ts`,
`exportBatchResults.ts` (handlers). Contrast: the tRPC router `api/routers/swarm.ts` checks
`isFeatureEnabled("batch_mode", ctx.user.id)` on **every** batch procedure (~L583–650).

**Problem.** The MCP batch tools bypass the `batch_mode` feature flag entirely — Research
Mode batches are reachable via MCP even when the flag is OFF. (We relied on this gap to run
the hello smoke, since `batch_mode` defaults OFF and isn't enabled on production.) This is an
access-control inconsistency between the tRPC and MCP surfaces.

**Fix.** Enforce the flag in the MCP batch tools, mirroring the tRPC router. At minimum gate
the mutating tools (`run_batch`, `resume_batch`); apply to the read tools for consistency:
```ts
// runBatch.ts handler, before requireProjectAccess:
import { isFeatureEnabled } from "../../plugins/featureFlags";
if (!(await isFeatureEnabled("batch_mode", ctx.userId))) {
  throw new Error("Research Mode (batch runs) is not enabled for this account.");
}
```
**Important deployment note:** once enforced, the experiment requires `batch_mode` enabled on
production. Enable it before the main run (pick one):
```sql
UPDATE featureFlags SET enabled = 1, rolloutPercent = 100 WHERE `key` = 'batch_mode';
-- or scope to the实验 user only:
UPDATE featureFlags SET allowedUserIds = JSON_ARRAY(<experimentUserId>) WHERE `key` = 'batch_mode';
```
Coordinate timing so the hello/pilot runs aren't blocked before enablement.

**Verify.** With `batch_mode` OFF, `run_batch` via MCP returns the "not enabled" error (same
as tRPC). With it ON (or the user allow-listed), batches run normally.

---

## P3 — Cosmetic

### H7. `safeError` const declared between import statements
**Location:** `api/services/swarmService.ts` (~L25–27).

**Problem.** The `safeError` helper is declared in the middle of the `import` block (after
`import { logger }`, before `import { getRedis }`). Valid ESM (imports hoist) but breaks the
import grouping and reads oddly.

**Fix.** Move the `safeError` const (and its doc comment) to **after** all import statements.
No behavior change.

**Verify.** `npm run build` (esbuild) succeeds; `safeError` still used at the three failure
paths.

---

## Definition of Done
- [ ] H1 finalization guarded by `status = 'running'`; cancelled batch can't flip to completed.
- [ ] H2 credit-pause sets triggering run to `pending`; paused runs not auto-re-enqueued; resume retries from saved state.
- [ ] H3 `createBatch` inserts wrapped in a transaction; enqueue after commit.
- [ ] H4 long-horizon (2 h) recovery for lost pending batch members; short heal still excludes them.
- [ ] H5 claim heartbeat + claim-aware running-heal; >30-min active runs not double-executed.
- [ ] H6 `batch_mode` enforced on MCP batch tools; production flag enablement coordinated.
- [ ] H7 `safeError` moved below imports; build green.
- [ ] All changes committed; L3 security scan clean.

## Out of scope
- The D34 c=10→100 concurrency ramp (needs `SWARM_WORKER_CONCURRENCY` raised on Railway).
- `reasoning_effort` control — decided to keep vendor defaults (documented in methodology);
  no code change.
- Re-running the clean pilot (separate task, unblocked by #21/#22/#23).
