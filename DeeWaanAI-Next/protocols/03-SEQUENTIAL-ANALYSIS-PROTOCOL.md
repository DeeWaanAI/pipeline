# Sequential Analysis Protocol

**Objective.** Implement sequential analysis with the pilot as interim 1 and the main run
as interim 2. Pre-register stopping rules to avoid over-running or under-running the study.

---

## 1. Sequential design overview

- **Interim 1 (pilot):** 11 problems × 8 cells × 5 families × 1 rep = 440 runs.
- **Interim 2 (main run):** 19 problems × 8 cells × 5 families × 2–3 reps = 3,040–4,560 runs.
- **Total (if both stages run):** 3,480–5,000 runs.

**Decision points:**
1. After interim 1 (pilot): analyze the tier × structure interaction.
2. If the effect is clear (p < 0.01 or Bayes factor > 10), stop and report.
3. If the effect is unclear (0.01 ≤ p ≤ 0.10), continue to interim 2 (main run).
4. If the effect is clearly null (p > 0.10 and Bayes factor < 0.1), stop and report null.

## 2. Stopping rules

### Rule 1: Early success (stop after pilot)

- **Condition:** p < 0.01 for the tier × structure interaction (two-tailed).
- **Rationale:** strong evidence of an effect. No need to collect more data.
- **Action:** stop, report the effect size and confidence interval.

### Rule 2: Early futility (stop after pilot)

- **Condition:** p > 0.10 AND Bayes factor (BF₀₁) > 10 (strong evidence for the null).
- **Rationale:** strong evidence that the effect is negligible. Continuing would waste resources.
- **Action:** stop, report the null effect with confidence interval and Bayes factor.

### Rule 3: Continue to main run

- **Condition:** 0.01 ≤ p ≤ 0.10, OR p > 0.10 but BF₀₁ < 10 (inconclusive).
- **Rationale:** the effect is unclear. More data needed to reach a conclusion.
- **Action:** continue to interim 2 (main run).

### Rule 4: Final analysis (after main run)

- **Condition:** after interim 2, analyze the full dataset (pilot + main run).
- **Action:** report the effect size, confidence interval, and p-value. No further data collection.

## 3. Statistical tests

### Frequentist approach

- **Test:** repeated-measures ANOVA (or linear mixed model) for the tier × structure interaction.
- **Alpha spending:** use O'Brien-Fleming boundary (conservative, requires strong evidence at interim).
  - Interim 1: p < 0.01 (adjusted for early look).
  - Interim 2: p < 0.05 (final analysis).

### Bayesian approach (optional but recommended)

- **Bayes factor:** compute BF₁₀ (evidence for the alternative) and BF₀₁ (evidence for the null).
- **Thresholds:**
  - BF₁₀ > 10: strong evidence for the alternative (stop, report effect).
  - BF₀₁ > 10: strong evidence for the null (stop, report null).
  - 3 < BF < 10: moderate evidence (continue or stop, depending on context).
  - BF < 3: inconclusive (continue to main run).

**Tool:** R's `BayesFactor` package or Python's `pingouin` package.

## 4. Interim analysis procedure

### After the pilot (interim 1)

1. **Run the pilot:** 11 problems × 8 cells × 5 families × 1 rep = 440 runs.
2. **Compute judge scores:** mean of 3 judges per run.
3. **Fit the model:** `quality ~ tier * structure * persona + (1 | problem) + (1 | family)`.
4. **Extract the tier × structure interaction:**
   - p-value (from ANOVA or mixed model).
   - Effect size (partial η² or standardized coefficient).
   - Bayes factor (optional).
5. **Apply stopping rules:**
   - If p < 0.01 (or BF₁₀ > 10): stop, report.
   - If p > 0.10 and BF₀₁ > 10: stop, report null.
   - Otherwise: continue to main run.

### After the main run (interim 2)

1. **Run the main run:** 19 problems × 8 cells × 5 families × 2–3 reps.
2. **Combine pilot + main run data:** 30 problems total.
3. **Fit the model:** same as interim 1.
4. **Extract the tier × structure interaction:**
   - p-value (final analysis, α = 0.05).
   - Effect size (partial η² or standardized coefficient).
   - Bayes factor (optional).
5. **Report:** effect size, confidence interval, p-value, Bayes factor.

## 5. Reporting

### If stopping after pilot

> "We conducted a sequential analysis with the pilot as interim 1 (N = 11 problems). The
> tier × structure interaction was significant, F(1, 10) = 12.4, p = 0.006, partial η² = 0.55,
> 95% CI [0.20, 0.78], BF₁₀ = 15.2. We stopped data collection based on pre-registered
> stopping rules (p < 0.01 at interim)."

### If continuing to main run

> "We conducted a sequential analysis with the pilot as interim 1 (N = 11 problems). The
> tier × structure interaction was not significant, F(1, 10) = 3.2, p = 0.10, partial η² = 0.24,
> 95% CI [−0.05, 0.52], BF₁₀ = 2.1. Based on pre-registered stopping rules, we continued
> to the main run (N = 19 additional problems)."

### After main run

> "We conducted a sequential analysis with the pilot as interim 1 and the main run as
> interim 2 (total N = 30 problems). The tier × structure interaction was significant,
> F(1, 29) = 8.7, p = 0.006, partial η² = 0.23, 95% CI [0.05, 0.42], BF₁₀ = 12.3."

---

## Task for the coder

1. **Implement the interim analysis script:**
   - Input: pilot run data (11 problems × 8 cells × 5 families).
   - Output: p-value, effect size, Bayes factor for the tier × structure interaction.
   - Decision: stop (success), stop (futility), or continue.
2. **Save the script:** `research/orchestration-economics/code/sequential_analysis.py` (or `.R`).
3. **Document the stopping rules:** in the pre-registration document.
4. **Run the interim analysis after the pilot:** apply the stopping rules.
5. **Report the decision:** stop or continue, with justification.

## Acceptance criteria

- [ ] Interim analysis script is implemented and tested.
- [ ] Stopping rules are pre-registered (in the pre-registration document).
- [ ] Interim analysis is run after the pilot.
- [ ] Decision is documented (stop or continue, with justification).
- [ ] If continuing, the main run is executed.
- [ ] Final analysis is run after the main run (if applicable).

## Definition of Done

The sequential analysis is complete. The experimenter can write in the paper: "We conducted
a sequential analysis with pre-registered stopping rules. After interim 1 (pilot, N = 11),
the tier × structure interaction was [significant/not significant] (p = X, BF = Y). We
[stopped/continued] based on pre-registered criteria."
