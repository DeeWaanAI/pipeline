# Protocol Amendment A2 — Extended Interim-2 Analysis Methods

**Amendment ID:** A2
**Date drafted:** 2026-08-05
**Status:** DRAFTED **before interim-2 data lock** (judging of the main run is in progress; no interim-2 results have been inspected). **Author-approved 2026-08-05. Registered on OSF 2026-08-06 (https://osf.io/mjb8x).**
**Scope:** analysis methods ONLY. No change to hypotheses, design, cells, families, problems, personas, prompts, stopping rules (R1/R2/R3), or alpha-spending schedule. All pre-registered primary tests remain the sole decision basis; A2 adds interval estimation, multiplicity control, robustness, and evidence-for-null layers around them.
**Provenance:** methods below are the validated statistical toolkit of Paper 2, *"Doing More with Less: How Cultural Personas Bridge the Cost-Performance Gap in LLMs"* (Hariri, DOI 10.5281/zenodo.19533619; code: `stats_with_anlysis.py`), adapted to the current 2×2×2 factorial / 5-family design. Adopting author-validated, already-published methods preserves cross-paper methodological continuity (memory: *实验决策须记录学术依据*).

---

## 1. Why this amendment exists

The pre-registered interim-2 plan (Protocol 03) specifies the primary tests and stopping rules. The pilot re-analysis (Amendment A1.5, `PILOT-V2-ANALYSIS.md`) revealed that point estimates + p-values alone were insufficient to adjudicate the truncation-confounded interaction: the decisive questions (*how precise is this contrast? is the residual effect real or noise? does the conclusion survive dropping one family?*) require interval estimates, multiplicity control, robustness checks, and null-evidence quantification. Paper 2's toolkit provides exactly these, already exercised by the author on comparable LLM-evaluation data. A2 registers their adoption **prospectively** — before any interim-2 outcome is seen.

---

## 2. Adopted methods

### A2.1 Bootstrap confidence intervals on all primary contrasts
Every primary contrast (tier×structure interaction, tier main effect, structure main effect, persona contrasts, per-dimension decompositions) reports Cohen's d with a **percentile bootstrap 95% CI (5,000 resamples, fixed seed recorded in the analysis script)**, in addition to the pre-registered Welch test. Resampling unit = run; problem-level cluster bootstrap reported as sensitivity (§A2.6 rationale).
*Grounding:* bootstrap CIs for effect sizes are robust to non-normality and unequal variance (Efron & Tibshirani 1993; Cumming 2014, interval-estimation emphasis).

### A2.2 False-discovery-rate control for contrast families
Secondary/exploratory contrasts (per-dimension effects, per-family simple effects) are evaluated with **Benjamini–Hochberg FDR (α = 0.05)** within each declared family of tests. Primary hypothesis tests keep the pre-registered sequential alpha spend untouched; FDR applies only to the secondary layer.
*Grounding:* BH-FDR controls multiplicity with greater power than Bonferroni for correlated test families (Benjamini & Hochberg 1995).

### A2.3 Factorial ANOVA with partial η² (sensitivity layer)
A full **2×2×2 (Tier × Structure × Persona) Type-II ANOVA with partial η²** is reported as a sensitivity analysis alongside the pre-registered mixed-effects model (family random effect per D24). Assumption diagnostics (residual normality, Levene homogeneity) reported as in Paper 2. If assumptions fail materially, the ANOVA is reported descriptively only and the mixed model remains authoritative.
*Grounding:* partial η² as standardized variance-accounted measure (Lakens 2013); assumption checking before interpreting omnibus tests (Field, Miles & Field 2012).

### A2.4 Bayes factors for evidence of absence
Where a pre-registered contrast is non-significant at interim-2, a **Rouder JZS Bayes factor for the t-test** (default Cauchy prior r = 0.707) quantifies evidence for H₀ vs H₁. **Correction to Paper 2:** Paper 2's `BF ≈ exp(−0.5·t²)·√(n/2)` approximation is replaced by the standard JZS computation (Rouder, Speckman, Sun, Morey & Iverson 2009), reported with the conventional interpretation bands (BF > 3 / < 1/3).
*Grounding:* BF enables symmetric evidence reporting — critical for adjudicating the pilot's weak residual reversal and any null persona effects (Dienes 2014; Rouder et al. 2009).

### A2.5 Leave-one-family-out sensitivity
Each pooled conclusion (tier effect, structure effect, interaction, T-EGR pooling) is re-estimated **dropping one model family at a time** (5 folds). A result is reported as *family-stable* iff sign and significance-class are preserved in all folds and the largest fold-change in d is reported. This directly extends Paper 2's leave-one-provider-out analysis to the current design.
*Grounding:* influence diagnostics for pooled cross-model estimates; the family random effect (D24) assumes exchangeability that LOO empirically stress-tests (Baayen, Davidson & Bates 2008, random-effects tradition).

### A2.6 Leave-problems-out generalizability
Primary pooled contrasts are re-estimated on a **problem-level split** (problems held out, all runs of held-out problems excluded) to test whether effects generalize across stimuli rather than idiosyncratic problems. Reported as train/test d pairs per Paper 2 §8.2, using the 19 main problems.
*Grounding:* stimuli-as-random-effects generalizability (Clark 1973); protects against problem-specific effects masquerading as design effects.

### A2.7 Sensitivity power analysis (replaces post-hoc power)
Instead of post-hoc power on observed effects, interim-2 reports **sensitivity power**: the minimum detectable effect (Cohen's d) at 80% power given the achieved per-cell n (α = final-stage spend). Achieved per-cell counts are logged in the analysis output.
*Grounding:* post-hoc power is a monotone function of the p-value and adds no information (Hoenig & Heise 2001); sensitivity analysis is the defensible alternative (Lakens 2022, *Sample Size Justification*).

---

## 3. Methods considered and rejected

| Paper 2 method | Decision | Reason |
|---|---|---|
| Post-hoc power on observed d | **Rejected** | Statistically uninformative (Hoenig & Heise 2001); replaced by A2.7 |
| IsolationForest outlier flagging on a single ordinal dimension | **Rejected** | Weak construct rationale for 1–5 ordinal ratings; replaced by A2.5/A2.6 influence analyses + the pre-registered length covariate (A1.4) |
| Domain-specific effect decomposition | **Deferred** | Only 19 main problems (no a priori domain taxonomy for this problem bank); recording as a Phase-2 candidate only |
| Paper 2's BF approximation formula | **Replaced** | Superseded by proper JZS computation (A2.4) |

---

## 4. Decision-rule integrity clause

R1/R2/R3 stopping boundaries and the O'Brien–Fleming alpha spend (Protocol 03) are computed **exclusively from the pre-registered primary tests**. No A2 output (CI, BF, FDR-adjusted p, LOO fold) may alter a stop/continue decision; A2 outputs are reported as estimation, robustness, and evidence layers attached to the decision, never as substitutes.

---

## 5. Implementation

- **Code:** new `code/analyze_main.py` implementing A2.1–A2.7 on top of the existing pilot-analysis pipeline (`analyze_pilot_v2.py` patterns); fixed seeds and all tuning constants recorded in-script.
- **Outputs:** `results/interim2_analysis.json` (machine-readable) + `results/INTERIM2-DECISION.md` (decision + A2 layers).
- **Timing gate:** this amendment is finalized before the interim-2 dataset is locked (judging completion). Any method added after data lock is exploratory-only and must be labeled as such in the paper.

## 6. OSF registration

The author held no prior OSF registration for this study. On 2026-08-06 the full
protocol suite was registered on OSF as an Open-Ended Registration, including this
amendment, with an explicit cover document (`00-COVER-AND-TIMING-DISCLOSURE.md`)
stating that the OSF timestamp post-dates main-run generation while A2 was drafted
and approved before interim-2 data lock.

- Registration: **https://osf.io/mjb8x** (submitted 2026-08-06 02:33 UTC, pending OSF moderation)
- Project node: https://osf.io/8pwej
- Files archived in registration: cover + protocols 01–04 + Amendments A1/A2 (7 files)
- OSF delta applied: `[x]` done (2026-08-06, via full registration; link above)

## 7. Author sign-off

- [x] Author approval of A2.1–A2.7 as registered interim-2 methods — **approved by author 2026-08-05** ("i approve A2")
- [x] Acknowledgment: primary stopping rules unaffected (§4) — approval covers the whole document including §4

---
*Drafted 2026-08-05 during main-run judging, before any interim-2 outcome inspection. Provenance code: `paper_4/What_to_keep_for_Github/code/stats_with_anlysis.py`.*
