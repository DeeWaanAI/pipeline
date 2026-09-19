# Limiter Fix Handoff — Stop Self-Throttling the Batch Path

**Context.** During the D34 c-ramp (concurrency calibration) on production, the `qwen`
(Aliyun) lane collapsed: runs averaged ~9–10 s, a 20-run batch took ~4 min, and batches
were paused as `paused_credit`. Root-cause investigation shows this is **our own
machinery**, not the provider:

1. A provider **429 / rate-limit response is misclassified as "credit exhausted"** → it
   pauses the whole batch *and* is never retried.
2. The same 429 collapses our **AIMD provider throttle to its floor (6 RPM)**, and the
   collapsed state **persists in Redis** across redeploys.
3. No provider has a `declaredRpm` configured, so every provider **starts at 30 RPM in
   slow-start** — far below real provider limits.

**Evidence (production DB).** The runs earlier seen as `paused_credit` are now all
`completed` with real tokens (466–505) and **no error** — the pause was transient and the
runs succeeded on retry. This is not a hard billing block. Log line
`[providerThrottle] aliyun rate-limited → RPM 6` is our own limiter
(`api/lib/providerThrottle.ts` L228), and `6` is our hard-coded floor (L33).

**Goal.** Make the limiter an *enabler* (auto back-off only on genuine provider 429s)
instead of a self-imposed cage, so batch mode can deliver real throughput. Ordered by
priority. Verify each fix against its stated check. Do not widen scope.

---

## P1 — Correctness

### L1. Separate rate-limit errors from true credit errors
**Location:** `api/services/swarmService.ts` — `CREDIT_ERROR_PATTERNS` (L150–155),
`isCreditError` (L157–159), `callWithRetry` (L164–185).

**Problem.** `CREDIT_ERROR_PATTERNS` contains rate-limit signatures:
`/429.*rate.*limit/i`, `/limit.*exceeded/i`, `/too.*many.*requests/i`. So a provider 429
(e.g. Aliyun DashScope → `"Aliyun: Rate limit exceeded. Please wait..."`, see
`api/lib/providers/openai.ts` L40–74) flows through:

1. `callWithRetry` L175: `isCreditError("...429 rate limit...")` → **true** → throws
   `CreditExhaustedError` **immediately on the first attempt** (the retry loop is skipped
   entirely — 429s are transient and *should* be retried).
2. `executeAgentStep` catch L439–441: `isCredit` true → `reportProviderResult(slug,
   "rate_limited")` → **AIMD halves** (`×0.5`).
3. `executeSwarmRun` catch L1064–1078: `isCredit && batchId` → batch set to
   **`paused_credit`** + user notification "API credits exhausted" + `BatchPausedError`.

One transient 429 therefore (a) never retries, (b) halves the limiter, and (c) pauses the
entire batch under a false "out of credit" banner.

**Fix.** Split the two error classes. Rate-limits become retryable and, once retries are
exhausted, surface as `ProviderThrottledError` (which the existing throttle path
requeues — L1054–1062) instead of pausing the batch:

```ts
// Genuine account/billing problems → pause batch, user must top up. NOT retryable.
const CREDIT_ERROR_PATTERNS = [
  /insufficient_quota/i, /quota_exceeded/i, /exceeded.*quota/i,
  /billing.*disabled/i, /payment.*required/i, /402/,
  /credit/i, /balance/i, /account.*deactivated/i,
];
// Transient provider throttling → retry, then requeue. NEVER pauses the batch.
const RATE_LIMIT_PATTERNS = [
  /429/, /rate.?limit/i, /too.*many.*requests/i, /throttl/i, /limit.*exceeded/i,
];

function isCreditError(msg: string): boolean {
  return CREDIT_ERROR_PATTERNS.some((p) => p.test(msg));
}
function isRateLimitError(msg: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(msg));
}
```

```ts
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; label?: string } = {},
): Promise<T> {
  const { maxRetries = 3, label = "API" } = options;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      if (isCreditError(lastErr.message)) {
        throw new CreditExhaustedError(`API credit exhausted: ${lastErr.message}. Please add credit and retry.`);
      }
      if (attempt === maxRetries) break;
      const delay = 1000 * Math.pow(2, attempt);
      logger.warn(`[${label}] Attempt ${attempt + 1} failed: ${lastErr.message}. Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Retries exhausted: a rate-limit is transient saturation → requeue via the
  // throttle path (do NOT pause the batch). Anything else fails the run as before.
  if (lastErr && isRateLimitError(lastErr.message)) {
    throw new ProviderThrottledError(5000);
  }
  throw lastErr ?? new Error(`${label} failed after ${maxRetries + 1} attempts`);
}
```

`ProviderThrottledError` is already defined in this file (L124) and is handled by
`executeSwarmRun` (L1054–1062: save `executionState`, requeue via `RunThrottledError`).
The `executeAgentStep` catch (L440) still calls `reportProviderResult(slug,
"rate_limited")` for a genuine 429 — that AIMD halving is *correct* behavior; only the
batch-pause and no-retry were wrong.

**Verify.**
- Unit: `callWithRetry` with a fn that always throws `"429 rate limit"` → retries
  `maxRetries` times, then throws `ProviderThrottledError` (NOT `CreditExhaustedError`).
- Unit: fn throwing `"402 payment required"` → throws `CreditExhaustedError` immediately,
  no retry.
- Integration: a batch whose provider returns a 429 → the run is **requeued** and the
  batch stays `running` (never `paused_credit`). A real `402`/`insufficient_quota` still
  pauses with `paused_credit`.

---

## P2 — Throughput configuration (no code change; production env + data)

### L2. Set `declaredRpm` per provider so AIMD starts at real limits
**Location:** production env `PROVIDER_THROTTLE` (parsed in
`api/lib/providerThrottle.ts` L46–64); consumed at `acquireProviderSlot(prov.slug,
prov.config.declaredRpm)` (`swarmService.ts` L403).

**Problem.** All production providers have `config = {}` (verified in `llm_providers`), so
`makeInitialState` (L72–82) starts each at `initRpm = 30` **in slow-start**. With
`declaredRpm` set, it starts at `round(declaredRpm × 0.8)` and **skips slow-start**.

**Fix.** Set `PROVIDER_THROTTLE` on the `deewaanai` service (Railway) to the providers'
**real published real-time RPM limits** (fill in the exact current numbers per plan/tier —
do not guess; check each provider console). Shape:
```json
{
  "aliyun":  { "init": 1000, "floor": 60, "ceiling": 2000 },
  "openai":  { "init": 1000, "floor": 60, "ceiling": 2000 },
  "anthropic": { "init": 300, "floor": 60, "ceiling": 2000 },
  "google-gemini": { "init": 300, "floor": 60, "ceiling": 2000 },
  "moonshot": { "init": 300, "floor": 60, "ceiling": 2000 }
}
```
(Alternatively set `config.declaredRpm` per row in `llm_providers`; the env route is
preferred because it also raises `floor` above the timid default of 6.) Note the slug must
match `prov.slug` exactly.

**Important:** `declaredRpm`/`init` only apply when state is **first created**
(`loadState` L88–114 returns existing Redis state and ignores `declaredRpm`). So this only
takes effect after L3 clears the collapsed state.

### L3. Reset the collapsed AIMD state in Redis after deploy
**Location:** Redis keys `provider-throttle:*` (`providerThrottle.ts` L84).

**Problem.** The halved-to-floor state (`currentRpm = 6`) is stored in Redis and survives
redeploys. Even after L1+L2, providers stay stuck at 6 RPM until ~14 min of additive
recovery.

**Fix.** After deploying L1 and setting L2, delete the throttle keys so each provider
re-initializes fresh (at 80% of `declaredRpm`):
```
redis-cli -u "$REDIS_URL" --scan --pattern 'provider-throttle:*' | xargs -r redis-cli -u "$REDIS_URL" del
```
(Safe: state is rebuilt lazily on the next `acquireProviderSlot`.)

---

## P3 — Enhancement (optional)

### L4. Honor the provider `Retry-After` header in AIMD
**Location:** `api/services/swarmService.ts` L440–442; `reportProviderResult` already
accepts `retryAfterMs` (`providerThrottle.ts` L207–226) but it is never passed.

**Problem.** On a genuine 429 we halve RPM but ignore the provider's `Retry-After`, so we
may re-hit it immediately.

**Fix.** Parse `Retry-After` (seconds or HTTP-date) from the error/response and pass it:
`await reportProviderResult(prov!.slug, "rate_limited", retryAfterMs)`. This pauses the
window exactly as long as the provider asked.

---

## Out of scope / related
- **5 runs stuck `running` in batch 16** are the H2 credit-pause run-state bug
  (`BATCH-HARDENING-HANDOFF.md` H2), not this fix. The reconciler running-heal clears them
  after `CLAIM_TTL_MS` (30 min); or manually set them to `pending`.
- **`total_latency_ms` is confounded under throttle** (includes `callWithRetry` backoff
  waits and AIMD serialization). No change needed — just note it when interpreting c-ramp
  latency; re-measure after L1–L3.
- **Together.ai as a high-RPM lane:** not required for this fix, and **not** blocked by
  judge independence. Each LLM call is a stateless, independent API request — the provider
  is just transport, with no coupling between generation and judging calls. Judge
  independence is a property of **model identity**, not provider: the D33 unified
  non-reasoning 3-judge panel is frozen and distinct from the generation models, and is held
  constant across all cells so any self-preference bias cancels in the comparison. Moving
  generation to Together is fine as long as the judge *models* stay fixed; Together's
  multi-model catalog can even help diversify the panel.

## Definition of Done
- [ ] L1 merged with unit tests (429 → retry → `ProviderThrottledError`; 402 →
      `CreditExhaustedError`).
- [ ] L2 `PROVIDER_THROTTLE` set on production with verified real RPM limits.
- [ ] L3 Redis `provider-throttle:*` cleared post-deploy.
- [ ] Re-run c-ramp at c=10 then c=50: **0 `paused_credit`**, qwen completes 20/20,
      `getProviderThrottleMetrics` shows providers near 80% of declared (not 6), and qwen
      median latency drops to its true (un-throttled) level.
- [ ] L3 security scan clean before push (standing order).
