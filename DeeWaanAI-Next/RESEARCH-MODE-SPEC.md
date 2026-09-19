# RESEARCH-MODE-SPEC — Batch Runs (`runBatch`) + Pipeline Chaining v1.0

**Owner:** Youssef Hariri
**Status:** DRAFT — ready for implementation
**Prereq reading:** `api/services/swarmService.ts` (executeSwarmRun), `api/workers/swarmWorker.ts`
(enqueueSwarmRun), `api/infra/queue.ts` (AppQueue/createWorker), `api/routers/swarm.ts` (execute),
`api/mcp/tools/runPipeline.ts`, `api/lib/rateLimiter.ts`, `api/config/plans.ts`, `db/schema.ts`
(swarmRuns L169-220, pipelineSteps L413-440).
**Motivation:** (a) the Orchestration Economics experiment (~3,240 pipeline runs) must complete in
hours, not days; (b) "run 100 pipelines, chain results into evaluation pipelines, export everything"
is a Research Mode product story no orchestration competitor offers.

---

## 1. Conceptual model

| Concept | Definition |
|---|---|
| **Batch** | A named set of up to 100 pipeline runs submitted in one call against one project (same pipeline, different inputs). Each member is an ordinary `swarm_runs` row — all existing machinery (SSE, resume, boot-heal, runStatus) works unchanged. |
| **Chain** | A per-run `on_complete` trigger: when a run completes successfully, its final response is rendered into a template and submitted as the input of a new run on another (or the same) project. |
| **Drain rate** | Batch members are enqueued instantly but *executed* under two ceilings: global worker concurrency and a per-provider requests-per-minute throttle. |

**Hard rules (fail closed):**
1. A batch NEVER executes anything in-request. `runBatch` only inserts rows + enqueues; workers drain.
2. Per-provider throttle applies to ALL runs (batch or not) — a batch must not starve interactive runs of the same user, and must not trip provider rate limits.
3. One member failing NEVER aborts the batch; the batch ends `completed_with_failures`.
4. Chaining is bounded: max depth 3, same user only, cycle-safe (lineage carried in runParams).
5. Both features ship behind DB feature flags (`batch_mode`, `pipeline_chaining`), default OFF.

## 2. Data model changes (`db/schema.ts` + migration)

```sql
CREATE TABLE swarm_batches (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  name          VARCHAR(200),
  status        VARCHAR(30) NOT NULL DEFAULT 'running',
        -- running | paused_credit | paused_outage | completed
        -- | completed_with_failures | cancelled
  total_runs    INTEGER NOT NULL,
  completed_runs INTEGER NOT NULL DEFAULT 0,
  failed_runs   INTEGER NOT NULL DEFAULT 0,
  total_tokens_used INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMP
);
ALTER TABLE swarm_runs ADD COLUMN batch_id INTEGER REFERENCES swarm_batches(id);
CREATE INDEX swarm_runs_batch_id_idx ON swarm_runs(batch_id);
```

`SwarmRunParams` (swarmService.ts L51) gains two optional fields:

```ts
batchId?: number;
chain?: {
  targetProjectId: number;
  inputTemplate?: string;   // default "{{finalResponse}}"; may also use {{originalInput}}
  depth: number;            // 0 for user-submitted runs; incremented per hop
  lineage: number[];        // swarmRunId ancestry, for cycle/depth audit
};
```

No new queue: batch members ride the existing `swarm-runs` queue.

## 3. Feature A — `runBatch`

### 3.1 API surface
- **tRPC** `swarm.runBatch` (mutation) and **MCP tool** `run_batch` (scope `mcp:run`, `featureFlag:
  batch_mode`). The MCP tool delegates to the tRPC procedure via the `makeCaller` pattern already
  used by `export_pipeline` (portability.ts L19-29) — do NOT duplicate row-creation logic the way
  `runPipeline.ts` currently does.
- **Input:** `{ projectId, name?, inputs: string[] (1..100, each 1..20000 chars), templateId?,
  chain?: { targetProjectId, inputTemplate? } }`
- **Behavior:** validate access + plan capability → create `swarm_batches` row → for each input,
  insert a `swarm_runs` row (status `pending`, `batch_id` set, runParams seeded exactly like
  `runPipeline.ts` L15-141, plus `batchId`/`chain`) → `enqueueSwarmRun(runId, userId,
  { idempotencyKey: `run-${runId}` })` → return `{ batchId, runIds, status: "queued" }` immediately.
- **Rate limiting:** new `RATE_LIMITS.batch` profile: 2 batch submissions/min/user. Batch members
  are exempt from the `execute` 10/min profile (they were admitted as a batch); they are NOT exempt
  from the per-provider throttle (§3.3).

### 3.2 Worker concurrency
- `api/infra/queue.ts` L246: replace the hardcoded BullMQ `concurrency: 2` with
  `env.SWARM_WORKER_CONCURRENCY` (default 2; research deployment: 16). Memory backend: drain up to
  the same limit concurrently instead of strictly sequentially.
- `workerEntry.ts` unchanged — a dedicated worker dyno scales drain without touching the web dyno.

### 3.3 Adaptive per-provider throttle (new, applies platform-wide)
Static limits waste capacity: real ceilings differ wildly by provider and tier (DeepSeek publishes
no hard rate limit; Together and Alibaba/DashScope allow very high RPM on paid tiers; Anthropic
free tiers are tight). The throttle therefore **discovers** each provider's sustainable rate with
AIMD (additive-increase / multiplicative-decrease, TCP-congestion-control style):

- New module `api/lib/providerThrottle.ts`:
  `acquireProviderSlot(providerSlug): Promise<{ ok: true } | { ok: false; retryAfterMs }>` and
  `reportProviderResult(providerSlug, outcome: "ok" | "rate_limited", retryAfterMs?)`.
- Per-provider state (Redis hash `provider-throttle:{slug}`, in-memory fallback):
  `currentRpm`, `windowStart`, `windowCount`, `lastDecrease`.
- **AIMD rules (slow start, then AIMD — mirrors TCP congestion control: Jacobson 1988; Chiu &
  Jain 1989 prove AIMD converges to fair, efficient allocation):**
  1. Start at `initRpm` (default 30, or the user-declared rate — see below).
  2. **Slow start:** double `currentRpm` after each fully clean 60s window until the first
     rate-limit signal or `ceilingRpm` — this discovers high-throughput providers (2,000+ RPM)
     in minutes instead of hours.
  3. After the first 429: switch to **congestion avoidance** — additive increase
     `currentRpm += max(10, 5% of current)` per clean window, capped at `ceilingRpm`.
  4. Multiplicative decrease: on any 429/rate-limit response, `currentRpm = max(floorRpm,
     currentRpm × 0.5)` and pause new slots for `Retry-After` when the provider sends it
     (honoring `Retry-After` always wins over local math). Cooldown: no increase for 2 windows
     after a decrease.
  5. 429s are throttle *signals*, never run failures — the run suspends and re-enqueues (below).
- **User-declared limits (hint, then verify):** users who know their provider tier can declare it
  — `llm_providers.config.declaredRpm` (settings UI + `addProvider` MCP tool gain an optional
  `declaredRpm` field). The throttle treats it as a *prior*, not a promise: `initRpm =
  declaredRpm × 0.8`, slow start skipped (start near-target). The system still verifies: 429s
  below the declared rate trigger normal decrease, and clean windows may probe *above* it up to
  `ceilingRpm`. Declared limits can therefore be wrong in either direction without harm.
- Config from env `PROVIDER_THROTTLE` (JSON per slug + `*` default), e.g.
  `{"*":{"init":30,"floor":6,"ceiling":2000},"deepseek":{"init":60,"ceiling":6000},
  "together":{"init":60,"ceiling":6000},"aliyun":{"init":60,"ceiling":6000},
  "anthropic":{"init":20,"ceiling":1000}}`. Ceilings are safety caps, not targets — the throttle
  finds the real sustainable rate between floor and ceiling on its own.
- **Bottleneck rule (multi-provider pipelines):** throttling is enforced per provider at each
  step, so a pipeline mixing providers is automatically paced by its slowest one. The batch
  dispatcher makes this explicit: effective batch rate = `min(currentRpm of all providers used
  by the pipeline's steps)`; it admits new runs at that pace (admission control) instead of
  flooding the queue and churning suspend/re-enqueue cycles, and `batch_status` reports
  `bottleneckProvider`, `effectiveRpm`, and a live ETA derived from them.
- Call sites in `swarmService.ts`: `acquireProviderSlot` immediately before every `adapter.chat(...)`;
  `reportProviderResult` after it (classify 429/`isCreditError` rate-limit patterns as
  `rate_limited`). On `ok:false`: do NOT fail the run — persist executionState (cursor already
  supports this), re-enqueue the run with `delayMs: retryAfterMs` (queue.ts already supports
  `delayMs`), and return. The run resumes at the same step; same suspend/resume mechanism approval
  steps use.
- Observability: `batch_status` and admin metrics expose each provider's live `currentRpm` so a
  researcher can see the discovered throughput (e.g., "deepseek settled at 240 RPM").

### 3.4 Batch progress + completion
- On each member's terminal transition in `executeSwarmRun` (completed/failed/cancelled): if
  `batchId` set, atomically increment `completed_runs`/`failed_runs` and add `total_tokens_used`;
  when `completed+failed = total`, set batch status + `completed_at`.
- **tRPC** `swarm.getBatchStatus` / `swarm.listBatches`; **MCP tool** `batch_status` (scope
  `mcp:read`): returns counts, per-run summaries (id, input preview, status, tokensUsed), and —
  when finished — a `resultsCsvUrl` (see §5).
- `swarm.cancelBatch`: sets batch `cancelled` and cancels all non-terminal members (reuses
  `cancelRun` logic per member).

### 3.5 Failsafe ladder — degrade, pause, notify, resume (graceful degradation)
Three escalating failure classes, each with a distinct response. Design principle: **degrade
before pausing, pause before failing, and never fail a run for an infrastructure reason** —
only genuine model/input errors mark runs failed.

| Level | Signal | Response |
|---|---|---|
| **1. Rate pressure** | 429 / rate-limit patterns | AIMD decrease (×0.5, honor `Retry-After`); runs suspend + re-enqueue; invisible to the user beyond a lower live RPM. |
| **2. Credit exhaustion** | `CreditExhaustedError` patterns already classified in swarmService.ts (L102-119: insufficient_quota, billing disabled, 402…) | Batch → `paused_credit`. All non-terminal members for that provider suspend with state intact. **User notified** (in-app notification via the existing notification router + email if configured): *"Batch '‹name›' paused — ‹provider› API credits exhausted at run 412/900. Top up and resume; nothing was lost."* Resume: `swarm.resumeBatch(batchId)` re-enqueues suspended members; optionally an hourly single-request canary probe auto-resumes on success. |
| **3. Provider outage / connection loss** | ≥5 consecutive network/5xx errors on one provider (429s excluded) | Circuit breaker opens for that provider (extend the existing `api/plugins/circuit-breaker` plugin): batch → `paused_outage`, members suspend. **User notified**: *"‹provider› unreachable — check your connection/provider status. Auto-retrying."* Half-open canary probe every 2 min; on success the circuit closes, the batch auto-resumes at `floorRpm` and re-ramps, and a recovery notification is sent. |

Rules:
1. Pauses are **per-provider**: a multi-provider batch keeps executing steps on healthy providers;
   only runs blocked at the affected provider suspend. Batch status reflects the worst active
   level; `batch_status` lists per-provider health (`ok | rate_limited | credits_exhausted |
   unreachable`).
2. Every pause/resume/decrease event is appended to an auditable event log (`agent_responses`
   metadata or admin audit log) with timestamp, provider, rate before/after, and trigger — this
   is the evidence trail a research paper can cite for run-condition integrity (no silent
   degradation; grounding: circuit-breaker stability pattern, Nygard 2007 *Release It!*).
3. Idempotency guarantees across all pauses: suspended runs keep `executionState` (cursor +
   chain), so resume never re-executes a completed step and never double-writes a response —
   the same invariants as crash recovery (acceptance #3).
4. Grace timeout: a batch paused >72h sends a reminder notification; >7 days → auto-cancelled
   with a final notification (nothing deleted; completed members remain exportable).

## 4. Feature B — Pipeline chaining

### 4.1 Semantics
- If `runParams.chain` is present and the run reaches `completed`, `executeSwarmRun` (at the point
  where `final_response_id` is set) renders `inputTemplate` with `{{finalResponse}}` (the final
  `agent_responses.content`) and `{{originalInput}}` (the run's `user_prompt`), then creates +
  enqueues a new run on `chain.targetProjectId` with `depth+1` and `lineage + [thisRunId]`.
- The chained run's `user_prompt` = rendered template; `batch_id` is inherited so batch progress
  counts chained evaluation runs too (batch `total_runs` is incremented atomically when a chained
  run is created).

### 4.2 Guards (all fail closed — skip chaining, log, never fail the parent run)
1. `depth >= 3` → skip. 2. `targetProjectId` not owned/accessible by the same `userId` → skip.
3. `targetProjectId`'s project appears in `lineage`'s projects more than once → skip (cycle).
4. Chained runs pass through the same per-provider throttle and plan checks as any run.
5. Failed parents never chain.

### 4.3 Exposure
- `run_pipeline` and `run_batch` MCP tools + tRPC `execute`/`runBatch` accept the optional `chain`
  object (flag-gated by `pipeline_chaining`).
- Research use: generation batch on the experiment project chains each final solution into the
  evaluation project, whose pipeline is judge steps — generation → judging becomes one submission.

## 5. Research Mode packaging (thin layer, high story value)
- `swarm.exportBatchResults(batchId)` → CSV: `run_id, input, status, final_response,
  total_tokens_used, total_latency_ms, model/provider per step` (join `swarm_runs` → `agent_runs` →
  `agent_responses`). This is the artifact a researcher archives in a repo.
- Marketing line (site): "Run 100 experiments in parallel. Chain outputs into evaluators. Export
  everything. DeeWaanAI ran a peer-reviewed study on itself."

### 5.1 Packaging & pricing decision
- **Bundle, don't split.** Batch + chaining + CSV export ship together as **Research Mode** — one
  capability, one story. No à-la-carte micro add-ons ($3.99/$9.99-style): the workflow only
  delivers value whole (batch → chain → export), split SKUs force double purchase and kill
  adoption, low price points signal low value to the exact segment (researchers, consultants,
  agencies) with the highest willingness to pay, and every extra SKU adds Stripe products +
  entitlement paths + support edge cases.
- **Launch: included in Sage (Pro Auto, top tier).** Research Mode becomes the upgrade reason.
  Implementation: new capability `pipeline:batch` in `PLAN_CAPABILITIES` granted to the Sage plan
  (and admin); feature flags allow per-user beta exceptions before GA.
- **Later (optional, demand-driven):** a standalone **"Research Mode" add-on at $14.99–19.99/mo**
  for lower tiers — only if lower-tier users ask. This order is reversible; removing it from Sage
  later would be churn. Users bring their own API keys, so marginal cost ≈ 0 — price on value,
  not cost.
- **Fairness quotas, not per-batch pricing:** cap batches/day by tier (Sage 20/day; add-on
  10/day). Purpose is queue fairness on shared workers — one user must not starve interactive
  runs — not cost recovery.
- **Tiers × seats are orthogonal (no "Team tier"):** the individual ladder (Artist/Master/Sage =
  `users.tier` standard/pro_designer/pro_auto) governs what one person can do; team collaboration
  is the per-seat `team_seat` plan (`team:collaborate`), stacked on top of each member's tier —
  standard SaaS pattern (feature tier × seat count). **Research Mode in team workspaces follows
  the run owner's individual tier:** a Sage member can batch/chain inside a team project; an
  Artist member cannot. No new SKU; nudges members individually toward Sage.

### 5.2 Infra cost model (why marginal cost ≈ 0)
- Users pay LLM tokens (their own keys) — 95%+ of any run's true cost, never platform-borne.
- Platform bears only shepherding costs: worker CPU/RAM (execution is ~95% idle I/O waiting on
  providers, so 50 concurrent runs ≈ idle connections), DB writes (~600 rows per 100-run 3-step
  batch — trivial), Redis/queue traffic (negligible).
- Hosting is Railway (usage-based, per-second billing): capacity autoscales per need — pennies
  during a batch, zero when idle; no pre-provisioned worker dyno. `workerEntry.ts` already
  supports a dedicated worker service if sustained multi-user load ever justifies it.
- **Cost circuit-breakers (usage-based billing cuts both ways — a retry-loop bug or abusive user
  has no natural ceiling):** keep the per-tier batch quota AND `SWARM_WORKER_CONCURRENCY` cap
  even with autoscaling, and set a Railway usage alert/hard limit in the dashboard as backstop.
- Watch Redis first as batch adoption grows: under BullMQ load it is the component doing constant
  work, and the first line item to move.

## 6. Delivery phases

**PHASE 0 — plumbing (no behavior change):** migration (swarm_batches, batch_id); env
`SWARM_WORKER_CONCURRENCY`, `PROVIDER_THROTTLE`; seed flags `batch_mode`, `pipeline_chaining`
(off); pass `idempotencyKey: run-${runId}` in `enqueueSwarmRun` (today it passes none — L56 of the
queue audit); make queue concurrency env-driven.
**PHASE 1 — runBatch:** adaptive providerThrottle (AIMD) + suspend/re-enqueue on throttle;
`swarm.runBatch`, `getBatchStatus`, `listBatches`, `cancelBatch`; MCP `run_batch`, `batch_status`
(makeCaller pattern); batch progress accounting; vitest unit tests (AIMD state machine: clean
windows ramp, 429 halves, Retry-After honored) + `scripts/smoke-batch.mjs` (submit 10-input
batch on a 2-step pipeline against a mock provider, assert all complete and CSV shape).
**PHASE 2 — failsafe ladder + chaining:** credit-pause + outage-pause with notifications and
`resumeBatch` (Level 2–3, §3.5); circuit-breaker integration; SwarmRunParams.chain, completion
hook, guards §4.2, exposure §4.3; smoke: batch of 3 chained into a 1-step evaluator project,
assert 6 total runs in batch; smoke: mock provider returns 402 mid-batch → paused_credit +
notification row exists → resumeBatch completes the rest.
**PHASE 3 — Research Mode polish:** exportBatchResults CSV; plan capability + UI (batch submit
panel + progress bar on project page); site copy.

## 7. Acceptance criteria
1. 100-input batch on a 3-step pipeline completes with `SWARM_WORKER_CONCURRENCY=16` without any
   provider 429 surfacing as a run failure (throttle suspends instead), and without interactive
   runs of another user erroring (they queue and complete).
2. AIMD behavior against a mock provider that allows 100 RPM: throttle ramps from init 30 to
   ≥90 RPM within 8 clean windows; when the mock starts returning 429 above 50 RPM, throttle
   converges into the 25–50 band and stays there; a mock `Retry-After: 30` pauses new slots for
   ≥30s.
3. Kill the worker mid-batch → restart → boot-heal (boot.ts L223) resumes; no duplicate
   `agent_responses` for any (run, step) pair; batch counts end exact.
4. One member with an invalid model fails alone → batch = `completed_with_failures`, 99 completed.
5. Chained run created iff parent completed; depth-3 chain stops silently at 3; cross-user target
   is skipped and logged.
6. Flags off → `run_batch`/`batch_status` absent from MCP tools/list and tRPC procedures throw
   FORBIDDEN; flags on for a single allowed user id → only that user sees them.
7. `exportBatchResults` CSV row count = total member+chained runs; token totals match the sum of
   `swarm_runs.total_tokens_used`.
8. Failsafe: mock 402/insufficient_quota mid-batch → batch `paused_credit`, in-app notification
   created, zero members marked failed; `resumeBatch` finishes the remainder exactly once.
   Mock provider blackout (≥5 consecutive connection errors) → `paused_outage`, notification
   sent; when the mock recovers, canary auto-resumes at floor rate and a recovery notification
   is sent. Multi-provider batch with one provider down keeps completing steps on the healthy
   provider.
9. Declared-limit flow: provider with `declaredRpm: 500` starts at 400 RPM (no slow start);
   if the mock 429s at 300, throttle converges below 300 despite the declaration; if the mock
   is clean, throttle probes above 500 toward the ceiling.

## 8. Experiment fit (Orchestration Economics)
The runner (`code/run_experiment.py`) keeps the preregistered ledger as source of truth: it submits
ledger rows in batches of ≤100 via `run_batch`, polls `batch_status`, and maps member results back
to ledger rows by input id embedded in the prompt header. The ledger's ≤4-concurrency cap (D17) is
superseded by the platform throttle — the protocol constraint that matters (per-provider RPM
respect + arm interleaving) is preserved: interleaving comes from ledger order, throttling moves
from client to platform. This substitution is recorded in DESIGN-DECISIONS.md when the feature
lands; wall-clock estimate at concurrency 16: main run ≈ 4–8 hours instead of days.
