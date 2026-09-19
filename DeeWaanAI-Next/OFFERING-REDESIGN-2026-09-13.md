# DeeWaanAI Offering Redesign — Modifications Report

**Date:** 2026-09-13
**Basis:** Orchestration Economics paper results (Interim-2 decision, cost-effectiveness analysis, Protocol-12 confirmatory wave) + ideation session with owner
**Status:** Pre-implementation — no code changes yet

---

## 1. What the paper established (evidence base)

- **Frontier solo beats cheap LLM teams on quality** — replicated out-of-sample (wave gate W2, p < 0.0001). Team effect is real but small (d ≈ 0.02–0.23).
- **Cheap solo reaches ~98% of frontier-solo quality at ~23% of the cost**; 6–9× novelty-per-dollar.
- **Personas hurt quality** (H4 reversed, d = −0.69); every persona cell is cost-dominated across all price blends.
- **Frontier teams are the worst economic deal** (T-EGR ≈ 0.27).
- **A ~$0.002 refine pass is the cheapest known quality climb** (Study-2).
- Inter-judge absolute-score reliability is imperfect (r as low as 0.49) → pairwise comparison is more robust out-of-domain.

**Consequence:** the old value prop ("design teams of persona agents that outperform") is contradicted by our own evidence. The evidence supports a different product: **cost-optimal LLM selection and workflow design**.

---

## 2. New product definition

**DeewaanAI = the LLM decision layer. Three pillars:**

| Pillar | What it is | Evidence anchor |
|---|---|---|
| **1. Design** | Pipeline builder — solo-model workflows with refine passes | Refine pass = cheapest quality climb; frontier teams worst deal |
| **2. Test** | Benchmark the *whole pipeline* across candidate models (BYOK); verdict = "this pipeline runs best on model X at $Y/run" | Cheap solo ≈ 98% frontier quality at 23% cost |
| **3. Auto-design** | System designs the pipeline; testing then picks the cheapest model to run it on | Upgrade-threshold finding (W2) |

**BYOK is universal (core principle): users always bring their own API keys — for designing, testing, judging, and running pipelines.** DeewaanAI never pays for or resells LLM tokens; the subscription buys the service, not compute. This keeps margins pure-SaaS and is a privacy selling point ("your keys, your bill, we never touch your token spend"). Onboarding must handle the no-keys case: recommend an aggregator key (e.g. OpenRouter — one prepaid key covering GPT/Claude/Gemini + open models) or free-tier providers via the existing `suggest_llm_providers` tool.

**Order matters — Design → Test, not Test → Design.** A model that wins on a solo prompt may not win inside a pipeline (refine steps, output formats, and chaining change what "good" requires), so solo results don't transfer. Testing always evaluates the whole pipeline; only the assigned model is swapped. A quick solo benchmark survives only as a free top-of-funnel taste, honestly labeled: "baseline estimate — test your pipeline for the real verdict."

**Deferred to a later release (advanced, risks confusing users):** per-step model assignment (cheap model for drafting, frontier for refine). Real savings hide there, but it explodes the test matrix — out of v1 scope.

**Explicitly out of scope (moved to a future separate product):**
- **TeamSync (Phase 2 human collaboration)** — team leads working with human teams on shared projects. Different buyer, different product. Code stays feature-flagged, not deleted.

**Internal design guidance (not a user-facing cut):** multi-agent/persona team configurations are de-emphasized as defaults and marketing claims, per the paper; they remain available as advanced options.

---

## 3. The test flow (core UX — runs on the designed pipeline)

Design principle: **the user brings a task and an opinion; the system does everything else.**

**Step 0 — Design the pipeline** (manual builder or auto-design; see pillars 1 & 3).

**Step 1 — "Describe what good looks like" (~30 s)**
- User writes judging criteria in plain language.
- LLM converts criteria into a scored rubric automatically (paper's 5-dimension composite as template).
- 2–3 preset templates (marketing copy, code, support reply) for one-click start.

**Step 2 — Auto-generate 3 prompt variants**
- System generates 3 verbatim-style variants of the pipeline's input prompt, runs the **entire pipeline** with each variant on 2–3 candidate models via user's keys, shows final outputs in a grid.
- Edit button per variant — available, never required.

**Step 3 — "See the verdict"**
- One result card: **winning model for this pipeline, quality score, cost per run, one-line "why"**. Statistics hidden behind an expander.

**Guardrails:**
- Default everything; all advanced knobs behind "Advanced".
- **Cost warning (critical):** pipeline runs cost 3–5× a solo run, and a matrix test (3 variants × 3 models × multi-step) can reach dollars, not cents. The pre-run estimate ("this test ≈ $X") is mandatory, shown before every run, with a cheaper "quick test" (1 variant × 2 models) offered as default.
- Post-hoc calibration: user 👍/👎 the top-2 judge disagreements after results; silently aligns judges to their domain.

---

## 4. Solving the judge generalization problem

Paper judges were tuned for business problems; users will test arbitrary domains. Four mechanisms:

1. **Rubric-relative judging** — judges score against the *user's* rubric, not domain expertise. A judge doesn't need to know medicine to check rubric coverage.
2. **Deterministic validators where possible** — auto-detect objective tasks (code runs, schema match, numeric checks); judges only for fuzzy outputs.
3. **Pairwise > absolute** — default mode is A/B comparison (robust to domain shift per our own reliability data); absolute scores secondary.
4. **Honest confidence** — judge–user agreement measured on the user's own task via the calibration step; surface "judge confidence: high/low" and fall back to manual side-by-side when low.
5. Keep the multi-judge panel (3 judges × variants) — diversity is the proven hedge.

---

## 5. Marketplace redesign

**Replace review-gating with radical transparency.**

**Publish flow:** benchmark passed → "Publish to Store" button on the results card. The benchmark data IS the listing. No review queue. **The 5-reviewer rule (Phase 1) is dropped.**

**Mandatory disclosure bundle (auto-attached, non-optional):**
1. Problems tested (exact prompts)
2. Raw outputs per model
3. Judge prompts + rubric
4. All scores (not averages only)
5. Cost per run, date tested, model versions (staleness shown honestly)

**Fairness rule:** any buyer may re-benchmark and publish results; buyer re-benchmarks attach publicly to the listing ("reproduced by 3 buyers / failed to reproduce"). Reputation emerges from data, not star reviews.

**Self-policing gate:** automatic delisting if buyer re-benchmarks fail to reproduce within a tolerance band. No human moderation needed.

**Monetization logic:** data is free (proves value); purchase delivers the executable asset.

---

## 6. Seller protection

**The pipeline asset never leaves the server.**

1. **Server-side execution only** — buyers run the pipeline via DeewaanAI's runner with their own API keys; config/prompts are never downloaded.
2. **Trial = N free runs** (3–5) on the buyer's own problem — not the asset.
3. **Anti-extraction measures** — per-buyer rate limits, extraction-pattern query logging; orchestration logic (routing, refine, model selection) lives in server-side code the LLM never sees.
4. **Legal backstop** — buyer ToS: license to execute, not own; reverse-engineering → ban + delisting.
5. Disclose honestly to sellers: outputs can partially leak prompts; protection is strong, not absolute.

---

## 7. Implementation implications (map to existing roadmap)

| Area | Change |
|---|---|
| Positioning / marketing | Rewritten: "frontier-level output at cheap-model prices, proven on your task" — cite the pre-registered evidence as moat |
| Pipeline builder | Default templates become solo-model + refine-pass workflows; persona/team presets demoted to Advanced |
| `design_pipeline` MCP tool | Must move to background-job + poll pattern (existing known timeout issue, now on the critical path) |
| Test/benchmark flow | **New build** — rubric generator, variant generator, judge panel runner, verdict card, **mandatory pre-run cost estimate with "quick test" default** (matrix tests run multi-step pipelines → dollars, not cents), calibration step |
| Per-step model assignment | **Deferred** — advanced feature for a later release; whole-pipeline-per-model testing only in v1 |
| Store (Phase 1) | Remove 5-reviewer gate; add disclosure-bundle publishing, buyer re-benchmark attachment, auto-delist tolerance check |
| Runner | Add server-side execution for purchased pipelines, per-buyer metering, rate limits, trial-run counter |
| TeamSync (Phase 2) | Frozen behind feature flag; extracted later as separate product |
| Billing | Seller revenue share on metered runs; buyer trial-run accounting |
| Benchmark cadence | Recurring re-benchmark budget — routing evidence decays as models update (~6-month horizon) |

---

## 8. Open decisions for the owner

1. Pricing model: % of LLM spend saved vs. flat subscription vs. marketplace commission only.
2. Judge panel for the test flow: which models, who pays (user keys vs. platform credits).
3. Marketplace revenue split for metered runs.
4. Minimum reproducibility tolerance band for auto-delisting.

---

*Next step: owner review → phase spec(s) per the working agreements (spec first, disjoint worker scopes, integration gates) before any implementation.*
