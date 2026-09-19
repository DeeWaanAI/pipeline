# Amendment A4 — Inductive Qualitative Analysis (Thematic, Grounded-Theory Style)

**Status:** Author-approved 2026-08-07 ("ok proceed with all of them")
**Scope:** qualitative follow-up on the LOCKED interim-2 dataset (read-only on
`runs/fulltext/main_fulltext.json` + `runs/logs/main_judgments.jsonl`).
**Supersedes in part:** Protocol 02's deductive codebook becomes a secondary
verification pass (A4.5). The PRIMARY analysis is inductive.
**Design label:** explanatory sequential mixed-methods (quantitative done, qualitative
explains the numbers; Creswell). Methodology: reflexive thematic analysis with
grounded-theory coding stages (Braun & Clarke 2006; Charmaz 2006). Trustworthiness
criteria: Lincoln & Guba 1985 (credibility, transferability, dependability, confirmability).

## 1. Research questions (no hypotheses — themes must emerge)

- **RQ1** Why do persona-loaded cheap_sibling teams beat frontier singles on some
  problems/families? (mechanism)
- **RQ2** What do winning persona-team outputs observably DO differently — wording,
  structure, reasoning style? (how)
- **RQ3** Why is the tier × structure interaction strong for kimi/claude but absent for
  gpt/gemini? (model-family contingency)
- **RQ4** Why does persona loading raise Novelty (+0.15) while cutting Usefulness
  (−1.02) and Elaboration (−0.97)? (from A3.5)

## 2. Data as "interviews"

Each generator output is treated as a transcript: wording, structure, reasoning moves,
and framing are the raw material. Composite scores and cell labels are withheld from the
coders during open coding (blinding), revealed only at synthesis.

## 3. Sampling — purposive, contrast-driven (A4.2)

Waves, with saturation-based stopping (sampling stops when a wave adds no new codes):

- **Wave 1 (n = 30):**
  - W1a persona-team winners: top-composite C-T-P, 2 runs per family (10)
  - W1b frontier baseline: top-composite F-S-N, 2 runs per family (10)
  - W1c non-responder probe: gpt-family and gemini-family C-T-P runs nearest the family
    median composite (5 + 5)
- **Wave 2 (n ≤ 30):** targets gaps found in Wave 1 synthesis, notably RQ4 (P runs with
  high Novelty but low Usefulness vs matched N runs on the same problem).

## 4. Coding procedure

- **Open coding (A4.1):** two independent LLM coders (deepseek-v4-flash, GLM-5.2),
  temperature 0, blinded. Prompt forbids pre-set themes; each coder returns codes with
  definitions and verbatim supporting quotes.
- **Axial coding / synthesis:** a third model (Llama-3.3-70B) as adjudicator merges the
  two code lists into candidate themes and subthemes; disagreements logged, not silently
  resolved (confirmability).
- **Reliability:** code-list overlap and presence/absence agreement reported; reflexivity
  notes recorded per wave (audit trail in MANIFEST).
- **Deductive verification pass (A4.5):** after induction concludes, protocol 02's six
  pre-set themes are applied to the same sample to check convergence (methods
  triangulation).

## 5. Outputs

- `code/qual_a4_sample.py` → `runs/qual/sample_waveN.json`
- `code/qual_a4_code.py` → `runs/logs/qual_codes_waveN.jsonl` (resumable, concurrent)
- `code/qual_a4_synthesize.py` → `results/QUALITATIVE-A4.md` (themes, subthemes,
  evidence quotes, answers to RQ1–RQ4) + `results/qual_themes.json`

## 6. Integrity

All outputs are labeled EXPLORATORY. A4 findings inform the paper's discussion and may
generate claims only for future pre-registered studies; they cannot alter the interim-2
decision (A2 §4 clause extended to A3 and A4).
