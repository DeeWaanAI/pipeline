# Amendment A3 — Exploratory Advanced Statistics (Post-Lock)

**Status:** Author-approved 2026-08-06 ("ok proceed with all of them")
**Scope:** exploratory analyses on the LOCKED interim-2 dataset (hashes in `results/INTERIM2-DECISION.md` §1)
**Precedence:** this amendment adds analyses only. It changes no hypothesis, design, cell,
sample plan, or stopping rule. The interim-2 decision (H1 boundary crossed) is unaffected,
per the A2 §4 integrity clause, which is extended to A3.

## 1. Motivation

Three open questions emerged from exploratory subset tests after the interim-2 decision:

1. The tier × structure interaction holds with personas (d = −0.39) but is null without
   (d = −0.006) — the null needs evidence, not just p > 0.05.
2. Family-level tests differ (kimi, claude significant; qwen, gemini, gpt not) — are these
   true differences or estimation noise?
3. The persona main effect is reversed (N > P, d = −0.69) — which quality dimensions drive it?

## 2. Analyses (all read-only on locked data)

### A3.1 Linear mixed model
`composite ~ C(tier)*C(structure)*C(persona) + (1|problem) + (1|family)`
(Tool: statsmodels MixedLM.) This is the model protocol 03 §4 prescribes; it accounts for
within-problem and within-family correlation that cell-mean contrasts ignore.

### A3.2 Equivalence test (TOST) on the no-persona contrast
Two one-sided tests on the H1 contrast restricted to persona = N.
**Bounds:** SESOI d = ±0.20 (Cohen's small-effect convention; disclosed as an analyst
choice, consistent with the smallest effects of interest in this study). Claim of
"no interaction without personas" requires equivalence, not mere non-significance
(Schuirmann 1987; Lakens 2017).

### A3.3 Empirical-Bayes partial pooling across families
Per-family interaction estimates shrunk toward the grand mean, weights from within-family
SE and between-family variance. (Full MCMC unavailable in the environment — pymc not
installed; the empirical-Bayes estimator is disclosed as the substitute.)

### A3.4 Random-effects meta-analysis across families
Treat the 5 families as 5 studies of the same interaction. Problem-level contrast units
provide per-family effect estimates and SEs; DerSimonian–Laird τ², I², pooled effect.

### A3.5 Dimension decomposition of the persona effect
Per-dimension P−N effects (5 dimensions) with BH-FDR, identifying which dimensions drive
the reversed persona main effect.

## 3. Reporting rules

- All A3 outputs are labeled EXPLORATORY in every document.
- A3 results are reported in the paper's exploratory/post-hoc section, never as
  confirmatory evidence for H1–H5.
- Any A3 result that appears to contradict the interim-2 decision is reported alongside it,
  without altering the decision.

## 4. Outputs

- `code/analyze_exploratory.py` → `results/exploratory_analysis.json`
- Section 6 added to `results/INTERIM2-DECISION.md`
- MANIFEST Entry 24
