# Pilot Size Power Analysis Protocol — Literature-Grounded (Option A)

**Objective.** Determine the statistically defensible number of problems to include in the
pilot run, where the pilot is a **random subset of the full 30-problem set**. The pilot
data will be **kept as part of the final dataset** (not discarded); the main run completes
the remaining problems to reach the full 30. The output must be citable in the paper's
methodology section.

---

## 1. Experimental design (fixed)

- **Design:** 2×2×2 within-subjects factorial
- **Factors:**
  - Tier: cheap_sibling (C) vs frontier (F)
  - Structure: solo (S) vs team_3step (T)
  - Persona: none (N) vs persona_loaded (P)
- **Cells:** 8 (C-S-N, C-S-P, C-T-N, C-T-P, F-S-N, F-S-P, F-T-N, F-T-P)
- **Model families:** 5 (gpt, claude, gemini, kimi, qwen) — within-cell factor
- **Problems:** 30 total (6 domains × 5), pilot is a random subset of N problems
- **Reps per cell:** per experiment_config.json (varies by cell; see `tiers.cells`)
- **Primary DV:** quality score from the frozen D33 judge panel (3 judges, non-reasoning,
  model-identity-disjoint from generators)
- **Economic DV:** cost per run (token count × provider pricing)

## 2. Task for the coder

### 2.1 Literature search (find 3–5 comparable studies)

Search for peer-reviewed LLM evaluation studies that use **within-subjects factorial
designs** (or crossed designs where the same items/problems/prompts are evaluated under
multiple conditions). Priority targets:

1. **Multi-agent vs. single-agent LLM comparisons** (e.g., "ChatDev," "MetaGPT,"
   "CAMEL," "AgentVerse") — look for effect sizes on quality/output scores.
2. **Persona/role effects in LLMs** (e.g., "persona-tuning," "role-playing agents") —
   look for effect sizes on task completion or quality ratings.
3. **Model tier comparisons** (e.g., "GPT-4 vs. GPT-3.5," "frontier vs. open-source") —
   look for effect sizes on benchmark scores or human ratings.
4. **Cost-quality tradeoffs in LLMs** (e.g., "cheap models + structure vs. expensive
   models alone") — look for effect sizes on quality per dollar.

**Search venues:** ACL, EMNLP, NeurIPS, ICLR, AAAI, arXiv (cs.CL, cs.AI, cs.MA).
**Date range:** 2023–2026 (focus on post-ChatGPT studies).

### 2.2 Effect size extraction

For each study, extract:
- **Effect size metric:** Cohen's d, partial η², or Cohen's f (for ANOVA).
- **Effect type:** main effect (tier, structure, persona) or interaction (tier × structure,
  structure × persona, tier × structure × persona).
- **Sample size:** number of items/problems/prompts in the study.
- **Outcome measure:** quality score, task completion rate, human rating, etc.

**If a study reports p-values but not effect sizes:** back-compute Cohen's d from t-tests
or partial η² from F-tests using standard formulas (cite the conversion formula).

**If a study reports confidence intervals:** extract the CI and back-compute the standard
error, then derive the effect size.

### 2.3 Power analysis

Using the extracted effect sizes, run a power analysis for the **primary comparison**:
the **tier × structure interaction** (the "can cheap team+persona match frontier?"
question). This is the interaction of greatest theoretical interest.

**Power analysis parameters:**
- **Test:** repeated-measures ANOVA (within-subjects factorial, 2×2×2).
- **Effect size f:** derived from the literature (report the range and the chosen value).
- **α = 0.05** (two-tailed).
- **Power = 0.80** (standard threshold).
- **Number of groups:** 8 (cells).
- **Number of measurements:** 5 (families, treated as repeated measures on problems).
- **Correlation among repeated measures:** estimate from the literature or assume r = 0.5
  (conservative) and run a sensitivity analysis on r.

**Tool:** Use G*Power (Faul et al., 2007) or R's `pwr` package. If using G*Power, report
the exact test family, statistical test, and input parameters. If using R, include the
script.

**Output:** the required number of problems (N) for the pilot.

### 2.4 Sensitivity analysis

Report a **power curve**: plot power (y-axis) vs. number of problems (x-axis, range 5–30)
for the chosen effect size f. This shows how power changes with pilot size and justifies
the chosen N.

Also report: "With N = X problems, we have 80% power to detect effects as small as f = Y."
This is the **sensitivity** of the design — what effect sizes we can reliably detect.

### 2.5 Secondary comparisons (optional but recommended)

If time permits, also run power analyses for:
- **Main effect of tier** (cheap vs. frontier, averaged over structure and persona).
- **Main effect of structure** (solo vs. team, averaged over tier and persona).
- **Main effect of persona** (none vs. loaded, averaged over tier and structure).
- **Structure × persona interaction** (does persona help team more than solo?).

Report these as supplementary power analyses.

## 3. Output requirements

Deliver a single markdown document (`PILOT-POWER-ANALYSIS.md`) with:

1. **Literature table:** 3–5 studies, with columns:
   - Citation (APA format).
   - Design (within-subjects? factorial? crossed?).
   - Sample size (number of items/problems).
   - Effect size (Cohen's d, partial η², or f) for the comparison of interest.
   - Outcome measure.
   - Notes (any caveats).

2. **Chosen effect size for power analysis:**
   - Justification: why this value (e.g., "median of extracted effect sizes," "most
     conservative," "most realistic given our design").
   - Sensitivity: what if the true effect size is smaller/larger?

3. **Power analysis result:**
   - Required N (number of problems for the pilot).
   - Tool used (G*Power / R script).
   - Input parameters (effect size f, α, power, number of groups, number of measurements,
     correlation among repeated measures).
   - Output: achieved power with the chosen N.

4. **Power curve:** plot (or table) showing power vs. N for the chosen f.

5. **Recommendation:**
   - "We recommend N = X problems for the pilot, which gives 80% power to detect the
     tier × structure interaction with effect size f = Y."
   - "This is X/30 = Z% of the full problem set."
   - "The remaining 30 − X problems will be run in the main run."

6. **Citation-ready paragraph:** a 150–200 word paragraph suitable for the paper's
   methodology section, citing the literature and the power analysis.

## 4. Acceptance criteria

The protocol is complete when:
- [ ] 3–5 comparable studies are identified and tabulated.
- [ ] Effect sizes are extracted (or back-computed) with citations.
- [ ] Power analysis is run for the tier × structure interaction.
- [ ] Sensitivity analysis is included (power curve or table).
- [ ] Recommendation is a specific N (number of problems) with justification.
- [ ] Citation-ready paragraph is written.
- [ ] All inputs, scripts, and outputs are saved in
  `research/orchestration-economics/runs/logs/pilot_power_analysis/`.

## 5. Notes for the coder

- **Do not guess effect sizes.** If a study doesn't report an effect size, either
  back-compute it from the reported statistics or exclude the study and note why.
- **Be conservative.** If effect sizes vary across studies, use the **smallest** (most
  conservative) for the power analysis. This ensures the pilot is powered to detect even
  small effects.
- **Document assumptions.** If you assume a correlation among repeated measures (e.g.,
  r = 0.5), state why and run a sensitivity analysis on that assumption.
- **Time budget:** this should take ~30–60 min. If it takes longer, you're going too deep
  into the literature — stop at 5 studies and proceed.

## 6. Handoff

Return the completed `PILOT-POWER-ANALYSIS.md` and the `pilot_power_analysis/` directory
to the experimenter. The experimenter will review, approve, and then we run the pilot
with the recommended N.

---

**Definition of Done.** The power analysis is defensible, citable, and gives a specific N
with justification. The experimenter can write in the paper: "We conducted an a priori
power analysis based on effect sizes reported in [citations]. For the tier × structure
interaction, we expected f = X. With α = 0.05, power = 0.80, and 8 cells × 5 families, we
required N = Y problems for the pilot."
