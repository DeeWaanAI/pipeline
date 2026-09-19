# Experimental Design Principles

## Factorial Designs

### When to Use

Factorial designs (2×2, 2×2×2, etc.) are appropriate when:
- You want to test **multiple factors** simultaneously (e.g., tier, structure, persona).
- You want to detect **interactions** between factors (e.g., does persona help team more than solo?).
- You want to maximize statistical power with a fixed number of observations (each condition combination is tested).

### Key Concepts

**Factors and levels:**
- **Factor:** independent variable (e.g., tier, structure, persona).
- **Level:** value of a factor (e.g., tier has 2 levels: cheap_sibling, frontier).
- **Cell:** one combination of factor levels (e.g., C-S-N = cheap, solo, no persona).

**Within-subjects vs. between-subjects:**
- **Within-subjects:** same experimental unit (e.g., problem, participant) is measured in all conditions. More powerful, but requires counterbalancing to avoid order effects.
- **Between-subjects:** different units in each condition. Less powerful, but avoids carryover effects.

**Your design:** 2×2×2 within-subjects factorial (problems are measured in all 8 cells).

### Full Factorial vs. Fractional Factorial

- **Full factorial:** all possible combinations (e.g., 2×2×2 = 8 cells). Detects all main effects and interactions.
- **Fractional factorial:** subset of combinations (e.g., 2^(3-1) = 4 cells). Saves resources, but confounds some effects.

**Recommendation:** use full factorial unless resource-constrained. Fractional factorial is defensible if you pre-register which interactions you're willing to confound.

## Randomization

### Why Randomize

Randomization protects against **confounding variables** (unmeasured factors that could explain your results). Without randomization, you can't claim causality.

### What to Randomize

- **Assignment of units to conditions:** which problems go in which cell? (In within-subjects designs, all problems go in all cells, so this is less critical.)
- **Order of conditions:** if conditions are run sequentially, randomize the order to avoid order effects.
- **Sampling of units:** if problems are sampled from a larger population, use random sampling (or stratified random sampling to ensure domain coverage).

### Stratified Random Sampling

If your population has subgroups (e.g., 6 domains), use **stratified random sampling** to ensure each subgroup is represented proportionally.

**Example:** if you want 30 problems from 6 domains, sample 5 problems from each domain (stratified) rather than 30 problems from the pooled set (which might over-represent some domains).

## Validity

### Internal Validity

**Question:** did the manipulation cause the effect, or was it something else?

**Threats:**
- **History:** external events between pre- and post-measurement.
- **Maturation:** units change over time (e.g., models improve between runs).
- **Testing:** the act of measuring changes the outcome (e.g., practice effects).
- **Instrumentation:** the measurement tool changes (e.g., judges drift over time).
- **Selection bias:** units in different conditions differ systematically.

**Mitigation:** randomization, control conditions, blinding, pre-registration.

### External Validity

**Question:** do the results generalize beyond this study?

**Threats:**
- **Population validity:** do the results hold for other populations (e.g., other problems, other models)?
- **Ecological validity:** do the results hold in real-world settings (e.g., production use)?
- **Temporal validity:** do the results hold over time (e.g., as models improve)?

**Mitigation:** random sampling from a well-defined population, replication in different settings, clear statement of generalizability limits.

### Construct Validity

**Question:** are you measuring what you think you're measuring?

**Threats:**
- **Mono-operation bias:** using only one measure (e.g., only LLM judges, no human judges).
- **Mono-method bias:** using only one method (e.g., only quality scores, no cost or latency).
- **Hypothesis guessing:** participants (or judges) guess the hypothesis and change behavior.

**Mitigation:** multiple measures (quality, cost, latency), multiple methods (LLM judges + human spot-checks), blinding (judges don't know the condition).

## Pre-Registration

### Why Pre-Register

Pre-registration protects against **questionable research practices** (QRPs):
- **HARKing** (Hypothesizing After Results are Known): claiming you predicted a result you actually discovered post-hoc.
- **P-hacking:** trying multiple analyses until you find a significant result.
- **Selective reporting:** only reporting analyses that worked.

### What to Pre-Register

1. **Hypotheses:** what do you expect to find? (directional or non-directional)
2. **Primary outcome:** what's the main DV? (e.g., quality score)
3. **Secondary outcomes:** what else will you measure? (e.g., cost, latency)
4. **Sample size:** how many units (problems, reps) and why? (power analysis)
5. **Statistical analysis plan:** what tests will you run? (e.g., repeated-measures ANOVA, mixed models)
6. **Exclusion criteria:** what data will you exclude and why? (e.g., failed runs, outliers)
7. **Stopping rules:** when will you stop collecting data? (e.g., after N problems, or when p < 0.05)

### How to Pre-Register

- **OSF (Open Science Framework):** free, widely used, supports time-stamped registrations.
- **Aspredicted.org:** user-friendly, designed for psychology/social sciences.
- **GitHub + timestamp:** commit the protocol to a public repo, tag a release, note the date.

**For your project:** pre-register on OSF or GitHub before running the pilot. Update the protocol if needed, but document all changes.

## Reproducibility

### What to Share

To make your study reproducible, share:
1. **Data:** raw data (anonymized if needed), in a standard format (CSV, JSON).
2. **Code:** analysis scripts (R, Python), with a README explaining how to run them.
3. **Materials:** stimuli (problems), instructions, prompts, judge rubrics.
4. **Pre-registration:** the original protocol, with any amendments documented.

### How to Share

- **Data:** Zenodo, Figshare, or OSF (assigns a DOI).
- **Code:** GitHub (public repo), with a license (e.g., MIT, Apache 2.0).
- **Materials:** OSF, GitHub, or supplementary materials in the paper.

### Reproducibility Checklist

- [ ] Raw data is available (with a data dictionary).
- [ ] Analysis code is available (with a README).
- [ ] Stimuli/materials are available.
- [ ] Pre-registration is available (with a timestamp).
- [ ] All analyses in the paper can be reproduced from the shared code and data.

## Common Experimental Designs in LLM Research

### Within-Subjects Factorial

**Example:** 2×2×2 factorial (tier × structure × persona) with problems as the unit of analysis.

**Strengths:** high power, controls for problem-level variance, detects interactions.
**Weaknesses:** requires many observations per problem, potential order effects if not counterbalanced.

### Between-Subjects

**Example:** different problems in each condition (e.g., 30 problems × 8 cells = 240 problems total).

**Strengths:** avoids carryover effects, simpler analysis.
**Weaknesses:** lower power (more variance), requires more problems.

### Mixed Design

**Example:** within-subjects for tier (both tiers on the same problems), between-subjects for structure (different problems for solo vs. team).

**Strengths:** balances power and practicality.
**Weaknesses:** more complex analysis, harder to interpret interactions.

**Your design:** within-subjects factorial (all 8 cells on the same problems). This is appropriate for your research question and maximizes power.
