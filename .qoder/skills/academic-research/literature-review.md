# Literature Review Protocols

## Systematic Literature Search

### When to Conduct a Literature Search

- Before making any claim about effect sizes, typical results, or "known" findings.
- Before designing a study (to avoid duplicating existing work and to ground design decisions).
- Before running a power analysis (to extract effect sizes from comparable studies).
- When interpreting results (to contextualize findings relative to prior work).

### Search Strategy

**1. Define the research question.**
Use the PICO framework (Population, Intervention, Comparison, Outcome) or a similar structure:
- **Population:** LLM agents, multi-agent systems, etc.
- **Intervention:** tier (cheap vs. frontier), structure (solo vs. team), persona (none vs. loaded).
- **Comparison:** within-subjects (same problems) or between-subjects (different problems).
- **Outcome:** quality score, task completion rate, cost, latency.

**2. Identify keywords and synonyms.**
- **LLM agents:** "large language model," "LLM agent," "multi-agent system," "autonomous agent."
- **Factorial design:** "factorial," "within-subjects," "repeated measures," "2×2," "2×2×2."
- **Effect size:** "effect size," "Cohen's d," "eta-squared," "partial eta-squared," "power analysis."

**3. Choose databases and venues.**
- **Top venues:** ACL, EMNLP, NeurIPS, ICLR, AAAI, AAMAS (for multi-agent systems).
- **Preprint servers:** arXiv (cs.CL, cs.AI, cs.MA).
- **Databases:** Google Scholar, Semantic Scholar, PubMed (for interdisciplinary work).

**4. Set inclusion/exclusion criteria.**
- **Inclusion:** peer-reviewed, 2023–2026, within-subjects or factorial design, reports effect sizes (or enough info to back-compute).
- **Exclusion:** opinion papers, tutorials, non-empirical work, studies without quantitative outcomes.

**5. Screen and extract.**
- **Title/abstract screening:** quick pass to identify potentially relevant papers.
- **Full-text screening:** read the methods and results sections.
- **Data extraction:** use a standardized form (see below).

## Data Extraction Form

For each paper, extract:

| Field | Description |
|-------|-------------|
| **Citation** | Authors, year, title, venue, DOI/URL |
| **Design** | Within-subjects? Factorial? Crossed? 2×2? 2×2×2? |
| **Sample size** | Number of items/problems/participants |
| **Factors** | What were the independent variables? (e.g., model tier, structure, persona) |
| **Levels** | What were the levels of each factor? (e.g., GPT-4 vs. GPT-3.5, solo vs. team) |
| **Outcome measure** | What was the DV? (e.g., quality score, task completion rate) |
| **Effect size** | Cohen's d, partial η², or Cohen's f (with confidence interval if reported) |
| **p-value** | Exact p-value (not just p < 0.05) |
| **Direction** | Which condition was higher/lower? |
| **Notes** | Any caveats (e.g., small sample, unusual design, potential confounds) |

## Back-Computing Effect Sizes

If a paper doesn't report an effect size, you can back-compute it from other statistics.

### From t-test to Cohen's d

**Formula:**
```
d = t * sqrt(1/n1 + 1/n2)
```

**Example:** t(28) = 2.50, n1 = n2 = 15 → d = 2.50 * sqrt(1/15 + 1/15) = 0.91

### From F-test to partial η²

**Formula:**
```
partial η² = F * df_effect / (F * df_effect + df_error)
```

**Example:** F(1, 28) = 6.25, p = 0.019 → partial η² = 6.25 * 1 / (6.25 * 1 + 28) = 0.18

### From partial η² to Cohen's f

**Formula:**
```
f = sqrt(η² / (1 - η²))
```

**Example:** partial η² = 0.18 → f = sqrt(0.18 / 0.82) = 0.47

### From p-value to effect size

If only p-value is reported, you can back-compute the effect size using the `pwr` package in R or G*Power, but this requires knowing the sample size and assuming a specific test (e.g., t-test, ANOVA).

**Warning:** this is less precise than back-computing from t or F. Use only if no other option.

## Literature Review Protocol Template

Use this template when delegating a literature search to the coder:

---

### Literature Search Protocol: [Topic]

**Objective.** Identify 3–5 peer-reviewed studies that report effect sizes for [specific comparison, e.g., "tier × structure interaction in LLM evaluation studies"].

**Research question.** [State the question, e.g., "What is the typical effect size for the interaction between model tier (cheap vs. frontier) and structure (solo vs. team) on quality scores?"]

**Search strategy.**
- **Databases:** Google Scholar, Semantic Scholar, arXiv (cs.CL, cs.AI, cs.MA).
- **Keywords:** [list keywords and synonyms].
- **Date range:** 2023–2026.
- **Inclusion criteria:** peer-reviewed, within-subjects or factorial design, reports effect sizes (or enough info to back-compute).
- **Exclusion criteria:** opinion papers, non-empirical work, studies without quantitative outcomes.

**Data extraction.** Use the data extraction form above. For each paper, extract: citation, design, sample size, factors, levels, outcome measure, effect size, p-value, direction, notes.

**Back-computation.** If a paper doesn't report an effect size, back-compute it from t, F, or other statistics. Cite the conversion formula.

**Output.** A literature table (3–5 studies) with all extracted data, plus a summary of the range of effect sizes (min, max, median). If effect sizes vary, recommend a conservative value (e.g., median or smallest) for the power analysis.

**Time budget.** ~30–60 min. If it takes longer, stop at 5 studies and proceed.

---

## Synthesizing Effect Sizes

### When Effect Sizes Vary

If effect sizes vary across studies, don't just pick one arbitrarily. Instead:

1. **Report the range:** "Effect sizes ranged from d = 0.3 to d = 0.8 across 5 studies."
2. **Compute the median:** "The median effect size was d = 0.55."
3. **Consider study quality:** weight larger, more rigorous studies more heavily.
4. **Run a sensitivity analysis:** "We used d = 0.3 (most conservative) for the power analysis. With d = 0.55 (median), we would have even higher power."

### Meta-Analysis (Optional)

If you have 5+ studies with comparable effect sizes, you can run a meta-analysis to compute a weighted average effect size.

**Tool:** R's `metafor` package.

**When to use:** only if you have enough studies (5+) and they're comparable (similar designs, outcomes, populations).

**For your project:** a meta-analysis is probably overkill for a pilot power analysis. Just extract 3–5 effect sizes and use the most conservative.

## Citation-Ready Paragraph Template

After the literature review, write a citation-ready paragraph for the methodology section:

---

> "We conducted an a priori power analysis based on effect sizes reported in [citations]. For the primary comparison (tier × structure interaction), [Author et al. (Year)] reported a large effect (partial η² = 0.XX, d = 0.XX), while [Author et al. (Year)] reported a medium effect (partial η² = 0.XX, d = 0.XX). Using the most conservative estimate (d = 0.XX), we required N = XX problems to achieve 80% power with α = 0.05 (two-tailed) in a repeated-measures ANOVA with 8 cells and 5 families. This corresponds to X% of the full 30-problem set, with the remaining problems reserved for the main run."

---

## Common Pitfalls in Literature Reviews

| Pitfall | Correct Approach |
|---------|------------------|
| Citing only one study | Cite 3–5 studies to show the range of effect sizes |
| Using generic thresholds (e.g., "Cohen's d = 0.5") | Extract effect sizes from comparable studies |
| Not back-computing effect sizes | If a paper doesn't report an effect size, back-compute it from t, F, or other statistics |
| Ignoring study quality | Weight larger, more rigorous studies more heavily |
| Not reporting the range | Report min, max, and median effect sizes, not just one value |
| Not citing the search strategy | Document the databases, keywords, and inclusion/exclusion criteria |
