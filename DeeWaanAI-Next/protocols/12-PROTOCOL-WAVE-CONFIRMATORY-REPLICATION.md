# PROTOCOL 12 — Confirmatory replication wave: 30 fresh problems × 10 model families
# Pre-registered out-of-sample gate for the Study-1 exploratory battery

**Status:** PRE-REGISTRATION — must be registered on OSF BEFORE the first wave
generation call. No wave data exist at registration time.
**Date:** 2026-08-23 | **Registry entries:** D44–D50 (DESIGN-DECISIONS.md)
**Companion registrations:** OSF mjb8x (Study 1), Protocols 01/03/04 (Study 1),
09/11 (Studies 2/2b).

## 1. Motivation and locked rationale

Study 1's confirmatory record (H1–H6, OSF mjb8x) is locked. After the lock, an
author-approved EXPLORATORY battery (D44/D45) found on the frozen Study-1 data:
(a) the team effect is domain-contingent (per-domain team effects range
+0.004 marketing to −0.106 finance; ICC(3,1) heterogeneity 0.235–0.523 by
domain); (b) a capability-gap mechanism — family-level (frontier−cheap) gap
correlates with the team effect at r = −0.978 (n = 5, p = 0.004); (c) a
marketing variance advantage for teams (Brown–Forsythe p = 0.020).

Per preregistration discipline (Nosek et al. 2018, PNAS 115:2600–2605,
doi:10.1073/pnas.1708274114; Simons 2014, Perspect Psychol Sci 9:460–465,
doi:10.1177/1745691614535633), exploratory findings cannot become headline
claims without pre-registered confirmation on untouched data. This protocol
pre-registers that confirmation as a direct replication wave on (i) 30 fresh
problems with zero Study-1 generation contact, and (ii) an expanded
10-family universe, following the standard replication logic of the Open
Science Collaboration (2015, Science 349:aac4716, doi:10.1126/science.aac4716)
and Camerer et al. (2018, Nat Hum Behav 2:637–644, doi:10.1038/s41562-018-0399-z).

**Upgrade gate (binding, pre-data):** an exploratory finding upgrades to a
headline claim only if its wave test in §4 passes at the pre-registered α and
direction. Findings that fail or are untestable remain labeled exploratory.
No post-hoc relabeling in either direction; no hypothesis addition after the
first generation call (D39).

## 2. Design

| Element | Specification |
|---|---|
| Problems | 30 fresh cases (Fresh_Case_1–10 authored 2026-07-30; 11–32 minus 24/28 authored 2026-08-23), second 6×5 domain grid, `data/problems/fresh_domain_map_wave.json` |
| Families | 10 (Study-1 five: gpt, claude, gemini, kimi, qwen; new five: thinkingmachines, gpt-oss, gemma, mistral, minimax — models in §3) |
| Cells | C-S-N, C-T-N, F-S-N only (D50; persona/refinement excluded) |
| Reps | cheap cells ×3, frontier cell ×2 (identical to Study 1) |
| Runs | 10 families × (90 + 90 + 60) = 2,400 generation runs |
| Judging | frozen panel: deepseek-chat + zai-org/GLM-5.2 + meta-llama/Llama-3.3-70B-Instruct-Turbo; 3 verbatim variants; blind; rubric identical to Protocol 01 → 2,400 × 9 = 21,600 judge calls |
| Instrument | identical role prompts, solo neutral prompt, temperature, max_tokens, rendering rule (background + problem, verbatim) as Study 1 |

**Power:** 30 problems × 3 reps gives per-domain per-cell n = 15 observations
(5 problems × 3 reps), the same per-cell depth Study 1 used for pooled claims,
and ≥ 5 problems per domain — the threshold adopted for stable domain-level
mixed-model estimates given chronic underpowering of interactions (Maxwell
2004, Multivariate Behav Res 39:143–163, doi:10.1207/s15327906mbr3901_7).
The capability-gap correlation at n = 10 families detects ρ ≥ 0.80 at 80%
power (two-sided α = .05, Fisher-z); Study-1's observed r = −0.978 is
detectable at n = 7, so the wave is over-powered for the mechanism claim and
unpowered only for the pre-committed sensitivity threshold ρ = 0.70 (which
requires n = 14; noted as a limitation if the wave estimate falls in
0.70–0.80 territory).

## 3. Family and model lock (verified 2026-08-22/23)

| Family | Frontier | Cheap sibling | Multiple | Provider route |
|---|---|---|---|---|
| gpt | gpt-5.6-sol | gpt-5.6-luna | 5× | OpenAI direct (Study-1 pipelines) |
| claude | claude-opus-5 | claude-haiku-4-5-20251001 | 5× | Anthropic direct |
| gemini | gemini-3.1-pro-preview | gemini-3.1-flash-lite | 8× | Google direct |
| kimi | kimi-k3 | kimi-k2.6 | 3.75× | Moonshot DIRECT (K2.6 retired on Together 2026-08-19) |
| qwen | qwen3.7-max-2026-06-08 | qwen3.7-plus-2026-05-26 | 3× | DashScope intl |
| thinkingmachines | thinkingmachines/Inkling | thinkingmachines/Inkling-Small | 3.4× | Together |
| gpt-oss | openai/gpt-oss-120b | openai/gpt-oss-20b | 3× | Together |
| gemma | google/gemma-4-31B-it | google/gemma-3n-E4B-it | 8× | Together (official releases only) |
| mistral | mistral-medium-2604 | mistral-small-2603 | 12.5× | api.mistral.ai |
| minimax | MiniMax-M3 | MiniMax-M2.7 | 2× (list; D46) | api.minimax.io |

Judge disjointness re-verified: panel {deepseek, zhipu/GLM, meta/Llama} ∩
generator families = ∅. MiniMax reasoning settings pinned; reasoning traces
stripped before judging where applicable.

**Price vectors:** primary = `config/price_vector.json` extended with wave
families at verified prices; minimax sensitivity vector
`config/price_vector_minimax_promo.json` per D46. All costs recomputed as
tokens × vector (D23); no dollar figures stored in the ledger.

## 4. Pre-registered hypotheses and gate tests

Composite score = mean of 9 rubric composites (3 judges × 3 variants), as in
Protocol 01. Primary model family for W1–W3, W5–W6: linear mixed model with
fixed effects as specified and random intercepts for problem and
family×problem (Westfall, Kenny & Judd 2014 framework as used in Protocol 03).
All wave tests two-sided α = .05 unless stated; secondary family-level tests
Holm-corrected (Holm 1979, Scand J Stat 6:65–70, doi:10.2307/4615733).

- **W1 — team effect replication (Study-1 H-analog):** pooled
  composite(C-T-N) − composite(C-S-N) across the 10 families.
  Gate: significant AND positive (Study-1 direction).
- **W2 — upgrade threshold replication:** pooled
  composite(F-S-N) − composite(C-T-N). Gate: significant AND positive
  (Study-1 direction: frontier solo exceeds cheap team).
- **W3 — domain contingency (A5/A7 replication):** LMM
  composite ~ cell × domain + covariates of the Study-1 ANCOVA design.
  Gate 3a: significant cell×domain interaction. Gate 3b (directional
  pattern, Holm-corrected across 6 domains): at least 4 of 6 per-domain
  team effects replicate Study-1 sign AND the strongest-positive and
  strongest-negative domains match Study-1 (marketing / finance).
- **W4 — capability-gap mechanism (A-exploratory r = −0.978):** per family,
  capability gap Δ = composite(F-S-N) − composite(C-S-N); team effect
  τ = composite(C-T-N) − composite(C-S-N). Pearson r(Δ, τ) over the 10
  families, Spearman ρ as robustness. Gate: r significant AND negative;
  sensitivity: report exact power at observed n for ρ = 0.80 / 0.70.
- **W5 — variance/downside replication (A1):** per domain, Brown–Forsythe
  C-T-N vs C-S-N variance test + P(composite < 4.0) gap. Gate: the
  marketing team-variance advantage replicates directionally at p < .05
  within-domain; pooled variance result reported without gate.
- **W6 — economics replication (A4):** T-EGR (quality per dollar·minute)
  under the frozen price vector; frontier-solo vs cheap-team efficiency
  dominance replicates directionally. Gate: frontier solo retains the
  cost–latency–quality frontier position on fresh problems.
- **W7 — judge reliability (A7):** ICC(3,1) by domain on wave data;
  reported as measurement audit, no gate.

## 5. Execution discipline

1. **Registration before generation:** this protocol + stimulus files
   registered on OSF before the first wave call; timestamp recorded in the
   MANIFEST.
2. **Scheduling:** all runs inside the execution window of the frozen model
   registry (UTC 14:00–00:00 preferred; never during DeepSeek peak windows
   UTC 01–04/06–10; qwen generation only inside its off-peak window).
3. **Concurrency:** generation at the D34-calibrated level validated for each
   NEW provider by a pre-wave RPM ramp (429-rate + latency-inflation
   criterion; highest clean level adopted, cap 100). Judging fully concurrent.
4. **Credit-exhaustion policy (author directive 2026-08-23):** if a
   provider's credit runs out, that family is skipped; all other families
   continue; the interruption is logged in the MANIFEST and disclosed in the
   analysis. Wave conclusions are computed on completed families with the
   shortfall tabled.
5. **Integrity:** one file per run, atomic writes, resume by directory scan;
   full-text capture via export_run (A1.1); truncated-at-source flag logged.
6. **Analysis lock:** `code/analyze_wave.py` is written and frozen BEFORE
   wave judging completes; no post-data model re-specification except
   documented, labeled sensitivity.

## 6. Data artifacts

`runs/raw/wave/` (per-run records), `runs/logs/wave_run_ledger.json`,
`runs/logs/wave_judgments.jsonl`, `results/wave_analysis.json`,
`results/WAVE-REPLICATION-REPORT.md`, MANIFEST entries.

**OSF registration of this protocol: osf.io/jg49x** (submitted
2026-08-23T14:42:17 UTC, BEFORE the first wave generation call). Frozen
stimulus files are stored with OSF timestamps under component osf.io/ezuwt
(protocol text + fresh_business_cases_20_wave.json + fresh_domain_map_wave.json,
sha256 hashes recorded in the registration summary). Note: the OSF API does
not permit file attachments inside the registration form via API (same
limitation as registration mjb8x); timestamped component storage +
hash-in-summary is the documented equivalent.

## 7. Interpretation rules (pre-data)

- Gate passes → finding upgrades to a headline claim in the paper with the
  wave estimate + 95% CI reported alongside the Study-1 estimate.
- Gate fails → finding stays exploratory; the paper reports both estimates
  and discusses the boundary.
- Mixed family coverage due to credit exhaustion → gates evaluated on the
  completed subset (≥ 8 families required for W4; below that, W4 is deferred
  and disclosed).
- No pooling of wave and Study-1 raw data; cross-study comparison is by
  estimate juxtaposition only.
