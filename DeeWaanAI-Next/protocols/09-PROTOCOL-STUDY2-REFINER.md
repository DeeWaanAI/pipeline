# Protocol 09 — Study 2: End-of-Pipeline Refinement Stage (Refiner Experiment)

**Status:** pre-registered 2026-07-30 (author-approved same turn). Registry entry D39.
**Study label:** Study 2 (separate from Study 1 hypotheses H1–H5; anti-HARKing boundary per D39).
**OSF:** to be registered before the full run; pilot gate results do not touch Study 1 data.

## 1. Motivation (from Study 1, abductive step)

Study 1 found that cultural-persona cheap teams (C-T-P) beat some frontier solos
(kimi/claude/qwen families; pooled meta-analytic interaction d = −0.270) via a style
mechanism: personas raise Novelty (+0.154) but lower Usefulness (−1.024) and
Elaboration (−0.966) — QUALITATIVE-A4 RQ4. Study 2 tests whether a single frozen,
cheap, add-only refinement stage at the end of the pipeline recovers the lost
dimensions while preserving the Novelty gain.

## 2. Hypotheses (new, pre-registered)

- **H2.1 (primary):** refined C-T-P answers score higher on composite than the
  matched frontier-solo F-S-N answer (paired, same problem + family), for the
  three persona-winning families (kimi, claude, qwen). Directional paired t per
  family; Holm correction across the 3 families.
- **H2.2 (mechanism, protective):** refinement does NOT destroy the Novelty gain:
  Novelty(refined) ≥ Novelty(original C-T-P) − 0.10 (non-inferiority margin 0.10,
  justified by the pilot's measurement noise scale).
- **H2.3 (mechanism, repair):** refinement raises Usefulness and Elaboration above
  the original C-T-P values (paired, directional).

## 3. Design

- **Reuse, no regeneration:** original C-T-P and F-S-N full texts are archived
  (`runs/fulltext/main_fulltext.json`) with locked judgments
  (`runs/logs/main_judgments.jsonl`). Study 2 generates ONLY the refinement pass
  and judges ONLY the refined answers (frontier scores are reused — identical
  instrument, identical instrument version, so paired comparisons stay valid).
- **Refiner model:** deepseek-chat (the cheap workhorse; economics claim requires
  the stage to be cheap). Temperature 0, max_tokens 8192, one call per answer.
- **ONE universal frozen refiner prompt** (below) for all families and problems
  (D39: prompt = controlled variable). Any per-family prompt variation is a NEW arm,
  never a silent edit.
- **Sample (pilot gate):** 20 C-T-P answers per family, 3 families (kimi, claude,
  qwen) = 60. Selected by `random.Random(20260730)` from all completed C-T-P runs
  per family in the locked data — random, not top-scoring (avoids regression-to-mean
  and cherry-picking). Each refined answer is paired with the same-problem,
  same-family F-S-N run.
- **Judging:** frozen D10 panel via `judge_v2.py` unchanged (3 judges × 3 D10
  variants, blinded, full text, max_tokens 2048, completeness gate A1.2).
- **Concurrency:** refinement and judging run concurrent (user standing order;
  latency is not the measured object).

## 4. Frozen refiner prompt (verbatim — D39 add-only rule)

```
You are a senior business editor. Your task is to strengthen an existing answer to a
business problem. You must follow these rules exactly:

1. ADD ONLY. You may add: concrete implementation steps, operational details,
   measurable metrics and KPIs, a risk table with mitigations, sequencing/timeline,
   and role responsibilities.
2. NEVER REMOVE OR WEAKEN: original creative ideas, metaphors, rhetorical questions,
   cultural framing or local adaptations, the author's stance, tone, or voice.
3. Do not change the core recommendations or their reasoning. Do not make the answer
   more generic or more conservative.
4. Keep the same language as the original answer.
5. Output the COMPLETE improved answer only — no preamble, no critique, no summary of
   your changes.

=== BUSINESS PROBLEM ===
{problem_text}

=== ANSWER TO STRENGTHEN ===
{solution_text}
```

## 5. Pilot gate (before any full-run decision)

After the 60-answer pilot:
- G1 feasibility: refinement completion ≥ 95%, empty/malformed ≤ 5%.
- G2 signal: per-family paired d (refined vs F-S-N) estimated with bootstrap CI.
- Decision rule: if all three families show d ≥ 0.2 with CI excluding 0, proceed to
  full run n ≈ 8/d² per family (capped 150/family, Holm); otherwise stop and report
  pilot descriptively. No threshold may be changed after seeing results.

## 6. Analysis plan (locked)

- Primary: paired Welch-style comparison on the 9-score judgment mean per answer
  (same aggregation as Study 1: median of variants per judge, mean across judges),
  refined vs F-S-N, per family; effect size d = mean difference / pooled SD;
  1000-resample problem-level bootstrap CI; Holm across families.
- H2.2/H2.3: paired refined vs original C-T-P, per dimension (5 dims × 3 families,
  BH-FDR within this secondary block).
- Robustness: length of refined vs original logged; length-adjusted sensitivity
  reported (Study 1 practice, D37).
- All outputs machine-readable JSON + MANIFEST entry; failure rate disclosed.

## 7. Boundaries

- Study 2 results cannot alter Study 1 decisions (interim-2 closure, A2 §4 extended).
- Frontier and original C-T-P judgments are never re-run or edited.
- If the refiner systematically fails on a problem type, the fix is a new arm, not
  a prompt edit (D39).

## 8. Amendment — pilot extension (author-approved 2026-07-30, "most scientific" option)

- **Trigger:** pilot G2 failed partly due to an unfavorable random n=20 baseline
  (Entry 29). Author chose: extend to stabilize the baseline and re-estimate d.
- **Locked pool fact (measured BEFORE this amendment's execution):** the universe of
  C-T-P runs with an F-S-N mate is exactly 57 per family (kimi/claude/qwen). The
  extension therefore takes the FULL remaining pool: 37 additional random pairs per
  family, seed 20260731, disjoint from the pilot's 20 (which are kept intact and
  pooled — no silent replacement).
- **Total:** 57 pairs per family = 171 pairs; 171 new refinement calls + 1,539 new
  judgments. The pilot's 60 answers and their judgments are reused unchanged.
- **Analysis:** primary estimates are POOLED over all 57 per family; the pilot-20
  subset is reported alongside for transparency. Gate rule G2 is re-applied to the
  pooled estimates, mechanically, without threshold changes.
- **Boundaries unchanged:** no prompt edits; Study 1 decisions untouched; failures
  audited, not dropped.

## 9. Amendment — cross-family secondary analysis (author-approved 2026-07-30)

- **Question (author):** can cheap+design+persona (C-T-P) answers beat frontiers of
  OTHER families, even where they lose to their own family's frontier?
- **Status:** DESCRIPTIVE secondary analysis only — family quality is confounded with
  design in cross-family comparisons, so no causal design claim is made from it.
- **Locked pairing rule (fixed BEFORE any computation, no selection afterwards):**
  (A) Study-1 original data: for each ordered direction A->B (6 directions), pair
  every C-T-P run of family A on problem p with family B's F-S-N run on the same
  problem selected by MINIMAL runId (deterministic). Report ALL 6 directions.
  (B) Study-2 refined data: each of the 171 refined answers is paired against every
  other family's F-S-N run on the same problem (same minimal-runId rule), where one
  exists.
- **Stats:** paired t on composite, Cohen's d, 1000-bootstrap 95% CI, Holm over the
  6 directions in (A). No threshold/gate attached — this analysis does not trigger
  any run decision.
