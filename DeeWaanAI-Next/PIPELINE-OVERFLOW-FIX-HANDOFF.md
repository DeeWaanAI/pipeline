# Pipeline Context-Overflow & Silent-Failure — Coding Handoff

**Date:** 2026-07-31
**Priority:** High (Fix A + Fix B are production bugs; Fix C unblocks the research experiment)
**Reporter:** Research side, during the orchestration-economics pilot (`research/orchestration-economics/`)
**Affected component:** pipeline execution (`api/services/swarmService.ts`), schema (`db/schema.ts`), MCP `run_status` (`api/mcp/tools/getRunStatus.ts`)

---

## 1. What was observed

During the pilot, **7 of 120 runs failed** — all of them `team_3step` (builder→critic→refiner) runs, concentrated in the `claude-haiku` model family (6 of 7). `run_status` reported only the generic string `"Pipeline run failed"` with **no actionable error**, and the failure was scattered across a 10-hour window (not a single rate-limit spike).

## 2. Root cause (confirmed by live reproduction)

We reproduced the failure live (run id 180, `BP_8` on project 21) and captured the real error from the SSE `pipeline_error` event:

```
Failed query: insert into `agent_runs`
  (`id`, `swarm_run_id`, ..., `context_input`, ...)
  values (...)
params: 180, 52, 21, Refiner, refiner, 3, 1, ...
```

**The Refiner step's `agent_runs` INSERT fails because `agent_runs.context_input` overflows its column.**

- `agent_runs.context_input` is MySQL **`TEXT` = 64 KB max** ([`db/schema.ts` L275](../db/schema.ts)).
- The Refiner's `context_input` assembles `[ORIGINAL REQUEST] + builderPrompt + [PREVIOUS AGENT OUTPUT] + builderOutput + [QUALITY FEEDBACK] + criticOutput` ([`swarmService.ts` L715-722](../api/services/swarmService.ts)). In the failing run that was **~140k chars** (builder ~63k + critic ~75k) → **> 64 KB → INSERT fails → run dies.**

**Why it compounds (the trigger):** the pilot reuses one project across many problems, and every run injects the previous run's output as `[PREVIOUS WORK]` ([`swarmService.ts` L1436-1437](../api/services/swarmService.ts), via `loadLastPolisherOutput`) — **independent of memory mode**. The builder prompt grew from 214 chars (problem 1) to ~31k chars (problem 4), and `claude-haiku` produces large outputs, so the Refiner context crossed 64 KB.

**Why it was invisible:** `swarm_runs` has **no `error` column**. The real error is only logged (`logger.error`) and emitted once over SSE (`pipeline_error`) — never persisted. `run_status` synthesizes the placeholder `"Pipeline run failed"` ([`getRunStatus.ts` L76-77](../api/mcp/tools/getRunStatus.ts)). So no API consumer can ever learn why a run failed.

### Two distinct bugs
| # | Bug | Type |
|---|-----|------|
| A | Content columns capped at `TEXT` (64 KB) — overflows on large team contexts/outputs | **Product** (affects any user with large team pipelines) |
| B | Run failures are silent — no persisted error, placeholder only | **Product** (observability) |
| C | Runs on a shared project accumulate `[PREVIOUS WORK]`, contaminating later runs | **Experiment validity** (needs a platform enabler) |

---

## 3. Fix A — Widen content columns `TEXT` → `MEDIUMTEXT`

`MEDIUMTEXT` = 16 MB (ample; `LONGTEXT`/4 GB is overkill). Change **both** the Drizzle schema and the live DB.

### 3a. `db/schema.ts` — swap `text(...)` → `mediumtext(...)` for runtime content columns
Import `mediumtext` from `drizzle-orm/mysql-core`, then change:

| Table | Column | Schema line |
|-------|--------|-------------|
| `agent_runs` | `context_input` | [L275](../db/schema.ts) ← **the failing one** |
| `agent_runs` | `user_prompt` | [L274](../db/schema.ts) |
| `agent_runs` | `system_prompt` | [L273](../db/schema.ts) |
| `agent_responses` | `content` | [L302](../db/schema.ts) ← single outputs can also exceed 64 KB (builder output was ~63k chars) |
| `swarm_runs` | `user_prompt` | [L181](../db/schema.ts) |

> Optional / low priority: `custom_agents.system_prompt` (L160, L435) and the pipeline-step `systemPrompt` (L465) are config-sized and unlikely to overflow — widen only if trivial.

### 3b. Migration — create `db/migrations/021_widen_content_columns.sql`
Follow the existing hand-numbered SQL pattern (see [`020_api_key_ref_text.sql`](../db/migrations/020_api_key_ref_text.sql) as the template — header comment explaining *why*, then `ALTER`):

```sql
-- 021: widen runtime content columns from TEXT (64KB) to MEDIUMTEXT (16MB).
-- team_3step Refiner assembles [ORIGINAL REQUEST]+builderPrompt+[PREVIOUS OUTPUT]
-- +builderOutput+[QUALITY FEEDBACK]+criticOutput into agent_runs.context_input,
-- which exceeded 64KB (~140k chars observed) and failed the INSERT with
-- "Data too long for column 'context_input'", killing the whole pipeline run.
ALTER TABLE agent_runs     MODIFY COLUMN context_input MEDIUMTEXT NULL;
ALTER TABLE agent_runs     MODIFY COLUMN user_prompt    MEDIUMTEXT NOT NULL;
ALTER TABLE agent_runs     MODIFY COLUMN system_prompt  MEDIUMTEXT NULL;
ALTER TABLE agent_responses MODIFY COLUMN content       MEDIUMTEXT NOT NULL;
ALTER TABLE swarm_runs     MODIFY COLUMN user_prompt    MEDIUMTEXT NOT NULL;
```

> Note: `db/migrations/meta/_journal.json` only tracks the drizzle-generated `0000` snapshot; the numbered `.sql` files are applied out-of-band. Apply 021 the same way 009–020 are applied in this project.

---

## 4. Fix B — Persist and surface the real run error

### 4a. `db/schema.ts` — add an `error` column to `swarmRuns`
```ts
error: text("error"),   // persisted failure reason (truncated); null unless failed
```
Place it near `status`/`completedAt`. (`TEXT` is fine — we truncate before writing.)

### 4b. Migration — append to `021_*.sql` (or a separate `022`)
```sql
ALTER TABLE swarm_runs ADD COLUMN error TEXT NULL AFTER completed_at;
```

### 4c. `api/services/swarmService.ts` — persist the error in the outer catch
At the failure update ([L1075-1079](../api/services/swarmService.ts)), add a **sanitized, bounded** error. The raw `errorMsg` can be ~70 KB because Drizzle embeds the full query + params, so do **not** store it verbatim — keep head + tail (table/step at the head, MySQL reason at the tail):

```ts
const safeError = errorMsg.length > 2000
  ? `${errorMsg.slice(0, 1000)} …[truncated]… ${errorMsg.slice(-1000)}`
  : errorMsg;

await db.update(swarmRuns).set({
  status: isCancel ? "cancelled" : "failed",
  completedAt: new Date(),
  executionState: null,
  ...(isCancel ? {} : { error: safeError }),
}).where(eq(swarmRuns.id, swarmRunId));
```
(Also set `error` at the early "No pipeline steps configured" failure near [L948](../api/services/swarmService.ts) for completeness.)

### 4d. `api/mcp/tools/getRunStatus.ts` — return the stored error
Replace the placeholder ([L76-77](../api/mcp/tools/getRunStatus.ts)):
```ts
...(run.status === "failed"
  ? { error: run.error ? truncate(run.error, 2000) : "Pipeline run failed" }
  : {}),
```
(`truncate` is already imported in this file.)

---

## 5. Fix C — Stateless / isolated run mode (experiment independence)

**Why:** `[PREVIOUS WORK]` injection ([`swarmService.ts` L1436-1437](../api/services/swarmService.ts)) means runs on a shared project are *not independent* — each run sees the previous run's output. This is desirable for normal product use, but it **invalidates the experiment** (and is what pushed contexts over 64 KB). Memory mode does not control it (modes are only `conservative`/`balanced`/`aggressive`; there is no "off").

**Add an opt-in `stateless` flag** to pipeline runs that, when true:
1. **Skips the `[PREVIOUS WORK]` injection** at L1436-1437 (treat `loadLastPolisherOutput` as null).
2. **Skips project-state writeback** (the `giteeFinalSave` / state-update path) so runs don't accumulate state for the next run.

Thread it through:
- MCP tool input schema — [`api/mcp/tools/runPipeline.ts`](../api/mcp/tools/runPipeline.ts): add `stateless: z.boolean().optional()`.
- `SwarmRunParams` / `runPipeline` → `runPipelineAsync` in [`api/services/swarmService.ts`](../api/services/swarmService.ts): carry the flag to the injection site (L1436) and the state-save site.

The research runner will pass `stateless: true` for experiment runs.

> **Fallback if C is deprioritized:** the research side can instead create a fresh project per (config × problem) so `loadLastPolisherOutput` returns null naturally — but that's ~900 projects for the main run, so the flag is strongly preferred.

---

## 6. Migration & deployment

1. Apply schema edits (3a, 4a) + create the migration SQL (3b, 4b).
2. Run the migration against the Railway MySQL DB the same way 009–020 are applied.
3. Deploy the API (swarmService + getRunStatus + runPipeline changes).
4. `ALTER TABLE ... MODIFY` to MEDIUMTEXT is online-friendly in MySQL 8 (no full table rebuild for TEXT→MEDIUMTEXT in most cases); run in a low-traffic window regardless.

## 7. Verification

- **Fix A:** re-run the exact reproduction — `run_pipeline` on project 21 with `BP_8` input (claude-haiku team). Before: Refiner INSERT fails. After: run completes; `agent_runs.context_input` for the Refiner stores the full ~140k-char context.
- **Fix B:** force a failure (e.g., bad provider key) → `run_status` returns the real truncated error, not `"Pipeline run failed"`; `swarm_runs.error` is populated and ≤ 2000 chars.
- **Fix C:** run two `stateless: true` runs on the same project → the second run's builder prompt contains **no** `[PREVIOUS WORK]` block; project state is unchanged after the runs.
- **Regression:** a normal (non-stateless) team run still injects `[PREVIOUS WORK]` and persists state as before.

## 8. Definition of Done

- [ ] `agent_runs.context_input/user_prompt/system_prompt`, `agent_responses.content`, `swarm_runs.user_prompt` are `MEDIUMTEXT` in both schema and DB.
- [ ] `swarm_runs.error` exists; failures persist a bounded sanitized error; `run_status` surfaces it.
- [ ] `stateless` flag available on `run_pipeline`, skipping `[PREVIOUS WORK]` injection and state writeback.
- [ ] Migration 021 (and 022 if split) applied to production; verification steps pass.
- [ ] Security scan (L3) run pre-push per standing policy; 0 findings or remediated.

## 9. Guardrails / out of scope

- Do **not** change the inter-step context assembly logic itself (L715-722) — widening the column is the fix; don't truncate agent context.
- Do **not** lower `maxTokens` or add output caps as a workaround — the failure was a DB column limit, not a model context-window limit.
- Keep `stateless` strictly opt-in; default product behavior (memory + `[PREVIOUS WORK]`) must be unchanged.

## 10. Research-side follow-up (FYI — not coding work)

Once A+B+C ship, research will: (1) re-run the pilot's contaminated cells (`C-T-N`, `C-T-P`, and the kimi outliers) with `stateless: true`, (2) re-check the G0a gate (≤5% empty per cell, κ≥0.40, cost ≤1.5× envelope), then (3) ramp the concurrency test to c=100 before the main run.
