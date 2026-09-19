# Protocol 10 — Study 2 Qualitative Analysis: Why Refinement Stops at Parity

**Date:** 2026-07-30 · **Author:** Y. Hariri · **Analyst:** agent (all decisions logged)
**Status:** pre-registered BEFORE execution (anti-HARKing, D39 abductive-cycle rule).
**Position in the cycle:** Study 2 quantitative results (Entry 30/31) → abductive
explanation phase → this protocol → back to deductive check.

## 1. Why

The quantitative results leave three questions only qualitative evidence can answer:
- **RQ1 (frontier edge):** what do F-S-N frontier answers contain that refined C-T-P
  answers still lack — i.e., why do judges still prefer the frontier?
- **RQ2 (style vs length):** does refinement move answers toward the frontier's
  feature profile, or does it mainly inflate length (1.75×)?
- **RQ3 (claude saturation):** why did refinement barely change claude answers?

## 2. Pre-registered free preliminary (no coding)

P0: for all 171 refined answers, correlate length ratio (refined/original) with
composite change (refined − original), per family and pooled (Pearson + Spearman).
Interpretation rule fixed now: |r| ≥ 0.3 with p < 0.05 → length inflation is a
prime suspect and must be discussed; otherwise set aside.

## 3. Sample (locked BEFORE coding)

- Universe: the 171 Study-2 pairs (pilot + extension, Entry 29/30).
- Draw 30 triples at random, 10 per family, seed **20260801**. A triple =
  (original C-T-P, refined C-T-P, paired same-problem same-family F-S-N).
- No replacement, no re-draw, no outcome-based selection.

## 4. Method (reuses the frozen A4/A4.6 machinery, Entry 27 precedent)

- **Wave 1 (inductive):** 2 coders (deepseek-v4-flash, GLM-5.2 — same reliability
  coders as A4.6) each freely code 6 triples (2/family → 18 texts), listing
  observable features. temp 0, blinded (no family/label/score).
  Wave-1 triple selection rule (locked): for each family, the 2 triples with the
  lowest tripleId.
- **Codebook:** the analyst freezes ~12 codes merging the deductive skeleton
  (RQ1–RQ3 anchors below) with Wave-1 observations. Frozen verbatim before Wave 2.
- **Wave 2 (closed):** both coders independently code PRESENT/ABSENT for every
  code on all 90 texts (30 triples × 3 roles). temp 0, blinded.
- **Reliability gate:** per-code and pooled Cohen's κ; threshold 0.70 (Protocol 02).
  Codes below 0.70 are disclosed and any conclusion resting on them is downgraded
  to medium reliability (A4.6 precedent).

### Deductive skeleton (anchors, to be refined by Wave 1, not replaced)
- RQ1 frontier-edge candidates: original insight/reframing; depth of reasoning;
  concision/density; specificity of evidence; structural coherence.
- RQ2 refinement-effect candidates: added operational steps; added metrics/KPIs;
  added risk tables/timelines; redundancy/bloat; preservation of creative voice.
- RQ3 saturation candidate: already-completeness signal (nothing left to add).

## 5. Locked analysis plan (fixed BEFORE Wave 2 output is read)

- Code-prevalence profiles per family per role (original / refined / frontier).
- RQ2 convergence metric: per family, share of codes where refined's prevalence
  moves TOWARD frontier's prevalence vs away; plus per-code deltas.
- RQ1: codes where frontier prevalence − refined prevalence ≥ 0.30 → reported as
  the frontier's residual edge (only from κ-reliable codes).
- RQ3: claude's refined-vs-original code-change count vs kimi/qwen.
- All 12+ codes reported in full; no post-hoc dropping.

## 6. Budget and gates

- New API calls ≈ 18 (Wave 1) + 180 (Wave 2: 90 texts × 2 coders) ≈ 200, cheap
  coders, concurrent (standing order). No new generation of answers, no re-judging.
- If completion < 95% after 3 retries per item: audit-exclude and disclose
  (A4.6 precedent), never patch the codebook post hoc.

## 7. Claim discipline

Findings enter the paper's Discussion as mechanism evidence for the negative
superiority result. No new superiority claim may be derived from this protocol.
