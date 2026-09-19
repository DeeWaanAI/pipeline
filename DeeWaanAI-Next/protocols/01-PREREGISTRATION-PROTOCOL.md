# Pre-Registration Protocol

**Objective.** Draft a pre-registration document for OSF (Open Science Framework) that
specifies hypotheses, primary outcome, sample size, analysis plan, and stopping rules
before the main run. The document must be time-stamped and citable.

---

## 1. Study design

- **Design:** 2×2×2 within-subjects factorial
- **Factors:**
  - Tier: cheap_sibling (C) vs frontier (F)
  - Structure: solo (S) vs team_3step (T)
  - Persona: none (N) vs persona_loaded (P)
- **Cells:** 8 (C-S-N, C-S-P, C-T-N, C-T-P, F-S-N, F-S-P, F-T-N, F-T-P)
- **Model families:** 5 (gpt, claude, gemini, kimi, qwen) — within-cell factor
- **Problems:** 30 total (6 domains × 5), pilot = 11 problems (random subset), main run = remaining 19

## 2. Hypotheses

### Primary hypothesis (tier × structure interaction)

> H1: The tier × structure interaction will be significant, such that the team structure
> improves quality more for cheap_sibling models than for frontier models.

**Rationale:** if cheap team+persona matches frontier solo, this supports the "orchestration
economics" thesis: structure can substitute for model tier.

### Secondary hypotheses

> H2 (main effect of tier): Frontier models will produce higher quality scores than
> cheap_sibling models, averaged over structure and persona.

> H3 (main effect of structure): Team structures will produce higher quality scores than
> solo structures, averaged over tier and persona.

> H4 (main effect of persona): Persona-loaded conditions will produce higher quality scores
> than no-persona conditions, averaged over tier and structure.

> H5 (structure × persona interaction): The persona effect will be larger for team structures
> than for solo structures (personas amplify structural rigor).

### Exploratory

> E1: Model family moderates the tier effect (e.g., the cheap-vs-frontier gap is larger for
> gpt/claude than for kimi/qwen).

## 3. Primary outcome

- **DV:** quality score from the frozen D33 judge panel (3 non-reasoning LLM judges,
  model-identity-disjoint from generators).
- **Aggregation:** mean of 3 judge scores per run (after removing outliers, if any).
- **Scale:** 1–5 Likert (or 0–100, depending on the rubric).

## 4. Secondary outcomes

- **Cost per run:** (input tokens × input price + output tokens × output price) per provider.
- **Latency per run:** wall-clock time from submission to final response.
- **Token efficiency:** quality score per dollar (DV / cost).

## 5. Sample size

- **Pilot:** 11 problems × 8 cells × 5 families × 1 rep = 440 runs (power = 0.81 at f = 0.30).
- **Main run:** 19 problems × 8 cells × 5 families × 2–3 reps = 3,040–4,560 runs.
- **Total:** 3,480–5,000 runs.
- **Justification:** pilot power analysis (see `pilot_power_analysis/PILOT-POWER-ANALYSIS.md`).

## 6. Statistical analysis plan

### Primary analysis

- **Test:** repeated-measures ANOVA (or linear mixed model with problem and family as random effects).
- **Model:** `quality ~ tier * structure * persona + (1 | problem) + (1 | family)`
- **Effect size:** partial η² (for ANOVA) or standardized coefficients (for mixed model).
- **Post-hoc:** pairwise comparisons with Holm-Bonferroni correction.

### Secondary analyses

- **Cost-effectiveness frontier:** scatter plot of quality vs. cost per cell, Pareto-optimal points.
- **Model family moderation:** add `family` as a moderator in the mixed model.

## 7. Exclusion criteria

- **Failed runs:** runs that did not complete (e.g., API errors, timeouts).
- **Paused credit:** runs paused due to credit exhaustion (exclude from analysis, but report count).
- **Outliers:** runs with quality scores > 3 SD from the cell mean (flag, but do not exclude unless justified).

## 8. Stopping rules

- **Sequential analysis:** interim analysis after pilot (11 problems). If p < 0.01 for the
  tier × structure interaction, stop and report. If p > 0.10, continue to main run.
- **Main run:** stop after 19 problems (or when power reaches 0.95, whichever comes first).

## 9. Blinding

- **Judges:** do not know the condition (tier, structure, persona). They see only the output.
- **Generators:** do not know they are in an experiment (standard pipeline execution).

## 10. Data sharing

- **Data:** raw data (run logs, judge scores, token counts) will be shared on Zenodo.
- **Code:** analysis scripts (R/Python) will be shared on GitHub.
- **Materials:** stimuli (30 problems), prompts, judge rubrics will be shared on OSF.

---

## Task for the coder

1. **Draft the pre-registration document** using the template above.
2. **Fill in the details:** specific hypotheses, sample size justification, analysis plan.
3. **Save to:** `research/orchestration-economics/preregistration/preregistration_v1.md`.
4. **Export to PDF** (for OSF submission).
5. **Time-stamp:** note the date and version.

## Acceptance criteria

- [ ] Pre-registration document is complete (all 10 sections filled).
- [ ] Hypotheses are specific and testable.
- [ ] Sample size is justified with power analysis citation.
- [ ] Analysis plan specifies the test, DV, and effect size metric.
- [ ] Stopping rules are explicit.
- [ ] Document is saved in markdown and PDF format.
- [ ] Time-stamp and version are noted.

## Definition of Done

The pre-registration document is ready for OSF submission. The experimenter can upload it
to OSF, time-stamp it, and cite it in the paper: "This study was pre-registered on OSF
(URL, time-stamp)."
