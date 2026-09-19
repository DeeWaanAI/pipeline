# Research Paper Plan — "The Economics of Orchestration"

**Working title:**
> *The Economics of Orchestration: Can Culturally-Composed Teams of Small Language Models Outperform Frontier Models at Equal Cost? A Cost-Matched Experiment on Business Solution Generation*

**Author:** Youssef Hariri — Doctoral student, Business of AI, Rennes School of Business
**Apparatus:** DeeWaanAI multi-agent pipeline platform (via connected MCP)
**Status:** Planning — v1

---

## 1. Research Question (single, anchored)

> **RQ: Does orchestrating small, cheap LLMs with cultural personas into a sequential
> agent pipeline deliver higher novelty and quality per dollar than (a) a single
> frontier model and (b) a single small model with a persona, on open-ended business
> problems — at matched cost?**

Unit of analysis: the **pipeline run** (team), not the single call.
Primary DV: **Novelty** (the only judge-reliable dimension per Hariri 2026, Fleiss' κ = 0.68).
Economic DV: **Team-level Efficiency Gain Ratio (T-EGR)** — extension of the EGR metric from *Doing More with Less*.

Continuity with prior work:
- *Doing More with Less* (Zenodo 10.5281/zenodo.19533619): single agent + persona economics → we move to **teams**.
- *LLM Team Composition Paradox* (10.5281/zenodo.17490945): team contingency on ARC-AGI (verifiable) → we move to **open-ended business tasks**.
- *LLM-Creativity* (10.5281/zenodo.17407392): creativity constructs (novelty/originality/feasibility) + judge methodology → reused as instruments.

---

## 2. Literature Review — map, key papers, and the gap

### 2.1 Streams to cover (with anchor citations found in the review)

**Stream A — Multi-agent collaboration improves LLM output**
- Wang et al. 2024/2025, *Mixture-of-Agents Enhances Large Language Model Capabilities* (ICLR 2025, arXiv:2406.04692, 541+ cites): layered teams of **open-source-only** models beat GPT-4o on AlpacaEval 2.0 (65.1% vs 57.5%). Closest ancestor of our claim — but no persona manipulation, no cost-matching, aggregator layers only.
- Du et al., *Multi-agent debate* line + *Literature Review of Multi-Agent Debate for Problem-Solving* (arXiv:2506.00066): debate improves factuality/reasoning; M3MAD-Bench questions cross-domain effectiveness.
- Li et al., *More Agents Is All You Need* (arXiv:2402.05120): sampling-and-voting scale gains — gains exist but with diminishing returns.
- ChatDev / MetaGPT: role-based **sequential** pipelines (our topology) for software tasks.

**Stream B — The skeptical turn (our tension)**
- Cemri et al. 2025, *Why Do Multi-Agent LLM Systems Fail?* (arXiv:2503.13657, NeurIPS 2025, MAST taxonomy, 14 failure modes): MAS often underdeliver; failures from coordination, not model capacity.
- Stanford 2026, *Single-Agent LLMs Outperform Multi-Agent Systems on Multi-Hop Reasoning Under Equal Thinking Token Budgets* (arXiv:2604.02460): **under matched token budgets**, solo ≥ team — but only tested on *verifiable reasoning*, homogeneous agents, no personas.
- *Revisiting Multi-Agent Debate as Test-Time Scaling* (OpenReview): reframes MAS gains as compute scaling — implies cost-matching is the correct comparison discipline.

**Stream C — Cost-aware LLM deployment**
- Chen et al. 2023, *FrugalGPT* (arXiv:2305.05176, 959+ cites): cascades match GPT-4 at up to 98% cost reduction — routing, not collaboration.
- RouteLLM & cascade/routing literature; Bayesian cost-aware orchestration (VoltAgent list).
- Gap: cost literature optimizes *selection between* models; collaboration literature ignores *cost*. Almost no work does **cost-matched collaboration**.

**Stream D — Personas & diversity in (multi-)agent systems**
- Solo Performance Prompting (arXiv:2307.05300): one LLM simulating multiple personas — "cognitive synergy" without true multi-agent cost.
- Straub 2025, *Persona-based Multi-Agent Collaboration for Brainstorming* (arXiv:2512.04488); *Creativity in LLM-based Multi-Agent Systems: A Survey* (EMNLP 2025): persona diversity affects idea diversity; creativity MAS is an active but young field.
- Hariri 2025/2026 (own prior work): persona×model×task contingency; EGR metric.

**Stream E — Iterative refinement & its limits**
- Madaan et al. 2023, *Self-Refine* (arXiv:2303.17651, 5116 cites): iterative feedback improves quality.
- *Self-Correction as Feedback Control* (arXiv:2604.22273): repeated refinement can degrade output — mirrors our "Generative Exhaustion" (Hariri 2025).

**Stream F — Measurement (methods defense)**
- LLM-as-judge reliability: *Judge's Verdict* (arXiv:2510.09738, 54 judges vs human); Badshah 2025 (Fleiss' κ for judge-human agreement). Justifies multi-judge ensemble + human blind panel + κ reporting.

### 2.2 The gap (one paragraph for the paper)

> Collaboration research (MoA, debate) shows teams can beat frontier models but never
> holds cost constant; cost research (FrugalGPT, routing) holds quality constant but
> never composes models into collaborating teams; the skeptical stream (MAST, equal-
> budget solo-vs-team) applies cost discipline but only to verifiable reasoning with
> homogeneous, persona-free agents. **No study has tested whether persona-diverse
> teams of cheap models beat cost-matched frontier solo baselines on open-ended
> business tasks, where diversity is theorized to matter most.** This paper fills that
> gap and extends the persona-contingency model (Hariri 2026) from the agent to the
> team level.

### 2.3 Lit-review execution checklist
- [ ] Pull PDFs of the ~15 anchor papers above (all on arXiv/OpenReview).
- [ ] Snowball: citations *of* MoA and *in* MAST related-work section (1 pass).
- [ ] Search Scopus/WoS for "multi-agent LLM" + "cost" 2024–2026 (business/IS journals) to anchor management relevance: aim for 45–60 references total.
- [ ] Build a 2×2 positioning figure: axes = *cost-controlled? (y/n)* × *open-ended tasks? (y/n)* — our study sits alone in the cost-controlled/open-ended quadrant.

---

## 3. Theory & Hypotheses

Framing: **contingency theory + information-processing view of teams**, transposed to
synthetic teams; cost as a first-class variable (Business-of-AI positioning).

- **H1 (Orchestration value):** At matched total cost, a persona-diverse pipeline of
  small models achieves higher Novelty than a single frontier model.
  *(MoA supports; Stanford 2026 opposes — genuine equipoise, publishable either way.)*
- **H2 (Composition contingency):** The team advantage is larger on divergent-leaning
  business domains (product innovation, marketing, strategy) than convergent-leaning
  ones (operations, finance, HR/organization).
  *(Extends the Team Composition Paradox from ARC-AGI to business tasks; now
  CONFIRMATORY thanks to the domain-stratified 30-problem set.)*
- **H3 (Persona compounding):** Persona-diverse teams outperform persona-free teams
  of identical models/topology (personas add value *beyond* orchestration itself).
- **H4 (Diminishing refinement):** Marginal Novelty gain per pipeline step declines
  with depth; there exists a cost-optimal depth (T-EGR peak at 3–4 steps).
  *(Self-Refine vs. feedback-control degradation; Generative Exhaustion.)*
- **H5 (Persona-role congruence):** Theory-congruent persona→role assignment
  outperforms shuffled assignment at identical composition and topology.
- **H6 (Persona-scale substitution):** The Novelty gain from personas is **larger for
  cheap models than for frontier models** (Tier × Persona interaction) — personas
  partially substitute for model scale. *(Team-level extension of Doing More with Less;
  requires persona and no-persona cells at BOTH tiers — hence the frontier-team arms.)*
- **Exploratory (no H):** Adaptive per-problem design (A7) vs best fixed arm —
  prescriptive Strategic Selector validation.

---

## 4. Experimental Design

### 4.1 Conditions: 2×2×2 within-family factorial + special arms

**Factorial core.** Three factors — **Tier** (Frontier vs its Cheap sibling) × **Structure**
(Solo vs 3-step Team) × **Persona** (None vs Persona-loaded) — crossed within each of the
**5 model families** (GPT, Claude, Gemini = Western; Kimi, Qwen = Eastern). Teams are
**model-homogeneous**: all 3 agents in a run use the SAME model; only persona/role prompts
differ. Family is thus a controlled blocking factor, not a confound — every frontier has a
cheap sibling from its own family, giving **matched pairs** ("orchestrate the mini vs buy
the flagship" per family). Solo persona cells use the best single persona (Culture_5, per
Paper 2); team persona cells use the diverse congruent trio.

| Cell | Tier | Structure | Persona | Maps to old arm | Families × reps | Runs |
|---|---|---|---|---|---|---|
| C-S-N | Cheap | Solo | none | *(new true baseline)* | 5 × 3 | 450 |
| C-S-P | Cheap | Solo | Culture_5 | A2 | 5 × 3 | 450 |
| C-T-N | Cheap | Team | none | A3 | 5 × 3 | 450 |
| **C-T-P** | Cheap | Team | diverse trio | **A4 — core treatment** | 5 × 3 | 450 |
| F-S-N | Frontier | Solo | none | A1 | 5 × 2 | 300 |
| F-S-P | Frontier | Solo | Culture_5 | *(new)* | 5 × 2 | 300 |
| F-T-N | Frontier | Team | none | *(new — frontier orchestration benchmark)* | **2** × 2 | 120 |
| F-T-P | Frontier | Team | diverse trio | *(new — persona value at frontier)* | **2** × 2 | 120 |

(Runs = families × reps × **30 main problems**, see §4.3.) **Consistency slice:** the single
pre-registered special-arm cheap family runs **5 reps** (instead of 3) in its four cheap
cells (+240 runs) — gives the Consistency DV a reliable within-cell SD (SD sampling error
≈52% at n=3 vs ≈38% at n=5); mean-effect inference keeps 3 reps everywhere
(Westfall–Kenny–Judd: generalization power comes from stimuli, not reps).

Frontier-team cells restricted to **2 families** for cost control (pre-registered rule:
strongest Western frontier by A1/F-S-N Novelty + Kimi V3 as the Eastern representative).

**What each contrast buys:**
- Persona value at 4 configurations: C-S-P−C-S-N, C-T-P−C-T-N, F-S-P−F-S-N, F-T-P−F-T-N → **H6** (Tier×Persona)
- Orchestration value at both tiers: C-T-N−C-S-N, F-T-N−F-S-N
- Within-family matched pairs: C-T-P(family f) vs F-S-N(family f) — the practitioner question

**Special arms** (run on ONE pre-registered cheap family, frozen at Phase 0 pilot):

| Arm | Description | Steps | Purpose |
|---|---|---|---|
| **A5** | C-T-P + WHILE loop (Critic verdict gate, max 2 iterations) | 3–5 | Depth/H4 |
| **A6** | Frontier solo, **cost-matched compute**: same $ budget as C-T-P (pooled median) spent on the **best A1 frontier** (pre-registered rule) via longer/self-refine prompt | 1–2 | The killer cost-matched comparison (H1) |
| **A7** | **Adaptive**: pipeline auto-designed per problem by **Kimi V3** (temp 0, pre-registered design prompt with contingency rules from Papers 2+4, via `designPipeline`); **cheap models execute** | var | Prescriptive Strategic Selector test (exploratory) |
| **A8** | C-T-P with **shuffled persona→role mapping** (15 problems, 3 reps) | 3 | Persona-role congruence control (H5) |

Design principles decided:
- **Fixed pipelines for all confirmatory cells** (factorial + A5, A6, A8): pipeline identical across problems so effects are attributable. Per-problem auto-design only as the A7 *policy* arm — the adaptive policy itself is the treatment.
- **Model-homogeneous teams**: family is manipulated between runs, never mixed within a team — removes the model-mixing confound of an arbitrary cheap-model blend.
- **Smart designer, cheap executors** (A7): the smartest available model designs the pipeline; cheap models run it. Mirrors the real DeeWaanAI product pattern (design once, execute cheaply) and confines frontier spend.
- **Single designer model** for A7, pinned version, temp 0 (ensemble designing = future work; irreproducible and unattributable). **Every generated pipeline is archived** as the record of truth (frontier temp-0 is not perfectly deterministic); designer tokens are counted in cost accounting, amortized across the 5 repetitions.

Personas: reuse verbatim `3_cultural_personas_data.jsonl` from the persona-model-fit repo
(Culture_5 innovator, Culture_Expert implementer, Culture_11 cultural specialist) —
validated instruments, construct continuity.

**Persona→role congruent mapping (pre-registered, theory-driven):**

| Role | Persona | Rationale from prior findings |
|---|---|---|
| Builder (divergent) | Culture_5 innovator | largest novelty effect (d = 0.908) |
| Critic (convergent) | Culture_Expert implementer | systematic analysis / practicality |
| Refiner (integrative) | Culture_11 cultural specialist | harmony/sensitivity fits refinement of cross-cultural solutions; tests role-fit rescue of a persona that harms novelty as a generator |

H5 (congruence): A4 (congruent) > A8 (shuffled) on Novelty — introduces the **persona-role fit** construct.

Role prompts: DeeWaanAI's Builder/Critic/Refiner templates with persona text prepended.
Critic keeps the PASS / NEEDS_WORK / MAJOR_REVISIONS verdict (mechanism variable for H4;
"Generative Exhaustion" operationalized as verdict-trajectory + novelty decay per iteration).

### 4.2 Model selection (cost-managed — hard requirement)

**Family sibling pairs** (the tier factor is manipulated WITHIN family — every frontier
has a cheap sibling from its own family; exact versions pinned at Phase 0):

| Family | Origin | Frontier (F) | Cheap sibling (C) |
|---|---|---|---|
| GPT (OpenAI) | Western | latest GPT flagship | GPT-mini tier |
| Claude (Anthropic) | Western | latest Claude flagship | Haiku tier |
| Gemini (Google) | Western | latest Gemini Pro flagship | Flash tier |
| Kimi (Moonshot) | Eastern | **Kimi V3** | small kimi tier |
| Qwen (Aliyun) | Eastern | Qwen 3.7 / qwen-max class | qwen-turbo/plus tier |

(DeepSeek is dropped from generation — no frontier/cheap sibling pair needed; it remains
available as a fallback family if any of the 5 above is inaccessible.)

Frontier notes:
- Frontier cells run last, 2 reps each to contain cost.
- Pooled as the "frontier class" for confirmatory contrasts; per-family results descriptive; **exploratory frontier-origin (East vs West) analysis** — extends the Paper 2 regional-moderation question to frontier level.
- Caveat (from Paper 2): Gemini/thinking models — reasoning traces stripped before judging for comparability.
- **A6 baseline selected by pre-registered rule:** the F-S-N frontier with highest mean Novelty.

**Designer tier (smart, Eastern — A7 only):**
- **Kimi V3** (Moonshot, pin exact version at Phase 0). Designs pipelines only; one design call per problem (15 calls total, amortized over 5 reps).

Judges (evaluation): **3 cheap judges from families NOT used in generation**.
Generator families now = {OpenAI, Anthropic, Google, Moonshot, Alibaba} → judge
families = **Mistral Small, GLM (Zhipu), Llama-3.3-70B (Together/Meta)** (Gemini moved to the
generator pool, so it is no longer judge-eligible) — eliminates self-preference bias — with the 3
judge prompt variations from persona-model-fit → 9 scores per solution, Fleiss' κ computed.
Judge design decisions (fixed): **one invariant judge ensemble for all problems/arms**
(never per-problem judges — measurement invariance); judges blind to condition; solutions
scored in randomized order with arm-identifying artifacts stripped.
Frontier judge NOT needed (Badshah 2025 + own κ=0.68 result justify cheap ensemble).

### 4.3 Problem set

- **30 main problems, domain-stratified: 6 business domains × 5 problems** (pre-registered `domain_map.json`). Rationale: stimulus-sampling power (Westfall, Kenny & Judd 2014) — generalizing across "business problems" needs ≥30 problem-level clusters, and 5 per domain makes H2 domain moderation confirmatory. Domains: strategy/market-entry, marketing/communications, operations/supply-chain, HR/organization, finance/business-models, product/innovation.
  - The **15 original problems** from LLM-Creativity `business_problems_data.json` (Business_Problem_1–15) — validated instruments; culture-agnostic general business problems (the personas are the treatment, not the problems). *(The 100-problem set from persona-model-fit is EXCLUDED: derived from DeepSeek training-adjacent material → contamination risk.)*
  - **+15 new domain-stratified problems** (Business_Problem_16–30, `business_problems_domain_15.json`, author-drafted 2026-07-30) balancing the grid to exactly 5 per domain. Domain tags for the original 15 PENDING author confirmation before the preregistration freeze.
- **+10 fresh post-cutoff business cases** (2026 scenarios) — contamination control; out-of-sample robustness/replication set, NOT part of the domain grid.
- **Special arms A5–A8 run on the original 15 problems only** — mechanism arms (depth, cost-matching, congruence, adaptivity) need validated instruments, not domain breadth.
- Pilot subset: **4 problems** for the pilot run.

### 4.4 Run matrix & budget

- **Stimulus & replication engine**: 30 problems × 5 families × 3 reps = **450 obs/cheap cell** (90/family); frontier solo = 30 × 5 × 2 = 300; frontier team = 30 × 2 × 2 = 120. Reps stay at 3 everywhere for mean effects; the **consistency slice** adds 2 reps × 4 cheap cells × 30 problems on the special-arm family (+240 runs). Special arms on that family, original 15 problems: A5/A6/A7 = 5 reps (75 obs each), A8 = 3 reps (45).
- Main run: factorial 2,640 + special arms 270 + consistency slice 240 = **3,150 runs**, ~6,400 LLM calls (~1,470 frontier calls, the rest cheap).
- Fresh-10 robustness: 10 × 3 key cells (best F-S-N frontier, C-T-P, A6) × 3 reps = 90 runs.
- Evaluation: ~3,240 solutions × 9 judge calls ≈ **29,200 judge calls** (short outputs, cheapest-tier judges).

**Budget estimate (conservative):**

| Item | Est. tokens | Est. cost |
|---|---|---|
| Cheap-sibling generation (~4,740 calls × ~4K tok; incl. slice + special arms) | ~19M | **$8–17** |
| Frontier solo F-S-N + F-S-P (600 calls × ~2.5K tok) | ~1.5M | **$6–16** |
| Frontier team F-T-N + F-T-P (720 calls × ~3K tok, 2 families) | ~2.2M | **$10–24** |
| Frontier cost-matched A6 (75 calls × ~4K tok) | ~0.3M | **$2–5** |
| A7 designer — Kimi V3 (15 calls × ~4K tok) | ~0.06M | **<$0.5** |
| Judge ensemble (~29,200 calls × ~3K tok) | ~88M | **$16–30** |
| Fresh-10 robustness (90 runs + judging) | ~1M | **$2–3** |
| Pilot + fixes (~15% overhead) | — | ~$7 |
| **Total** | | **≈ $50–100** |

Cost levers if over budget (pre-registered order): (1) drop F-S-P to 3 families; (2) judge
exploratory cells with 3 scores (3 judges × 1 variant) instead of 9, keeping 9 for all
confirmatory contrast cells; (3) shrink the domain grid 6×5 → 6×4 (24 problems, −20%);
(4) cut cheap reps 3→2 (last resort — keeps 300 obs/cell).

Cost controls: maxTokens=2048 on all generation steps; judges maxTokens=512; frontier calls batched last (run only after pipeline validated on cheap models); all per-call tokens logged by DeeWaanAI (`agentRuns.tokensUsed`) → **actual cost computed from logs, not estimates** (this becomes Table 2 of the paper).

### 4.5 Cost-matching protocol (A6, methodological heart)

1. Run C-T-P (persona team, all 5 cheap families) first; compute pooled median total tokens × provider price = **team cost C**.
2. Give the frontier model a budget of C: single call with self-refine instruction and
   maxTokens set so frontier price × tokens ≈ C.
3. Report both **cost-matched** (A6 vs C-T-P) and **unconstrained** (F-S-N pool vs C-T-P) comparisons.

### 4.6 Measures

| Measure | Source |
|---|---|
| Novelty (primary), Feasibility, Overall quality (1–10) | 3 judges × 3 prompt variants, mean; κ reported |
| Human validation | Blind human panel on stratified 10% sample (n=60), 2 raters; DeeWaanAI blind-review infrastructure; human-AI correlation reported |
| Cost | actual $ from token logs × provider price sheet |
| **T-EGR** | (Novelty_cell / Novelty_F-S-N) ÷ (Cost_cell / Cost_F-S-N) — team-level EGR |
| Latency | swarmRuns.totalLatencyMs |
| **Consistency** (secondary DV) | within-cell SD of Novelty across repetitions — do personas/teams change output *reliability*, not just mean quality? Confirmatory only in the 5-rep slice family; 3-rep SDs descriptive |
| Mechanism (H4) | Critic verdict per iteration; per-step novelty delta |

### 4.7 Analysis plan

- Factorial core (H3/H6): mixed-effects model — Novelty ~ Tier × Structure × Persona + (1|problem) + (1|family) + (1|problem:family); H3 = Persona simple effect within Cheap×Team (C-T-P vs C-T-N); **H6 = Tier × Persona interaction**; Cohen's d + 95% bootstrap CIs (5,000 resamples), FDR correction — **same stats stack as Doing More with Less** (reuse `stats_with_anlysis.py`).
- H1/H5: planned contrasts — C-T-P vs A6 (H1, cost-matched), C-T-P vs A8 (H5, same family).
- H2 (**confirmatory**, enabled by domain stratification): Structure × Domain interaction in the mixed model (6 domains × 5 problems); planned contrast = pre-registered divergent-leaning (product/innovation, marketing, strategy) vs convergent-leaning (operations, finance, HR) domain grouping, validated by 2 independent coders (κ reported).
- H4: per-step novelty trajectory (A5); segmented regression on depth; T-EGR by depth.
- A7 exploratory: adaptive vs best fixed cell, descriptive + CI (no confirmatory claim).
- Frontier-origin exploratory: F-S-N Novelty by origin (Western vs Eastern frontier), and C-T-P-vs-frontier gap by family/origin — descriptive + CI (2 reps/model → exploratory only). Frontier-team cells (2 families) reported with the same caution.
- Robustness (adapted from `stats_with_anlysis.py`, Paper 2 repo): Isolation Forest outlier check (contamination=0.1, seed 42); 80/20 split-half by problem (seed 42); leave-one-judge-out; leave-one-family-out; mean-vs-median sensitivity (Paper 2 achieved r=0.997); fresh-10 subset; repetition variance decomposition.
- Full inherited stats stack (continuity with Papers 1–2): bootstrap d CIs (5,000 percentile resamples, seed 42); Welch's t (standardized — Paper 2 mixed Student's/Welch's); FDR-BH α=.05; two-way Type II ANOVA + partial η² with Shapiro–Wilk/Levene checks; moderation OLS + Bayes factor — report BOTH Paper 2's Rouder approximation (comparability) AND exact JZS BF via `pingouin` (upgrade); post-hoc power via `TTestIndPower`; EGR/T-EGR economics + cost–novelty frontier + auto-generated business-recommendations table.
- **Pseudo-replication fix (methodological contribution):** Paper 2 treated each judge×variant row as an independent observation (n≈25,300 — inflates significance). Here: effect sizes on **solution-level ensemble scores** (mean of 9, comparable with Papers 1–2) + primary inference from **mixed models with solution and judge random effects**. Stated explicitly in the paper.
- **Oracle-portfolio analysis** (from Paper 4's +42.9% union result): per-problem best-cell "oracle router" = attainable upper bound; the A7-vs-oracle gap quantifies how much of the routing value an adaptive designer actually captures.
- IRR: report BOTH Fleiss' κ (Paper 2 protocol) and ICC(2,k) (Paper 1 protocol) per dimension, computed on ALL solutions (every solution has all 9 ratings), not a 35-item subset.
- Power: cheap cells 450 obs (30 problems × 5 families × 3 reps) → >90% power for d ≈ 0.30 on factorial contrasts; special-arm contrasts (75 obs) → ~80% power for d ≈ 0.45 (α=.05, two-tailed) — adequate given prior effects (d = 0.5–0.9). H6 interaction powered by the full 2,640-run factorial. Rigor package: pre-registration commit (OSF/GitHub tag) BEFORE main run; frozen prompts/configs; blinded judging; all raw logs published.

### 4.8 Stochasticity & judging protocol (decided)

LLM stochasticity (same input → different outputs at temp > 0) is **sampled, not
suppressed** — Paper 4 suppressed it (temp 0, single run per cell) and lists that as a
limitation; Papers 1–2 sampled it. We follow Papers 1–2:

1. **Repetitions ARE the stochasticity sample**: temp 0.7, reps per cell as in §4.4
   (Paper 1 precedent: 5 iterations per cell at temp 1).
2. **Every repetition is judged independently — never merge/ensemble responses before
   judging.** Protocol identical to Paper 1 (*"Each of the 6,375 generated business
   solutions was assessed by all five LLMs"*). The ensemble exists only at the SCORE
   level: mean of the 9 judge scores per solution.
3. Two pre-registered analysis units: (a) solution-level ensemble score — effect sizes
   comparable to Papers 1–2; (b) judge-level mixed model (random: solution, judge,
   problem, family) — primary inference, fixes Paper 2's pseudo-replication.
4. **Consistency as secondary DV** (new): within-cell SD across reps — stochasticity
   itself becomes a measured business outcome (reliability of output quality).
   Confirmatory test restricted to the 5-rep consistency-slice family (§4.1).
5. Judge temp = 0 (Papers 1–2: 0 / 0.2). Judge blinding instruction reused verbatim from
   Paper 1: *"Evaluate the Proposed Solution based only on its content… Do not make
   assumptions about or try to guess how the solution was generated."*
6. **Never redesign judge prompts**: Paper 1 documents two prompt-"optimization" attempts
   that collapsed κ to ≈0 — the 3 proven variants are reused verbatim (already committed).

### 4.9 Execution resilience (credit outages, connection drops)

Precedent: Paper 4's runner (`main.py`) had problem-level resume (skip completed IDs from
`consolidated_results.csv`) but NO retry logic — API errors returned error strings that
scored 0 and silently burned budget. This design upgrades it:

- **Planned-run ledger** `runs/ledger.csv`: the complete randomized run list is generated
  and committed at pre-registration (seed 42), with **arms/cells interleaved** — protects
  against provider drift/time-of-day confounds and makes any interruption unbiased.
  One row per planned run: run_key (cell×family×problem×rep), status
  (PENDING / RUNNING / DONE / FAILED_RETRYABLE / FAILED_PERMANENT), attempts, swarmRunId,
  tokens, cost, timestamps.
- **Idempotent resume**: executor scans the ledger, skips DONE, re-queues
  FAILED_RETRYABLE; response file + ledger row written together after each run. Credit
  runs out or connection drops → runs simply stay PENDING and the experiment **continues
  where it left off when service returns** — no loss, no double-spend.
- **Retry policy**: 3 attempts, exponential backoff (5s / 30s / 120s); rate-limit hygiene
  (≤4 concurrent runs, pause between batches — Paper 4 precedent).
- **Error outputs never enter analysis** (parsed_ok gate on judging; failed generations
  are re-run, not scored — fixing Paper 4's silent budget burn).
- Pinned model version strings + per-run date stamps in the ledger → if a pause spans
  days, model-version drift is detectable and reportable.

---

## 5. Paper Structure (target: ~9,000–11,000 words)

1. **Introduction** — the orchestration-economics question; DeeWaanAI as instrumented apparatus; contributions: (i) first cost-matched persona-team experiment on open-ended business tasks, (ii) T-EGR metric, (iii) contingency model extension, (iv) practitioner decision rules.
2. **Literature Review** — Streams A–F + 2×2 positioning figure (§2 above).
3. **Theory & Hypotheses** — contingency + information-processing view; H1–H4.
4. **Method** — platform description (reproducibility as a feature: every run's prompts/tokens/latency persisted); design table; cost-matching protocol; measures; judges + human validation.
5. **Results** — descriptives; H tests; T-EGR frontier plot (cost on x, novelty on y, arms as points — the paper's signature figure).
6. **Discussion** — theory: when orchestration pays; practice: decision rules (extend the EGR deploy/reject table); **DeeWaanAI business implications** (evidence-based value proposition).
7. **Limitations & future work** — RQ1/RQ3/RQ4 as future program; judge validity; model churn.
8. Data availability: Zenodo + GitHub (new repo `orchestration-economics`), consistent with your open-science track record.

**Target outlets (Business of AI fit):** Decision Support Systems; Journal of Business Research; Electronic Markets; International Journal of Information Management; (conference fallback: HICSS/ECIS AI track).

---

## 6. Execution Plan via DeeWaanAI MCP

Verified available MCP tools: `addProvider`, `suggestLlmProviders`, `createPipeline`,
`updatePipeline`, `getPipeline`, `listPipelines`, `runPipeline`, `runStatus`,
`approveStep`, `projectContext`, `exportPipeline`, `exportMyData`, `getSettings`.

### Phase 0 — Setup (½ day)
1. `addProvider` × 4: DeepSeek, Aliyun Qwen, Moonshot Kimi, + one frontier (single key).
2. Create a dedicated project ("orchestration-economics-study").
3. `createPipeline` × 6 (one per arm A1–A6); A5 includes WHILE step (Critic gate, maxIterations 2).
4. Smoke test: `runPipeline` each arm on 1 problem; verify `runStatus` returns tokens/latency.

### Phase 1 — Pilot (1–2 days, ≤ $3)
5. Run 4 pilot problems × 8 arms (~40 runs incl. reps) via `runPipeline` (batched, cheap models first).
6. Export via `exportMyData`; sanity-check token logs, judge scores, κ on pilot.
7. Freeze prompts/configs (registered on GitHub as pre-registration commit).

### Phase 2 — Main run (3–5 days)
8. Arms A2–A5 (cheap) over 100 problems → compute team cost C from logs.
9. Arms A1/A6 (frontier, cost-matched budget from step 8) — run once, last.
10. Judge ensemble runs (3 judges × 3 variants) — as a DeeWaanAI evaluation pipeline or script; store scores.
11. Fresh-20 contamination-control set, all arms.

### Phase 3 — Human validation (1 week, parallel)
12. Stratified 10% sample → blind review (DeeWaanAI blind-review flow or simple sheet); 2 raters; compute human–AI correlation + κ.

### Phase 4 — Analysis & writing (2–3 weeks)
13. Adapt `stats_with_anlysis.py`; produce Tables (descriptives, effects, T-EGR, κ) + frontier figure.
14. Write per §5; deposit data + pipeline exports (`exportPipeline` JSON = exact reproducibility artifact) on Zenodo.

### What I still need from you before Phase 0
- [ ] API keys for: DeepSeek, Aliyun/Qwen, Moonshot, + chosen Western frontier provider (added via MCP `addProvider`, stored AES-encrypted).
- [ ] Decision: which ONE Western frontier model for A1/A6 baseline (recommend cheapest frontier-tier).
- [ ] Decision: which ONE smart Eastern **designer** model for A7 (Kimi K2 vs Qwen-max) — pin exact version.
- [ ] The 10 fresh business cases (I can draft them for your review).
- [ ] Confirm 2 human raters for the validation sample (colleagues/fellow doctoral students).

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Null/negative H1 (solo wins) | Still publishable: cost-matched boundary condition for MAS on open-ended tasks (positions against MoA, with Stanford 2026) |
| Judge unreliability on non-novelty dims | Novelty is primary DV (pre-justified by own κ=0.68 finding); others secondary |
| Model deprecation mid-study | Pin model versions in pipeline configs; complete generation phase within 2 weeks |
| Contamination critique | Fresh-20 subset robustness check |
| Cost overrun | Hard maxTokens caps; frontier arms run once, last, with budget from measured C |
| Self-developed platform bias critique | Full pipeline exports + raw logs published; platform is instrument, not treatment |

---

## 8. Traceability & data repository (everything saved to files)

All artifacts are written to a versioned repository: `research/orchestration-economics/`
(scaffold created in this workspace; push to a dedicated GitHub repo + Zenodo, consistent
with the LLM-Creativity / persona-model-fit open-science pattern). **Nothing exists only
in the DeeWaanAI database — every run is exported to files.**

```
research/orchestration-economics/
├── README.md                     # overview + exact reproduction steps
├── PROTOCOL.md                   # frozen pre-registration (hypotheses, design, analysis)
├── DATA-DICTIONARY.md            # schema of every file/column
├── MANIFEST.md                   # provenance log: run dates, model versions, git tag, actual cost
├── config/
│   └── experiment_config.json    # model tiers + pinned versions + prices, judges, designer
├── data/
│   ├── problems/business_problems_15.json   # the validated 15 (committed)
│   ├── problems/fresh_business_cases_10.json# post-cutoff control (to draft)
│   └── personas/cultural_personas.jsonl     # 3 personas (from persona-model-fit)
├── pipelines/
│   ├── fixed/                    # A1–A6, A8 exported pipeline JSON (exportPipeline)
│   └── adaptive_A7/              # per-problem designed pipelines (designer outputs, archived)
├── runs/
│   ├── responses/                # every step output: {arm}/{problem}/{rep}.json
│   └── logs/                     # per-run token/latency (runStatus + exportMyData)
├── evaluation/
│   ├── judge_prompts/            # the 3 frozen judge-prompt variants
│   ├── judge_raw/                # every judge call: prompt + parsed score
│   └── scores_aggregated.csv     # 9 scores/solution + κ
└── analysis/
    ├── stats.py                  # adapted from persona-model-fit
    └── results/                  # tables + figures (incl. T-EGR frontier plot)
```

Capture rules (enforced during execution):
- After each `runPipeline`, save the full run (all step inputs/outputs/tokens/latency/model/temp) to `runs/responses/` and `runs/logs/` via `runStatus` + `exportMyData`.
- For A7, save the designer's raw output AND the resulting pipeline JSON to `pipelines/adaptive_A7/` before execution.
- Every judge call stores prompt + raw response + parsed score in `evaluation/judge_raw/`.
- `MANIFEST.md` updated per phase with model versions, timestamps, git commit/tag, and cost-from-logs.
- Pre-registration = git tag `preregistration` on `PROTOCOL.md` before the main run.
