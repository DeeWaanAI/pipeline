# Statistical Methods Reference

## Effect Sizes

### Cohen's d (for t-tests)

**Definition:** standardized mean difference between two groups.

**Formula:**
```
d = (M1 - M2) / SD_pooled
```

**Interpretation (Cohen, 1988):**
- Small: d = 0.2
- Medium: d = 0.5
- Large: d = 0.8

**Warning:** these are generic thresholds. Always check what effect sizes are realistic for your domain (see literature review).

**Back-computing from other statistics:**
- From t-test: `d = t * sqrt(1/n1 + 1/n2)` (where t is the t-statistic, n1 and n2 are sample sizes)
- From F-test (1 df): `d = sqrt(F * (1/n1 + 1/n2))`
- From p-value: use the `pwr` package in R or G*Power to back-compute.

### Partial η² (for ANOVA)

**Definition:** proportion of variance in the DV explained by a factor, after accounting for other factors.

**Formula:**
```
partial η² = SS_effect / (SS_effect + SS_error)
```

**Interpretation (Cohen, 1988):**
- Small: η² = 0.01
- Medium: η² = 0.06
- Large: η² = 0.14

**Conversion to Cohen's f:**
```
f = sqrt(η² / (1 - η²))
```

### Cohen's f (for ANOVA power analysis)

**Definition:** standardized effect size for ANOVA (analogous to d for t-tests).

**Formula:**
```
f = sqrt(η² / (1 - η²))
```

**Interpretation (Cohen, 1988):**
- Small: f = 0.10
- Medium: f = 0.25
- Large: f = 0.40

## Power Analysis

### What is Power?

**Power** = probability of correctly rejecting the null hypothesis when the alternative is true.

**Standard threshold:** power = 0.80 (80% chance of detecting a true effect).

**Factors affecting power:**
1. **Effect size:** larger effects are easier to detect (higher power).
2. **Sample size:** more observations = higher power.
3. **Alpha (α):** stricter thresholds (e.g., α = 0.01 vs. 0.05) reduce power.
4. **Variance:** more noise = lower power.

### Power Analysis for Repeated-Measures ANOVA

**When to use:** within-subjects factorial designs (e.g., 2×2×2 with problems measured in all cells).

**Parameters:**
- **Effect size f:** from literature or pilot data.
- **α:** typically 0.05 (two-tailed).
- **Power:** typically 0.80.
- **Number of groups:** number of cells (e.g., 8 for 2×2×2).
- **Number of measurements:** number of repeated measures (e.g., 5 families, or 30 problems).
- **Correlation among repeated measures:** estimate from literature or assume r = 0.5 (conservative).

**Tool:** G*Power (Faul et al., 2007) or R's `pwr` package.

**G*Power steps:**
1. Select "F tests" → "ANOVA: Repeated measures, within factors."
2. Input: effect size f, α, power, number of groups, number of measurements, correlation.
3. Output: required sample size (number of problems).

**R code (using `pwr` package):**
```r
library(pwr)
# For repeated-measures ANOVA
pwr.anova.test(k = 8,         # number of groups (cells)
               n = NULL,      # sample size per group (to be calculated)
               f = 0.25,      # effect size (from literature)
               sig.level = 0.05,
               power = 0.80)
```

### Sensitivity Analysis

**Purpose:** show how power changes with sample size (or effect size).

**Output:** power curve (plot of power vs. N for a fixed f, or power vs. f for a fixed N).

**Interpretation:** "With N = X problems, we have 80% power to detect effects as small as f = Y."

**R code for power curve:**
```r
library(pwr)
Ns <- seq(5, 30, by = 1)
powers <- sapply(Ns, function(n) {
  pwr.anova.test(k = 8, n = n, f = 0.25, sig.level = 0.05)$power
})
plot(Ns, powers, type = "l", xlab = "Number of problems", ylab = "Power")
abline(h = 0.80, lty = 2, col = "red")  # 80% power threshold
```

## Common Statistical Tests

### t-test (two groups)

**When to use:** comparing two conditions (e.g., cheap vs. frontier, solo vs. team).

**Assumptions:**
- Normality of residuals (check with Shapiro-Wilk test or QQ plot).
- Equal variance (check with Levene's test). If violated, use Welch's t-test.

**R code:**
```r
t.test(quality ~ tier, data = df, var.equal = FALSE)  # Welch's t-test
```

### ANOVA (3+ groups)

**When to use:** comparing 3+ conditions (e.g., 8 cells in a 2×2×2 factorial).

**Assumptions:**
- Normality of residuals.
- Equal variance (homogeneity).
- Sphericity (for repeated measures). If violated, use Greenhouse-Geisser correction.

**R code:**
```r
# One-way ANOVA
aov(quality ~ cell, data = df)

# Repeated-measures ANOVA (within-subjects)
aov(quality ~ cell + Error(problem), data = df)
```

### Linear Mixed Models (for factorial designs)

**When to use:** factorial designs with random effects (e.g., problems as a random effect).

**Advantages over ANOVA:**
- Handles unbalanced data (missing cells).
- Can include both fixed and random effects.
- More flexible covariance structures.

**R code (using `lme4` package):**
```r
library(lme4)
# Fixed effects: tier, structure, persona, and interactions
# Random effect: problem (intercept)
model <- lmer(quality ~ tier * structure * persona + (1 | problem), data = df)
summary(model)
anova(model)  # F-tests for fixed effects
```

**Interpretation:**
- Fixed effects: main effects and interactions of interest.
- Random effects: variance explained by problems (intraclass correlation).

### Multiple Comparisons Correction

**When to use:** running multiple statistical tests (e.g., pairwise comparisons between cells).

**Problem:** each test has a 5% chance of a false positive (Type I error). With 28 pairwise comparisons (8 cells), the family-wise error rate is ~76%.

**Solutions:**
- **Bonferroni correction:** divide α by the number of tests (e.g., α = 0.05 / 28 = 0.0018). Conservative.
- **Holm-Bonferroni:** step-down procedure, less conservative than Bonferroni.
- **Tukey's HSD:** for pairwise comparisons after ANOVA, controls family-wise error rate.

**R code:**
```r
# Tukey's HSD after ANOVA
model <- aov(quality ~ cell, data = df)
TukeyHSD(model)

# Pairwise t-tests with Bonferroni correction
pairwise.t.test(df$quality, df$cell, p.adjust.method = "bonferroni")
```

## Confidence Intervals

### Why Report Confidence Intervals?

**p-values** tell you whether an effect is statistically significant.
**Confidence intervals** tell you the range of plausible values for the effect size.

**Example:** "The tier effect was d = 0.65, 95% CI [0.42, 0.88], p < 0.001."

**Interpretation:** we're 95% confident the true effect size is between 0.42 and 0.88.

### How to Compute

**For Cohen's d:**
```r
library(MBESS)
ci.sm(mean.diff = 2.5, sd = 3.0, n = 30, conf.level = 0.95)
```

**For ANOVA effects:**
```r
# Partial η² confidence interval
library(effectsize)
eta_squared(model, partial = TRUE, ci = 0.95)
```

## Reporting Standards (APA)

### What to Report

For every statistical test, report:
1. **Test statistic:** t, F, χ², etc.
2. **Degrees of freedom:** df.
3. **p-value:** exact value (e.g., p = 0.023), not just p < 0.05.
4. **Effect size:** Cohen's d, partial η², etc.
5. **Confidence interval:** 95% CI for the effect size.
6. **Direction:** which condition was higher/lower?

**Example:**
> "A repeated-measures ANOVA revealed a significant tier × structure interaction, F(1, 29) = 8.42, p = 0.007, partial η² = 0.23, 95% CI [0.05, 0.42]. Post-hoc tests with Bonferroni correction showed that the team structure improved quality for cheap models (M = 3.8, SD = 0.9) but not for frontier models (M = 4.2, SD = 0.8), t(29) = 2.90, p = 0.007, d = 0.53."

### What NOT to Report

- Don't report only p-values without effect sizes.
- Don't use asterisks (*, **, ***) instead of exact p-values.
- Don't say "marginally significant" for p = 0.06. It's either significant (p < α) or not.
- Don't claim causality without randomization and control.

## Software and Tools

### R Packages

- **`pwr`:** power analysis (Cohen, 1988).
- **`lme4`:** linear mixed models.
- **`effectsize`:** effect size computation (Cohen's d, η², etc.).
- **`MBESS`:** confidence intervals for effect sizes.
- **`ggplot2`:** visualization.
- **`apaTables`:** APA-formatted tables.

### G*Power

**Download:** https://www.psychologie.hhu.de/arbeitsgruppen/allgemeine-psychologie-und-arbeitspsychologie/gpower.html

**Citation:** Faul, F., Erdfelder, E., Lang, A.-G., & Buchner, A. (2007). G*Power 3: A flexible statistical power analysis program for the social, behavioral, and biomedical sciences. *Behavior Research Methods*, 39(2), 175–191.

### Python

- **`statsmodels`:** statistical tests, ANOVA, mixed models.
- **`scipy.stats`:** t-tests, F-tests, etc.
- **`pingouin`:** effect sizes, confidence intervals, repeated-measures ANOVA.
