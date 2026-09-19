# Provider Native Batch API — Adapter Spec Handoff

**Context.** DeeWaanAI "batch mode" currently executes every run through the real-time
queue (BullMQ + AIMD throttle). Major providers offer **native async Batch APIs at ~50%
cost with no real-time rate limits** (≤24 h completion): OpenAI, Anthropic, Google Gemini,
and Aliyun DashScope (no RPM/TPM limits at all). Routing eligible work to these lanes cuts
the dominant cost line ~50% and eliminates throttle contention for bulk jobs.

This is a **new execution lane**, not a replacement: real-time stays for multi-step and
interactive work. Companion docs: `LIMITER-FIX-HANDOFF.md` (real-time lane hardening).

**Design principle (user requirement):** provider-agnostic and extensible. Together.ai is
in scope for the *interface* (it has **no native batch API today** — it participates as a
high-RPM real-time lane), and **users must be able to add other providers later** (BYOK)
without platform code changes beyond a small adapter file.

---

## 1. Eligibility rule (hard rule, enforced at batch creation)

A batch is **batch-lane eligible** iff **every run's pipeline is a single LLM step with no
dependencies** (solo, stateless). Concretely:
- ✅ eligible: single-step pipelines (one agent, one call per run).
- ❌ NOT eligible: multi-step chains (step N+1 consumes step N's output), HITL /
  approval steps, pipeline chaining (`chain` option), any run needing streaming or
  sub-minute latency.

Detection lives in `batchService.createBatch`: resolve the pipeline structure of the
batch's runs; if any run is multi-step → real-time lane. No heuristics — structure only.

## 2. Mode selection (product surface)

Batch submission gains an explicit `lane` option:
- `"realtime"` (default today's behavior),
- `"economy"` (native batch API, ~50% cost, ≤24 h),
- `"auto"` (**default for new submissions**): use `economy` if eligible per §1 AND the
  run's provider supports it (§4 capability), else `realtime`. The chosen lane is always
  recorded on the batch/runs (§5) — never implicit.

## 3. Adapter contract

New interface in `api/lib/providers/base.ts` (or a sibling `batch.ts`):

```ts
export interface BatchCapabilities {
  batch: boolean;          // false → provider is real-time-only (e.g., together, kimi)
  maxRequestsPerBatch?: number;   // e.g. OpenAI 50k; chunk submissions above this
  completionWindow?: string;      // e.g. "24h" (UI/disclaimer copy)
  discount?: number;              // e.g. 0.5 → used for cost accounting
}

export interface ProviderBatchRequest {
  customId: string;        // we use swarm run id: "run_<id>"
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  temperature?: number;
  maxTokens?: number;
}

export interface ProviderBatchResultItem {
  customId: string;
  status: "completed" | "failed";
  content?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  error?: string;
}

export interface BatchLaneAdapter {
  capabilities(): BatchCapabilities;
  /** Submit requests; returns provider-side batch id. Chunk if over maxRequestsPerBatch. */
  submit(requests: ProviderBatchRequest[]): Promise<{ providerBatchIds: string[] }>;
  /** Poll provider batch status. */
  status(providerBatchId: string): Promise<{
    state: "validating" | "in_progress" | "completed" | "failed" | "expired" | "cancelled";
    completed: number; failed: number; total: number;
  }>;
  /** Fetch results once state === "completed" (or partial on failed/expired). */
  results(providerBatchId: string): Promise<ProviderBatchResultItem[]>;
  cancel(providerBatchId: string): Promise<void>;
}
```

Adapters are registered per slug in `api/lib/providers/index.ts` next to
`createProviderAdapter` (e.g. `createBatchLaneAdapter(slug, apiKey, baseUrl): BatchLaneAdapter | null`
→ `null` when the provider has no batch API). **All provider-specific quirks (file
formats, upload, endpoints) stay inside the adapter file.**

## 4. Platform integration

**Schema (new migration):** extend `swarm_batches` with
- `lane` enum `realtime|economy` (default `realtime`),
- `provider_batch_ids` json (array — submissions may be chunked),
- `lane_submitted_at`, `lane_completed_at` timestamps.

Extend `swarm_runs` with `lane` enum (copied from the batch at creation) so every run's
data is self-describing for traceability/cost accounting.

**Flow (`batchService` + worker):**
1. `createBatch`: resolve eligibility (§1) + lane (§2). For `economy`: build
   `ProviderBatchRequest[]` from each run's resolved single step, call `adapter.submit`,
   store `provider_batch_ids`, set runs to `pending` with `lane="economy"`. Do **not**
   enqueue to BullMQ.
2. **Poller:** a periodic worker job (reuse the swarm worker loop, e.g. every 60 s) scans
   `economy` batches in non-terminal state → `adapter.status` → on `completed`/`failed`/
   `expired` fetches `adapter.results` and ingests per-run:
   - completed item → run `completed`, store content as the final response, record
     `usage` into `total_tokens_used`; set `total_latency_ms` to the **provider-reported
     processing window if available, else NULL** — never fake a real-time number (§7).
   - failed item → per-item handling (§6).
3. `getBatchStatus` / `batch_status` MCP tool surface lane + provider progress
   (`completed/failed/total` + state) so users see real progress.
4. `cancelBatch`: for `economy` batches call `adapter.cancel` on all provider batch ids,
   then mark remaining runs `cancelled`.

**Cost accounting:** apply `capabilities.discount` to the token cost for `economy` runs
(wherever cost vectors are computed) — the experiment's cost analysis depends on this.

## 5. Failure & fallback semantics

- Provider batch `failed`/`expired` (files expire after days — ingest results promptly):
  **auto-fallback** — affected runs flip to the real-time lane (re-enqueue via existing
  BullMQ path) so a provider-side failure never loses user work. Log the fallback;
  surface it in batch status.
- Per-item failures inside a completed batch: mark that run `failed` with the provider's
  error (same accounting as today's failed runs). No per-item retry — keep it simple;
  users re-submit individual runs.
- Submission errors (bad key, quota): fail fast at `createBatch` with a clear message —
  do not create a half-submitted batch (wrap submit + DB writes; enqueue nothing until
  submit succeeds).

## 6. Per-provider notes (verify against current docs at implementation time)

| Slug | Native batch API | Notes |
|---|---|---|
| `openai` | ✅ `/v1/batches` | JSONL file upload via `/v1/files` (purpose=`batch`), 24 h window, ~50% off, max 50k requests/batch |
| `anthropic` | ✅ Message Batches API | ~50% off, 24 h window, requests submitted inline (no file upload) |
| `gemini` | ✅ Batch prediction | Via Files API upload, 24 h, ~50% off |
| `aliyun` | ✅ DashScope batch | **No RPM/TPM limits**, ~50% off (user-verified 2026-07) |
| `mistral` | likely ✅ | Verify endpoint/limits before implementing |
| `together` | ❌ | Real-time-only, high RPM. `capabilities.batch = false`. Keep the adapter slot so a future batch endpoint is a one-file drop-in |
| `deepseek`, `kimi` | ❓ | Verify; default `batch: false` until confirmed |

## 7. User extensibility (BYOK)

- Custom providers (any slug not in the built-in catalog) resolve to
  `capabilities.batch = false` by default → they automatically use the real-time lane.
  No breakage, no config.
- Adding support for a new provider later = one new adapter file + one registry line.
  Nothing in `batchService`/worker changes.
- Optional later: an admin/user `config.batchApi = "openai_compatible"` escape hatch for
  providers exposing OpenAI-style `/v1/batches` — defer to Phase 3.

## 8. Experiment traceability (pre-registration note)

Main-run generation may be routed through the `economy` lane for ~50% savings. Because
batch-lane latency is hours (not seconds):
- every exported run row includes `lane`;
- cost accounting applies the lane discount;
- latency comparisons are only valid **within the same lane** — the methodology section
  must state this. (Researcher decision; the platform just records the data faithfully.)

## Phasing

- **Phase 1 (this handoff):** interface §3, eligibility §1, lane mode §2, schema §4,
  poller + ingestion, fallback §5, **OpenAI + Aliyun adapters** (Aliyun = highest value:
  no limits; OpenAI = reference implementation).
- **Phase 2:** Anthropic + Gemini adapters; admin batch-lane metrics (counts, savings).
- **Phase 3:** Mistral (if confirmed), OpenAI-compatible escape hatch for user providers,
  per-listing default lane in the marketplace.

## Definition of Done (Phase 1)
- [ ] `lane` schema migration applied; existing batches default `realtime`.
- [ ] `auto` routes eligible single-step batches on OpenAI/Aliyun to the native batch API;
      multi-step always real-time.
- [ ] Poller ingests results; run statuses, tokens, and cost (discounted) are correct.
- [ ] Failed/expired provider batch → auto-fallback to real-time, zero lost runs.
- [ ] `cancelBatch` cancels provider-side batches.
- [ ] `batch_status` shows lane + provider progress.
- [ ] Providers without batch API (incl. `together`) unaffected — real-time path unchanged.
- [ ] Unit tests: eligibility detection, chunking, result ingestion, fallback.
- [ ] L3 security scan clean before push (standing order).
