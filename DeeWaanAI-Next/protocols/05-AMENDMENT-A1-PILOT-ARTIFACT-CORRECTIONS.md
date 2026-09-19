# Protocol Amendment A1 — Pilot Artifact Corrections (Measurement Infrastructure)

**Amendment ID:** A1
**Date drafted:** 2026-07-30
**Status:** DRAFTED AND IMPLEMENTED (code + data ready); **judging execution deferred** to the discount window by author instruction (2026-07-30). Requires author sign-off + OSF re-registration (§6) before the main run starts.
**Scope:** measurement infrastructure ONLY. No change to hypotheses, design, cells, families, problems, personas, prompts, or stopping rules.
**Evidence base:** `research/orchestration-economics/results/QUALITATIVE-NOTES.md` (pilot qualitative diagnostics, 371 runs / 3,339 judgments).

---

## 1. Why this amendment exists (findings, for the record and for future researchers)

Four issues were discovered during pre-main-run qualitative diagnostics on the frozen pilot data. All four are **infrastructure artifacts**, not experimental effects:

### F1. Response-truncation artifact in judging (MAJOR)
The platform `run_status` MCP tool returns `finalResponse` capped at 16,000 characters
(`api/mcp/tools/getRunStatus.ts`: `MAX_RESPONSE_CHARS = 16000`; truncation marker `…[truncated]`).
The pilot runner stored this capped text and the judges scored it. **130/371 pilot runs (35.0%) hit the cap.**
Truncation is confounded with the design because team cells concatenate three agents' outputs:

| cell | truncated rate |
|---|---|
| cheap team (C-T) | 0.75 |
| cheap solo (C-S) | 0.41 |
| frontier team (F-T) | 0.26 |
| frontier solo (F-S) | 0.12 |

Consequence: the interim-1 "inverted" tier×structure interaction (d = −0.161, p = 0.018) is entirely carried by truncated runs — on non-truncated runs only, the interaction is −0.013 (p = 0.90). **Lesson for future researchers:** when scoring long multi-agent outputs with LLM judges, verify the full solution text reaches the judge; transport-layer display caps silently become a construct-irrelevant difficulty that covaries with condition.

### F2. Judge emission truncation (MAJOR)
Judge `max_tokens = 512` was too small for verbose justifications: 442/16,695 dimension scores are null (2.65%), of which **356 are deepseek-chat, 334 of them on Cultural Sensitivity — the dimension simply never appears** because the justification overflows mid-Elaboration. Cultural Sensitivity is therefore currently scored by 2 of 3 judges for affected solutions. **Lesson:** judge output budgets must exceed the worst-case justification length; add an automated integrity check rather than trusting emission.

### F3. Persona–rubric construct tension (not an artifact; interpretive finding)
The negative persona main effect decomposes by dimension: personas raise Novelty (+0.13) and Cultural Sensitivity (+0.08) but cut Elaboration (−0.49) and Usefulness (−0.53). Qualitative reading shows Culture_5 is faithfully embodied (indirect, suggestive style) and that style mechanically shortens outputs (−17% mean length). This is a genuine persona-style × rubric-construct tension, retained as an interpretation note — **no design change**, but registered here so the composite-DV reading is not over-interpreted.

### F4. Family-dependent length bias risk
Length–quality correlation differs by family (claude −0.06 … gemini +0.66). Length is therefore registered as a logged covariate with pre-specified sensitivity analyses (A1.4).

---

## 2. Amendment items

### A1.1 — Judges score FULL solution text
**Change:** judging reads solutions from a full-text store (`runs/fulltext/*.json`, built by `code/capture_fulltext.py` / `code/main_run.mjs` from the `export_run` archive, which carries uncapped `agentResponses.content`) instead of the `run_status`-capped `finalResponse`. Every run record logs `truncatedAtSource` (did transport cap the text?) and `fulltextLen` (what the judge saw).
**Rationale:** judging validity requires the stimulus as generated; the cap is a display-layer policy of the transport tool, not a property of the solutions.
**Validity impact:** removes a design-confounded measurement artifact; no change to the construct being measured.

### A1.2 — Judge emission integrity (max_tokens 512 → 2048 + automatic completeness check)
**Change:** judge `max_tokens` raised to 2048; after parsing, any judgment missing ≥1 of the 5 dimensions is retried (≤2 extra calls); persistent failures are logged `incomplete: true` and audited, never silently dropped. Every judgment record logs `max_tokens` and `harness: judge_v2/A1`.
**Rationale:** F2. The rubric, prompt variants, judges, and temperature are unchanged — only the emission budget and the integrity gate change.
**Validity impact:** restores the pre-registered 3-judge ensemble on all 5 dimensions.

### A1.3 — Truncation and length audit trail
**Change:** every generation record (main run) carries `truncatedAtSource`, `fulltextLen`, `fulltextSource`, `concurrency`; every judgment record carries `max_tokens`, `harness`, `completion_retry`. The run ledger reports aggregate truncation counts.
**Rationale:** makes any future transport/model-cap artifact detectable in seconds (this was found only by qualitative inspection).

### A1.4 — Length as a pre-registered robustness covariate
**Change:** add to the analysis plan: (a) output length per run logged; (b) length-adjusted sensitivity of the primary interaction (`quality ~ tier*structure*persona + log(length) + …`); (c) report the family-specific length–quality correlations. Primary inference remains on the unadjusted pre-registered model.
**Rationale:** F4; length bias in LLM judges is documented (Zheng et al. 2023). Sensitivity-only, so no multiplicity burden on primary tests.

### A1.5 — Pilot repair: re-judge the 130 capped pilot runs from full text (OPTIONAL, author-gated)
**Change (conditional):** re-score the 130 capped pilot solutions using their archived full text (`runs/fulltext/pilot_repair_capped.json`, already built; 111 of 130 have longer full text) with the v2 harness, producing an artifact-corrected pilot table for the appendix. The original capped-text judgments are retained as the historical record.
**Status:** prepared, NOT executed — deferred to the discount window with the main run; requires explicit author approval. Judging-only cost (no generation).

---

## 3. What does NOT change (frozen items reaffirmed)

Hypotheses H1–H5 and E1; 2×2×2 design and 8 cells; 5 families; 30 problems (11 pilot / 19 main);
persona pool, solo persona (Culture_5) and congruent trio mapping; frozen D10 judge prompt variants (verbatim);
judge panel composition (deepseek-chat, GLM-5.2 thinking-off, Llama-3.3-70B); blinding procedure;
primary model `quality ~ tier*structure*persona + (1|problem) + (1|family)`; sequential stopping rules (Protocol 03);
D27 temperature=1 and D28 generation max_tokens=8192; reps (cheap 3 / frontier 2); c=100 concurrency regime.

## 4. Interim-1 decision status

Interim-1 (CONTINUE to main run) **stands and is strengthened**: its primary anomaly is now attributed to a
identified artifact (F1), and the corrected infrastructure prevents recurrence. No re-analysis gate is triggered;
the pilot is never pooled into confirmatory inference (D31/D32).

## 5. Implementation status (2026-07-30)

| Item | Artifact | State |
|---|---|---|
| A1.1 | `code/capture_fulltext.py` → `runs/fulltext/pilot_fulltext.json` (371 runs), `pilot_repair_capped.json` (130 runs) | DONE & verified |
| A1.1 | `code/main_run.mjs` (full-text capture per run, D34 writer isolation, seed-42 interleaving) | DONE, dry-run validated (1,900 runs) |
| A1.2 | `code/judge_v2.py` (max_tokens 2048, completeness retry, audit fields) | DONE, compile-checked, NOT executed |
| A1.3 | audit fields in `main_run.mjs` + `judge_v2.py` | DONE |
| A1.4 | analysis-plan delta (§6) | REGISTERED (pending OSF) |
| A1.5 | `runs/fulltext/pilot_repair_capped.json` + `judge_v2.py --store … --out pilot_repair_judgments.jsonl` | READY, author-gated |
| factorial completeness | `code/create_ft_remaining.mjs` → 6 F-T pipelines created (projects 49–54); registry = 40 pipelines | DONE (zero generation cost) |

## 6. Re-registration (OSF delta)

The exact OSF-facing delta text is maintained at
`research/orchestration-economics/preregistration/amendment_A1_osf_delta.md`.
It MUST be applied to the OSF registration (as an update with the original version preserved) **before the first main-run generation call**.

## 7. Sign-off

- [x] Author approval of A1.1–A1.4 — approved 2026-08-04 ("ok as long as it is based on academic data"; condition satisfied: every item is grounded in the pilot empirical evidence, QUALITATIVE-NOTES.md F1–F4, and cited literature in DESIGN-DECISIONS D35–D38)
- [x] Author decision on A1.5 (pilot re-judge: yes / no / after main run) — **YES, executed 2026-08-04** (author instruction to re-judge during the discount window; results in results/PILOT-V2-ANALYSIS.md, MANIFEST Entry 18)
- [x] OSF delta applied — author-confirmed 2026-08-04 (link: pending registration version number — to be filled when available)
- [ ] Discount window open → execute per `LAUNCH-CHECKLIST.md` — window OPEN 2026-08-04 (14:00–00:00 UTC); judging re-judge executed; **main run awaits author's explicit go + provider credit confirmation**
