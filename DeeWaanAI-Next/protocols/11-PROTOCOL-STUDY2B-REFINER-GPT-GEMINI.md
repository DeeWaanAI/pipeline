# PROTOCOL 11 — Study 2b: Factorial completion of the refinement stage
# Refiner identity × model family (2 × 5 design)

**Status:** PRE-REGISTRATION DRAFT — must be registered on OSF before the FIRST
new refinement call. Supersedes the earlier Study 2b draft (D41/D42 scope).
**Date:** 2026-08-21 | **Registry entries:** D39, D41, D42, D43
**Companion registrations:** OSF mjb8x (Study 1), Protocol 09 (Study 2)

## 1. Motivation and locked rationale (pre-data for all new arms)

Study 2 (Protocol 09) applied one universal cheap refiner (deepseek-chat, frozen
add-only prompt) to the persona-team answers (C-T-P) of three families
(kimi, claude, qwen). Results: refinement recovered up to 64% of the
frontier gap on absolute means, repaired part of the Usefulness/Elaboration
loss, but the within-family paired superiority test (G2) was rejected in the
pilot stage.

Two questions remain open, and both are necessary for the paper's central
claims:

1. **Process question (external validity):** does refinement work as a
   model-agnostic *process*, or was the Study-2 result an artifact of three
   families? Completing the universal-refiner condition for the two remaining
   families (gpt, gemini) tests the intervention across the full family
   universe under the identical frozen instrument.
2. **Attribution question (team effect):** the research question of this paper
   is the TEAM effect. A refined pipeline whose editor is a foreign model is a
   hybrid (family generation + foreign editing), so its result cannot be
   attributed to the family's team. If instead each family's own cheap-sibling
   model refines its own team's answers, the refined pipeline stays
   model-homogeneous (consistent with Study 1's team-homogeneity principle) and
   the result is attributable to the team itself.

**Locked abductive rationale (this exact text is the pre-data justification and
the paper's answer to reviewers):** after observing the Study-2 results on three
families, we pre-registered a two-arm extension: (i) arm U completes the
universal-refiner condition for the two remaining families, establishing whether
refinement generalizes as a process; (ii) arm W crosses refiner identity with
family by refining every family's team answers with that family's OWN
cheap-sibling model, establishing whether the team itself can repair its
answers. Because all five families receive both refiners (arm U directly for
gpt/gemini and via Study 2 for kimi/claude/qwen; arm W for all five), the design
is a 2 (refiner identity: universal vs within-family) × 5 (family) factorial in
which the within-family contrast isolates the refiner-identity effect while
holding the prompt, base answers, and judge panel constant. Design changes
between studies are pre-registered before any new data are collected, per the
preregistration principles of Nosek et al. (2018) and registry rule D39.

**Family-selection disclosure (locked, pre-data):** gpt and gemini were deferred
from Protocol 09 for budget staging, not excluded by design; Study 2b completes
the family universe.

**Pooling rule:** Study-2 data (kimi/claude/qwen × universal refiner) are reused
as-is — identical frozen prompt, identical judge panel, identical aggregation.
No other cross-study pooling is permitted.

## 2. Design

| | Universal refiner (arm U) | Within-family refiner (arm W) |
|---|---|---|
| gpt | deepseek-chat — Study 2b NEW | gpt-5.6-luna — Study 2b NEW |
| gemini | deepseek-chat — Study 2b NEW | gemini-3.1-flash-lite — Study 2b NEW |
| kimi | deepseek-chat — Study 2 (locked) | kimi-k2.6 — Study 2b NEW |
| claude | deepseek-chat — Study 2 (locked) | claude-haiku-4-5-20251001 — Study 2b NEW |
| qwen | deepseek-chat — Study 2 (locked) | qwen3.7-plus-2026-05-26 — Study 2b NEW |

**Frozen across ALL cells (controlled variables):**
- Refinement prompt: the Protocol 09 §4 universal add-only prompt, byte-identical
  (verified programmatically 2026-08-21). Tagged `protocol09-v1` in arm U,
  `protocol11-v1` in arm W (identical text; tags differ only to record refiner
  identity in logs).
- Base answers: locked Study-1 C-T-P full texts (never regenerated).
- Judge panel: frozen D10/D33 panel — deepseek-chat + zai-org/GLM-5.2 +
  Llama-3.3-70B (judge_v2.py, 3 variants per judge, median per judge then mean
  across judges). Frontier F-S-N and original C-T-P scores are REUSED from the
  locked Study-1 judgments (`runs/logs/main_judgments.jsonl`) — identical
  instrument and version, never re-judged.
- max_tokens 8192; one refinement call per answer.

**Varied factor:** refiner identity only.

## 3. Locked pool facts and samples

**Locked pool fact (measured pre-execution, 2026-08-21):** exactly 57
C-T-P↔F-S-N paired runs with archived full text per family, all 5 families,
verified against `runs/fulltext/main_fulltext.json`.

**Sampling (reuse-first principle — guarantees paired overlap between arms):**

| Arm / families | Pilot (20/family) | Extension (37/family) |
|---|---|---|
| U + W: gpt, gemini | `runs/refine_b/sample_pilot.json` (seed 20260821, drawn) | `refine_study2b_sample_ext.py` (seed 20260822, run only after gates) |
| W: kimi, claude, qwen | `runs/refine/sample_pilot.json` (Study 2's pilot, locked) | `runs/refine/sample_extension.json` (Study 2's extension, locked) |

Arm U and arm W for gpt/gemini share the SAME sample files → the
refiner-identity contrast is paired on identical problems. Arm W for
kimi/claude/qwen reuses Study 2's exact sample files → full paired overlap with
the universal-refiner condition (all 57/family when extension completes).

## 4. Refiner specifications (locked)

**Arm U:** deepseek-chat, temperature 0, endpoint per Protocol 09 (DEEPSEEK_API_KEY).

**Arm W (each family's own cheap sibling, from `config/model_registry.json`):**

| family | refiner model | endpoint | key | temp | $in/$out per 1M |
|---|---|---|---|---|---|
| gpt | gpt-5.6-luna | https://api.openai.com/v1 | OPENAI_API_KEY | 1 (API-enforced) | 1.0 / 6.0 |
| gemini | gemini-3.1-flash-lite | https://generativelanguage.googleapis.com/v1beta/openai | GEMINI_API_KEY | 0 | 0.25 / 1.5 |
| kimi | kimi-k2.6 | https://api.moonshot.ai/v1 | KIMI_API_KEY | 1 (API-enforced) | 0.95 / 4.0 |
| claude | claude-haiku-4-5-20251001 | https://api.anthropic.com/v1 (Messages API) | ANTHROPIC_API_KEY | 0 | 1.0 / 5.0 |
| qwen | qwen3.7-plus-2026-05-26 | https://dashscope-intl.aliyuncs.com/compatible-mode/v1 | ALIBABA_API_KEY | 0 | 0.32 / 1.28 |

Temperature asymmetries (1 for gpt/kimi, 0 for the rest) are API-enforced and
follow the Study-1 precedent D27 (uniform handling of provider-forced
constraints, logged, disclosed). Kimi thinking traces, if any, are excluded
(content field only). Any refiner change is a NEW arm, never a silent edit (D39).

## 5. Hypotheses (pre-registered; α = 0.05)

- **H3.1-U (process, primary):** within arm U (gpt, gemini), refined C-T-P
  superiority over matched F-S-N, paired, one-sided; families tested with Holm;
  pooled 5-family estimate (adding Study-2 families) reported as the
  generalization estimate of refinement-as-process.
- **H3.1-W (team attribution, primary):** within arm W, same test per family
  (5 families, Holm) plus pooled.
- **H3.2 (protection):** Novelty(refined) ≥ Novelty(original C-T-P) − 0.10,
  per arm × family (non-inferiority margin, as Protocol 09).
- **H3.3 (repair):** Usefulness and Elaboration gains of refined over original
  C-T-P, per arm × family (secondary block, BH-FDR).
- **H3.4 (refiner identity, primary):** on the pairs where both refiners exist
  (all 5 families once both arms complete), paired contrast composite(W) −
  composite(U), two-sided; pooled across families is primary, per-family with
  Holm is secondary. Direction is NOT pre-committed — this is a decomposition
  test, not a superiority claim.

## 6. Gates

- **G1 feasibility:** ≥95% of refinement calls succeed per arm-phase (else
  diagnose, document, and re-run failures before judging).
- **G2 superiority (pilot → extension):** per arm, every family in that
  arm-phase must show d ≥ 0.2 with bootstrap 95% CI excluding 0 in H3.1; only
  then does that arm extend to the remaining 37 pairs/family. Arms gate
  independently. (If a family fails G2 at pilot, its extension is withheld and
  reported as a pilot-stage null.)

## 7. Analysis plan (locked; script frozen before data)

- Paired Cohen's d_z with bootstrap CI (1,000 resamples, seed 42), mirroring
  `refine_study2_analyze.py` exactly (same aggregation, same test families of
  statistics).
- Holm-Bonferroni within each hypothesis family; BH-FDR for the per-dimension
  secondary block.
- Arm-aware implementation: `code/refine_study2b_analyze.py` with `--mode arm`
  (H3.1–H3.3 + gates per arm-phase) and `--mode identity` (H3.4 paired W−U).
- No post-hoc subgrouping, no optional stopping beyond the pre-registered gates.

## 8. Scheduling windows (cost constraints, locked 2026-07-30)

- **DeepSeek** (arm-U refiner + deepseek member of the judge panel): peak
  pricing UTC 01:00–04:00 and 06:00–10:00 (2×); off-peak = half price.
  ALL DeepSeek calls restricted to **UTC 04:00–06:00 or UTC 10:00–01:00**.
  Judging batches that include the deepseek judge inherit this window.
- **Qwen** (arm-W qwen refiner): off-peak 22:00–08:00 UTC+8 = **UTC 14:00–00:00**
  (~60% night discount). Qwen refinement calls restricted to that window.
  This window overlaps the DeepSeek off-peak window (UTC 14:00–00:00) — the two
  can share one execution block.
- OpenAI / Google / Anthropic / Together / Moonshot: flat pricing, any time.

## 9. Execution runbook (exact commands; NO step before OSF registration)

```bash
# 0. OSF registration of THIS protocol — hard prerequisite, then:

# --- ARM U (universal refiner completes the family universe) ---
# 1. Pilot refinement, gpt+gemini, deepseek-chat (frozen Study-2 runner, unchanged)
#    WINDOW: DeepSeek off-peak only (UTC 04:00–06:00 or 10:00–01:00)
python3 code/refine_study2_run.py \
  --sample runs/refine_b/sample_pilot.json \
  --log runs/logs/refine_b_U_pilot.jsonl \
  --store runs/refine_b/refined_store_U_pilot.json

# 2. Judge arm-U pilot (frozen panel; inherits DeepSeek window)
python3 code/judge_v2.py \
  --store runs/refine_b/refined_store_U_pilot.json \
  --out runs/logs/refine_b_U_judgments_pilot.jsonl

# 3. Pilot analysis + G1/G2 for arm U
python3 code/refine_study2b_analyze.py --mode arm --arm U --phase pilot \
  --samples runs/refine_b/sample_pilot.json \
  --judgments runs/logs/refine_b_U_judgments_pilot.jsonl \
  --refine-logs runs/logs/refine_b_U_pilot.jsonl \
  --out results/refine_study2b_U_pilot.json

# --- ARM W, block 1 (gpt+gemini, same pairs as arm U) ---
# 4. Pilot refinement with own cheap siblings (WINDOW: qwen NOT in this block)
python3 code/refine_study2b_run.py \
  --sample runs/refine_b/sample_pilot.json \
  --log runs/logs/refine_b_W_pilot.jsonl \
  --store runs/refine_b/refined_store_W_pilot.json

# 5. Judge arm-W pilot (gpt+gemini)
python3 code/judge_v2.py \
  --store runs/refine_b/refined_store_W_pilot.json \
  --out runs/logs/refine_b_W_judgments_pilot.jsonl

# 6. Pilot analysis + G1/G2 for arm W (gpt+gemini)
python3 code/refine_study2b_analyze.py --mode arm --arm W --phase pilot \
  --samples runs/refine_b/sample_pilot.json \
  --judgments runs/logs/refine_b_W_judgments_pilot.jsonl \
  --refine-logs runs/logs/refine_b_W_pilot.jsonl \
  --out results/refine_study2b_W_pilot.json

# --- ARM W, block 2 (kimi+claude+qwen, Study-2 pilot pairs) ---
# 7. WINDOW: qwen calls only UTC 14:00–00:00; judge batch in DeepSeek window
python3 code/refine_study2b_run.py \
  --sample runs/refine/sample_pilot.json \
  --log runs/logs/refine_b_W3_pilot.jsonl \
  --store runs/refine_b/refined_store_W3_pilot.json
python3 code/judge_v2.py \
  --store runs/refine_b/refined_store_W3_pilot.json \
  --out runs/logs/refine_b_W3_judgments_pilot.jsonl
python3 code/refine_study2b_analyze.py --mode arm --arm W --phase pilot \
  --samples runs/refine/sample_pilot.json \
  --judgments runs/logs/refine_b_W3_judgments_pilot.jsonl \
  --refine-logs runs/logs/refine_b_W3_pilot.jsonl \
  --out results/refine_study2b_W3_pilot.json

# --- Extensions (per arm, ONLY after that arm's G1+G2 pass) ---
# 8. gpt+gemini: python3 code/refine_study2b_sample_ext.py, then repeat steps 1-6
#    with sample_extension files (arm U: refine_study2_run.py; arm W: refine_study2b_run.py)
# 9. kimi+claude+qwen: re-run steps 7 with runs/refine/sample_extension.json

# --- H3.4 refiner-identity contrast (after both arms judged on same pairs) ---
python3 code/refine_study2b_analyze.py --mode identity \
  --samples runs/refine_b/sample_pilot.json \
  --judgments-u runs/logs/refine_b_U_judgments_pilot.jsonl \
  --judgments-w runs/logs/refine_b_W_judgments_pilot.jsonl \
  --out results/refine_study2b_identity_pilot.json
# (repeat with Study-2 judgment file for the kimi/claude/qwen identity contrast)
```

**Environment note:** sampling scripts are stdlib-only; judging/analysis need
`numpy`, `scipy`, `pandas` in the analysis interpreter.

## 10. Budget envelope

| Block | Refine calls (est. cost) | Judge calls (est. cost) |
|---|---|---|
| Arm U pilot+ext (gpt, gemini) | 114 × ~$0.002 ≈ $0.3 (off-peak) | 1,026 |
| Arm W gpt (luna) | 57 × ~$0.02 ≈ $1.1 | 513 |
| Arm W gemini (flash-lite) | 57 × ~$0.004 ≈ $0.25 | 513 |
| Arm W kimi (k2.6) | 57 × ~$0.012 ≈ $0.7 | 513 |
| Arm W claude (haiku-4.5) | 57 × ~$0.02 ≈ $1.1 | 513 |
| Arm W qwen (3.7-plus, night −60%) | 57 × ~$0.005 ≈ $0.3 | 513 |
| Judge total | 3,591 calls ≈ $15–40 | — |

**Total ≤ $60.** Gate discipline caps the realized spend (extensions only after
pilot gates pass). Author approval required before execution.

## 11. Registration and disclosure obligations

- Register THIS protocol on OSF before the first new call; cite it as Study 2b's
  pre-registration alongside OSF mjb8x (Study 1) and Protocol 09 (Study 2).
- Paper must disclose: (a) the family-selection deferral (budget staging);
  (b) the refiner-identity difference between Study 2 and arm W; (c) the
  API-enforced temperature asymmetries; (d) the abductive sequence (Study-2
  results motivated the two new arms — hypotheses nonetheless locked pre-data).
- Decision trail: D39 (amendment discipline) → D41 (extension) → D42
  (within-family refiners) → D43 (factorial completion).
