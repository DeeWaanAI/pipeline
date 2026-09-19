# Automated Qualitative Analysis Protocol (LLM Coder)

**Objective.** Use an LLM as an automated coder to analyze generator outputs for thematic
patterns (e.g., cultural adaptation, structural rigor, persona consistency). Report
inter-coder reliability (LLM vs. LLM, or LLM vs. human spot-checks).

---

## 1. Codebook development

### Step 1: Define initial themes (deductive)

Based on the research questions, define 4–6 initial themes:

| Theme | Definition | Example indicators |
|-------|------------|-------------------|
| **Cultural adaptation** | Output adapts to the cultural context of the problem (even though personas are psychological, not geographic) | References to cultural norms, values, communication styles |
| **Structural rigor** | Output demonstrates clear structure (problem statement, analysis, recommendations) | Headings, bullet points, logical flow |
| **Persona consistency** | Output reflects the assigned persona (if persona_loaded) | Tone, vocabulary, perspective consistent with persona description |
| **Depth of analysis** | Output goes beyond surface-level recommendations | Multi-step reasoning, trade-offs, evidence |
| **Actionability** | Output provides concrete, actionable recommendations | Specific steps, timelines, metrics |
| **Creativity** | Output offers novel or unconventional solutions | Unexpected angles, innovative approaches |

### Step 2: Refine the codebook (inductive)

- **Sample 10 outputs** (2 from each of 5 cells: C-S-N, C-T-P, F-S-N, F-T-P, and one exploratory).
- **Have the LLM coder** apply the initial themes and suggest new themes.
- **Review and refine:** add, merge, or drop themes based on the LLM's suggestions.
- **Finalize the codebook:** 4–6 themes with clear definitions and example indicators.

### Step 3: Develop coding instructions

Write clear instructions for the LLM coder:

> "You are a qualitative coder. Your task is to analyze the following output and code it
> for the presence of the following themes: [list themes with definitions]. For each theme,
> indicate whether it is present (1) or absent (0). If a theme is present, provide a brief
> quote from the output that illustrates the theme. If you are unsure, code as absent (0)."

## 2. Coding procedure

### Step 1: Select outputs to code

- **Subset:** 110 outputs (11 problems × 10 cells, or a stratified sample of 2 outputs per cell × 8 cells × 11 problems = 176 outputs).
- **Stratification:** ensure representation across all 8 cells and 11 pilot problems.

### Step 2: LLM coding (primary coder)

- **LLM:** use a frontier model (e.g., GPT-4, Claude Opus) as the primary coder.
- **Prompt:** use the finalized codebook and coding instructions.
- **Output:** for each output, record:
  - Theme presence (0/1) for each theme.
  - Example quote (if theme is present).
  - Confidence score (0–100, optional).

### Step 3: Reliability check (secondary coder)

- **Option A (LLM vs. LLM):** use a different LLM (e.g., Claude Opus as primary, GPT-4 as secondary) to code the same 176 outputs. Compute Cohen's κ for each theme.
- **Option B (LLM vs. human):** have a human coder (you or a research assistant) code a subset (e.g., 30 outputs) and compute Cohen's κ.
- **Target:** κ ≥ 0.70 (acceptable reliability) for each theme.

### Step 4: Resolve disagreements

- **If κ < 0.70:** review the codebook, clarify definitions, and re-code.
- **If disagreements persist:** use a third coder (LLM or human) to adjudicate.

## 3. Analysis

### Step 1: Compute theme prevalence

For each cell, compute the proportion of outputs coded as present for each theme:

| Cell | Cultural adaptation | Structural rigor | Persona consistency | Depth | Actionability | Creativity |
|------|---------------------|------------------|---------------------|-------|---------------|------------|
| C-S-N | 0.20 | 0.30 | 0.00 | 0.25 | 0.40 | 0.15 |
| C-T-P | 0.50 | 0.70 | 0.80 | 0.60 | 0.75 | 0.35 |
| ... | ... | ... | ... | ... | ... | ... |

### Step 2: Test for differences

- **Chi-square test:** for each theme, test whether prevalence differs across cells.
- **Post-hoc:** pairwise comparisons with Bonferroni correction.

### Step 3: Qualitative examples

Select 2–3 representative quotes for each theme and cell. These will be used in the paper
to illustrate the themes.

## 4. Reporting

### In the paper

> "We conducted a thematic analysis of 176 outputs using an LLM coder (GPT-4) with a
> structured codebook (6 themes: cultural adaptation, structural rigor, persona consistency,
> depth, actionability, creativity). Inter-coder reliability (LLM vs. LLM) was acceptable
> (Cohen's κ = 0.72–0.85). The team structure increased structural rigor (χ²(7) = 24.3,
> p < 0.001) and depth (χ²(7) = 18.7, p = 0.009), while persona loading increased persona
> consistency (χ²(7) = 42.1, p < 0.001)."

---

## Task for the coder

1. **Develop the codebook:** define 4–6 themes with clear definitions and example indicators.
2. **Refine the codebook:** sample 10 outputs, have the LLM coder apply the themes, and refine.
3. **Write coding instructions:** clear prompt for the LLM coder.
4. **Code the outputs:** use the LLM coder to code 176 outputs (or a stratified sample).
5. **Compute inter-coder reliability:** LLM vs. LLM or LLM vs. human, compute Cohen's κ.
6. **Analyze theme prevalence:** compute proportions per cell, test for differences.
7. **Select qualitative examples:** 2–3 quotes per theme per cell.
8. **Save outputs:**
   - `codebook.md` (final codebook with definitions and examples).
   - `coding_results.json` (per-output codes, theme presence, quotes).
   - `reliability.json` (Cohen's κ per theme).
   - `theme_prevalence.csv` (proportion per cell per theme).
   - `qualitative_examples.md` (selected quotes).

## Acceptance criteria

- [ ] Codebook is finalized (4–6 themes with definitions and examples).
- [ ] Coding instructions are clear and reproducible.
- [ ] 176 outputs are coded (or a stratified sample).
- [ ] Inter-coder reliability is computed (Cohen's κ ≥ 0.70 for each theme).
- [ ] Theme prevalence is computed per cell.
- [ ] Qualitative examples are selected.
- [ ] All outputs are saved in the specified formats.

## Definition of Done

The qualitative analysis is complete. The experimenter can write in the paper: "We conducted
a thematic analysis of N outputs using an LLM coder with a structured codebook. Inter-coder
reliability was acceptable (κ = X–Y). The team structure increased [theme] (χ² = Z, p < 0.05)."
