# DeeWaanAI Offering Redesign — Technical Specification v2

**Version:** 2.0  
**Date:** 2026-09-18  
**Status:** Engineering proposal; policy and external-integration gates remain open. Not authorization to implement or deploy.  
**Scope of this revision:** Specification only. No application code, configuration, database, billing account, or deployment changes.  
**Supersedes:** Version 1.0 of this document. Where the original offering report differs from the owner's subsequent decisions, those decisions govern.

## 1. Purpose, authority, and scope

DeeWaanAI becomes a decision layer for designing, evaluating, and running LLM workflows. Design, Test, and Auto-design remain the three pillars. A user may evaluate a private pipeline without selling it, compare it with another execution model or an optional frontier-solo baseline, or publish evidence alongside a protected marketplace asset.

This specification distinguishes:

- **Confirmed decisions:** explicitly chosen by the owner; implementations must respect them.
- **Engineering requirements:** proposed safeguards and contracts needed to implement those decisions coherently.
- **Open policies:** business or external-service choices not yet approved; the affected feature must not launch with invented defaults.

No numerical quality promise, delivery date, unlimited-usage promise, or financial guarantee follows from this document. Existing data and user rights must survive migration.

### 1.1 Confirmed decisions

| ID | Decision | Consequence |
|---|---|---|
| D1 | Users may grade only their own pipeline output. Comparison against a frontier model of their choice is optional. | Evaluation does not require a marketplace listing, second model, or frontier call. |
| D2 | Marketplace trust uses disclosed inputs, outputs, judging prompts, and results, with community assessment rather than a mandatory human-review gate. | Publication checks evidence completeness and provenance, not an unsupported claim of certified quality. |
| D3 | Subscription is USD 9.99/month; marketplace commission is 30%. | No new Pro tier, savings-share charge, or unapproved entitlement promises. |
| D4 | Sellers bear the costs of proving their listing's value. | Seller listing generation, testing, and judging use explicitly authorized seller BYOK. This does not authorize other users to spend the seller's balance. |
| D5 | Show the tested model clearly; suggest new tests when relevant new models appear. | Show provider, model identifiers, test date, and revision availability. A new release is a suggestion, not automatic paid execution. |
| D6 | Users may share test data/results from other models. | Community evidence attaches to the specific listing version and is labeled by provenance and test conditions. |
| D7 | Tester rewards are deferred pending anti-gaming investigation. | No credits, cash rewards, points, badges-as-incentives, or reward eligibility logic in this release. |
| D8 | Delayed seller cash release is a protective option to investigate. | Support a configurable hold mechanism; duration, eligibility, and dispute terms remain open. No automatic immediate-payout exemption after a sales count. |
| D9 | **Owner decision 2026-09-20.** The agent workbench is MCP-first: designing, benchmarking, grading, running, and publishing happen through MCP from the user's own LLM desktop app. The browser is retained as the shop front and the record — marketplace browse/detail, the public evidence page for a listing, pricing/checkout, account credentials, spend, consent and withdrawal. No new authoring screens are built. | Supersedes W5's authoring-UI scope. Server-side authorization and leakage containment become MORE important, not less: a chat client renders whatever the server sends, and MCP read paths are audited surfaces (A12). Buyer discovery stays on the web because a prospective buyer cannot be assumed to run an MCP client, and evidence needs a canonical public URL to be verifiable by a third party. Revisit against real beta user behavior before any further UI investment. |

### 1.2 Retained direction from the original offering report

Use BYOK rather than reselling LLM tokens. Retain manual and automatic design. Make simple solo and solo-plus-refine templates easy to find; keep advanced multi-step capabilities. Preserve TeamSync behind feature controls, outside this redesign's new offering. Do not delete its data or silently revoke existing rights.

Protect purchased workflow definitions through server-side execution, subject to the provider and leakage limitations in section 8. Per-step model-search optimization remains deferred: retain existing per-step fields for compatibility, but do not introduce a new refinement-model picker or combinatorial optimizer as a requirement of this release.

### 1.3 Open policy register and safe behavior

| ID | Decision still needed | Safe behavior until resolved |
|---|---|---|
| P1 | Who pays for buyer execution, trials, and community tests? | Owner-funded private tests and seller-funded listing tests may operate. No third-party spending authorization is inferred. A launch configuration must explicitly enable each other purpose and payer; no silent seller sponsorship. |
| P2 | Are marketplace licenses one-time, recurring, or metered; what survives subscription cancellation; what updates does a purchase cover? | Retain existing contracts. Proposal: reuse the current one-time-license checkout first, with platform subscription separate. Do not add per-run seller billing without approval. |
| P3 | Payout provider/account model, hold duration, dispute window, reserve policy, refunds, and tax/processing-fee allocation? | New paid-sales cutover is blocked until settlement and refund policies can actually be honored. No fixed seven-day hold or immediate payout default. |
| P4 | Trial count, reset policy, time window, failure consumption, and access eligibility? | New trial feature remains disabled. Counters are policy-versioned; no invented three/five-run entitlement. |
| P5 | Operational limits, subscription grace behavior, and legacy-tier transition? | Retain current limits/rights; apply explicit resource admission controls. Do not market unlimited usage. |
| P6 | Initial approved provider endpoints and model-release source? | Protected marketplace execution remains limited to validated endpoints; no arbitrary endpoint fallback. New-model notifications require a trusted, reviewed catalog event. |
| P7 | Public-data consent, removal process, commercial license language, and moderation/dispute responsibilities? | Public publication and commercial cutover require explicit approved policies. Transparency does not waive privacy or abuse handling. |

These decisions need not prevent independent work on private evaluation and durable jobs. They do prevent enabling the affected paid, public, or sponsored features. Proposed policies are not owner approval.

## 2. Research alignment and claim boundaries

Reference: [P5_v15.1.tex](../research/orchestration-economics/paper/P5_v15.1.tex), Study 3 and Protocol 16, particularly lines 1638–1712 and 1722–1789 in the reviewed draft. This is a design alignment check, not a fresh audit of underlying experiment data.

Study 3 compares task-adapted model-authored workflows with the study's frozen human-designed instrument. It does not establish that every automatic design beats every human design. Functional roles such as builder, critic, and refiner are not equivalent to persona styling. Preserve supported branches and bounded feedback loops; do not post-process every multi-step design into a fixed solo-plus-refine recipe.

Protocol 16 reports partial replication: the middle-family findings did not transfer reliably to fresh problems. Therefore, recommendations must be based on the user's measured conditions, not a permanent per-family winner table. The earlier W2 gate and Protocol 16 are distinct; do not use W2 as a synonym for the auto-design replication.

Practical requirements:

1. Provide simple templates as convenience, not guaranteed optimal designs. A plain solo template must be available alongside a refinement template.
2. Keep the production auto-designer task-adaptive. Any designer-prompt change is a new version, recorded and regression-tested; the paper is not proof of the changed prompt's performance.
3. Show model choice, design choice, and judging setup separately. A cheap designer can be offered, but changing designer or executor needs explicit choice and spend approval.
4. No universal claims such as “98% quality,” “frontier-level at cheap prices,” or “pairwise is proven more robust” on arbitrary tasks. Report observed scores, costs, sample scope, and limitations.
5. Test cases, repeated generations, input paraphrases, and judging-prompt variants are different dimensions. They must not be conflated into a larger count of independent tasks.

## 3. Existing architecture and modification map

The application remains the existing Node/TypeScript monolith: React, Hono+tRPC, shared Zod contracts, Drizzle/MySQL, provider adapters, and BullMQ/Redis-backed workers. No new frontend framework, database engine, or parallel pipeline engine is proposed.

Paths below were checked against the workspace. Proposed additions are marked **new**; their names describe intended boundaries, not existing exports. Line numbers can shift; symbols and paths are the integration anchors.

| Area | Existing integration point | Required modification |
|---|---|---|
| Router composition | `api/router.ts` mounts `swarm` and `marketplace` | Add benchmark/design-job interfaces without duplicating authorization or business logic. |
| Contracts | `contracts/index.ts` | Add explicit private/public evidence DTOs, job inputs, execution purposes, normalized score schema, and structured errors. Never expose DB rows as public contracts. |
| Persistence | `db/schema.ts`, existing `migrations/` | Add immutable versions, evaluation/provenance and settlement records. Retain legacy enum values and tables during transition. Reconcile migration tooling before allocating identifiers. |
| Auto-design | `api/routers/swarm.ts` → `swarm.autoDesign`; `api/services/autoDesignService.ts` → `runAutoDesign` | Extract generation/validation from destructive persistence; execute as a durable design job; atomically apply only to the expected project revision. |
| MCP design | `api/mcp/tools/designPipeline.ts`, `api/mcp/tools/index.ts` | Replace synchronous completion with job start/status/cancel flow; version client-facing behavior and help. Sampling needs the compatibility treatment in section 5. |
| Pipeline execution | `api/routers/swarm.ts`, `api/services/swarmService.ts`, `api/workers/swarmWorker.ts` | Reuse the execution loop with an immutable snapshot and authorized execution context. Avoid rewriting mutable user projects for every benchmark candidate. |
| Batch and queue lifecycle | `api/services/batchService.ts`, `api/infra/queue.ts`, `api/workerEntry.ts`, `api/boot.ts` | Reuse fan-out/status patterns; register new workers and durable recovery. Production paid jobs must not silently fall back to process-local queues. |
| Marketplace | `api/routers/marketplace.ts`, `api/routers/certification.ts` | Add versioned evidence publication; remove human-review requirements only for the new flow. Prevent legacy certification paths from publishing v2 listings. |
| Protected reads/execution | `api/routers/template.ts`; MCP `getPipeline.ts`, `runPipeline.ts`, `listPipelines.ts`; run/history/export paths | Preserve full access for owned pipelines but prohibit materializing or revealing protected seller assets through purchased execution rights. |
| Existing prompt encryption | `api/lib/marketplaceCrypto.ts`, `api/services/cryptoService.ts`; `encryptedPrompts` | Reuse established cryptography after verifying version binding. Encryption at rest does not protect prompts sent to buyer-controlled endpoints. |
| BYOK | `api/routers/llm.ts`, `api/lib/providers` | Keep private custom-endpoint support; enforce a separate trusted-endpoint policy for protected assets. Add explicit model overrides and evidence metadata where adapters lack them. |
| Entitlements | `api/services/entitlements.ts`, `api/services/entitlementSync.ts`, `api/config/plans.ts` | Preserve `pipeline:run:<listingId>`, add version-aware grants where needed, reconcile plan/tier grants, and ensure HTTP/MCP parity. |
| Billing | `api/services/billingService.ts`, `api/routers/billing.ts`, `api/billing-webhook-route.ts` | Extend existing Stripe checkout, event handling, purchase/refund synchronization, and settlement records. Do not add a second purchase ledger path. |
| Frontend | `src/pages/PipelineEditor.tsx`, `src/components/pipeline/PipelineConfigurator.tsx`, `src/pages/MyPipelines.tsx` | Add evaluation entry and simple templates while retaining advanced design. |
| Marketplace UI | `src/pages/MarketplaceBrowse.tsx`, `MarketplaceDetail.tsx`, `CreatorDashboard.tsx`; `src/App.tsx` | Extend actual pages/routes rather than inventing replacement page names. Add a benchmark workspace page as needed. |
| Feature controls | `api/plugins/featureFlags.ts`, existing billing/team APIs | Stage v2 independently of legacy review and TeamSync. Server checks must mirror hidden UI. |

Important observed details:

- `api/services/entitlementSync.ts` already sets `PLATFORM_FEE_RATE = 0.30`; purchases store `creatorEarnings`, not a newly invented `sellerPayout` field.
- `api/config/plans.ts` has `solo` and `team_seat` plans; subscription capabilities and user-tier capabilities are separate inputs. The new subscription must grant the intended design/test/publish capabilities through a reviewed mapping, not a forced enum rename.
- Current `swarm.autoDesign` calls the shared service directly; MCP separately checks the auto-design capability. Add shared ownership/provider/capability enforcement, not another divergent check.
- Current queue code can fall back to memory. Its enqueue dedupe window is not sufficient proof of exactly-once billing, durable recovery, or no repeated provider charges.
- `template.useInProject` and MCP template application copy prompts into ordinary project steps; `get_pipeline` returns those prompts for accessible projects. These are legitimate owner features, not a route for protected purchases.
- Human-review quorum is configurable through `api/lib/env.ts`; the source default is five reviewers, not evidence of the live production override. Remove the new flow's dependency on quorum rather than assuming a fixed live value.

## 4. User journeys and execution purposes

### 4.1 Private evaluation: the default Test journey

1. Choose an owned pipeline or an existing output from an owned run. No listing creation is required.
2. Describe desired qualities or choose an editable rubric template. Templates are starting points, not validated domain expertise.
3. Choose actual task inputs. User-provided cases are preferred; optional generated cases/paraphrases are labeled and reviewable.
4. Select `grade_only` or an optional comparison mode. In `grade_only`, use the configured workflow as-is; do not add a second model or regenerate an existing output unless requested.
5. Review the selected judge(s), validators, execution purpose/payer, estimated call plan, limits, and estimate uncertainty. Approve spending.
6. Start an asynchronous job. View progress, partial completion, cancellation, costs, and final evidence privately.
7. Receive an evaluation summary. A grade-only result has no “winning model” field or implied ranking.

Externally pasted output may also be graded privately, but its origin/model/cost are user-reported and must not become platform-attested execution evidence.

### 4.2 Optional comparison modes

| Mode | What changes | Controls |
|---|---|---|
| `grade_only` | Nothing; evaluate existing or newly generated pipeline outputs. | No comparator required. |
| `compare_models` | Run one frozen workflow on explicitly selected whole-workflow executor models. | Override every model-backed step consistently, including LLM gates; keep graph, prompt content, decoding settings, input set, and declared limits fixed where supported. Unsupported settings fail clearly or produce a disclosed separate condition. |
| `compare_frontier_solo` | Add a chosen frontier model answering the same task without the tested workflow. | Show that this compares different execution strategies, not just models. Record baseline prompt/version, limits, and rubric. No automatic frontier selection. |

Existing mixed-model workflows may be evaluated as configured. Record each step's resolved model. New per-step optimization is out of scope. If a test intentionally changes structure or prompts, save another workflow version/condition rather than calling it a model-only comparison.

### 4.3 Seller publication

Start with a completed private evaluation of an owned workflow version. Create or select a draft listing, inspect its public disclosure preview, confirm rights/consent, and publish through one service operation. A seller may publish evidence without claiming superiority over another model.

Publication requires complete qualifying evidence and clear limitations, not a minimum LLM score. Structural completion does not mean “certified good.” An initial v2 listing must include at least one completed, platform-recorded pipeline execution and completed judgment/validator under a frozen plan; externally supplied outputs alone do not qualify. All attempts within the selected plan, including failed/retried ones, must be disclosed. Withheld private experiments cannot honestly be called “all tests ever run.”

A workflow edit produces a new version. The old version remains associated with its actual tests and purchases. A new version cannot inherit the old version's performance claims silently.

### 4.4 Community contribution

An entitled tester can publish a completed run's evidence, on the seller's model or another allowed model. Different cases, models, rubrics, and versions are visible rather than merged into a single purported reproduction score. Authorized trials can contribute only after P4 is resolved and enabled.

External reports may be accepted separately as user-reported evidence. A purchase or attested run gives provenance, not a guarantee that the evaluation is correct. Contradictions invite a report, seller reply, and community assessment; they do not create automatic verification, refunds, or delisting.

### 4.5 Payer authorization

Each spending operation records `actorId`, `purpose`, `payerId`, owned `providerRef`, selected model, spend-approval ID, and resource-policy version. Purposes include private design/evaluation, seller evidence, buyer execution, trial, and community evaluation.

Default invariant: an actor may use only their own enabled credentials. Seller-sponsored third-party calls require a separate future authorization policy with scope and limits; never expose the seller's provider reference or key to a buyer. Disabled purpose/payer combinations fail before enqueue. “Trial” may waive an asset fee but must not imply free LLM tokens.

## 5. Auto-design and background execution

### 5.1 Auto-design service boundary

Refactor the existing shared service into three responsibilities, keeping one designer implementation:

1. Generate a candidate using an explicitly chosen designer provider/model and recorded designer-prompt version.
2. Validate the complete graph, prompts, step types, routing targets, enabled-step limits, bounded loops, model compatibility, and approval requirements.
3. Persist a candidate version and apply it to the intended project only under an atomic revision check.

Use inserted IDs, not “latest project for user,” when binding a job. Generation retries must not create duplicate projects/templates or overwrite a project edited while the LLM was working. If the expected revision changed, retain the candidate and ask the owner to apply it; do not delete current steps.

Do not silently repair a malformed graph into a materially different workflow and call it the original design. Validation errors and any explicit repair attempt are recorded, bounded, and charged only under the approved call plan. Preserve the existing up-to-seven-step design guidance as a compatibility baseline; lower caps or prompt changes require versioning and regression evaluation. Approval steps remain supported for private workflows; automated benchmark plans must explicitly support and log human intervention or reject those steps before spending. Never silently auto-approve them to manufacture unattended evidence.

### 5.2 Design API and MCP compatibility

Introduce `designJobs.start/get/cancel/apply` backed by shared services. Start returns a job ID promptly; status returns progress or the candidate/version ID, not a live client callback. Existing `swarm.autoDesign` clients need a compatibility/version rollout; do not change the return shape without updating all consumers.

MCP `design_pipeline` must use the durable job start path and return polling instructions. Add status/cancel tools through `api/mcp/tools/index.ts` and update help and tests. Enforce identical entitlements and provider ownership in HTTP and MCP paths.

Current MCP sampling depends on a live desktop session and cannot simply be serialized into a worker. For the v2 durable path require an owned configured provider. A legacy sampling path may remain feature-flagged during transition, labeled non-durable; never enqueue a callback, assume the desktop remains connected, or silently switch to paid BYOK. Broader durable sampling support is deferred.

### 5.3 Durable job contract

New design and benchmark controllers use the existing queue abstraction and swarm worker. The DB is authoritative for intent, job state, call attempts, immutable parameters, and results; queue messages contain identifiers, not plaintext keys or pipeline prompts.

- Persist a job and outbox event transactionally; an outbox dispatcher enqueues with a stable idempotency key. Reconcile unenqueued records after crashes.
- Production protected/paid evaluation jobs require healthy durable queuing. If Redis is unavailable, do not accept a job into the memory fallback and describe it as durable. Development fallback may remain explicit.
- Use a DB lease/generation token for active attempts so duplicate workers cannot finalize the same logical result. Queue deduplication alone is insufficient.
- Job start, cancel, resume, and publish have actor-scoped idempotency keys. A retry returns the existing logical resource where appropriate.
- A benchmark coordinator fans out child executions; child retries preserve attempt history. Reuse `batchService` patterns without allowing generic batch export to bypass protected-result redaction.
- Persist provider request IDs, start/finish times, errors, token usage, and whether the outcome is known. Exactly-once external LLM execution is not promised: a crash after provider acceptance can leave uncertain cost/output. Mark the attempt uncertain and require policy-controlled retry rather than hiding possible duplicate spend.
- Cancellation stops new work, best-effort aborts in-flight calls, and retains charges already incurred. Resume executes only missing/authorized retry work within renewed approval when needed.
- Bound concurrency, step visits, loop iterations, retries, runtime, output bytes, and tokens. Recheck credential availability and execution entitlement at worker start and before new calls where revocation is material.
- SSE/poll status are owner-authorized. Protected buyers see sanitized progress and final outputs, not seller prompts or internal step traces.

## 6. Data model and invariants

Names below are proposed Drizzle exports with snake_case SQL names, not migration code. Align ID and timestamp types with existing tables. Keep large text out of frequently updated progress rows; use `mediumtext` or private object storage with explicit size limits. Storage retrieval must authorize the reader before generating any download URL.

### 6.1 Immutable workflow and evaluation records

| Proposed entity | Required fields and relationships |
|---|---|
| `pipelineVersions` | ID, owner, source template/project reference, sequential version, canonical definition schema version and hash, private definition reference, designer method (`manual` or `auto`), designer provider/model/prompt version when available, parent version, creation time. Snapshot all prompts, graph/loop configuration, decoding and tool/runtime configuration required for execution. Never embed live credentials; external model bindings are resolved separately. |
| `designJobs` | Actor, project, expected project revision, designer binding, objective, prompt version, spend approval, job state, candidate version ID, error/attempt references, created/started/finished times. |
| `benchmarks` | Owner, nullable listing ID, pipeline version ID, execution mode, schema version, immutable plan and plan hash after start, case set/rubric/judge references, spend approval, execution state, aggregate availability, created/started/finished times. Listing ID is optional. |
| `benchmarkCases` | Benchmark ID, stable case ID/order, exact input or private artifact reference, origin (`user`, `generated`, `paraphrase`), base-case grouping, reference/expected output when provided, content hash, provenance notes. |
| `benchmarkCandidates` | Benchmark ID, candidate ID, strategy (`pipeline` or `solo_baseline`), workflow/baseline prompt reference, requested provider/model, per-step resolution policy, decoding/limits snapshot. No buyer-readable private credential references. |
| `benchmarkRuns` | Benchmark/case/candidate IDs, replication index, logical execution ID, linked swarm run or imported-output provenance, status, output reference/hash, resolved executor metadata, generation timing, usage and error summaries. |
| `benchmarkJudgments` | Run ID (or pair of run IDs), judge slot, rubric/prompt version, judge model metadata, orientation for paired comparisons, raw response reference, validated per-dimension scores or pair preference/tie, rationale, status, parse/validation failures, call-attempt references. |
| `callAttempts` | Logical operation/run/judgment/design ID, purpose, attempt index, actor/payer/provider reference (private), requested/returned model, provider request ID, status/uncertainty, token categories, price-vector version, attributed cost/cost completeness, timings, redacted error. Append-only attempts; not overwritten by successful retries. |
| `spendApprovals` | Actor/payer/purpose, frozen plan hash, exact allowed provider/model bindings, estimate snapshot and price provenance, token/call/runtime limits, optional user-approved spend ceiling, approval time/expiry, revocation state. |

Prefer one evaluation engine and schema for sellers and community users. Do not create incompatible duplicate tables storing arbitrary score JSON under a “verified” boolean.

Plan edits after execution begins create a new plan version or benchmark. Hashes demonstrate recorded content identity, not factual correctness. Private hashes of low-entropy inputs need not be published. Neither source-template deletion nor account cleanup may cascade-delete purchased/evidentiary versions without the approved retention process.

### 6.2 Publication and community records

| Proposed entity/change | Required fields and relationships |
|---|---|
| `evidencePublications` | Owner/author, benchmark ID or external-report ID, optional listing attachment, listing workflow version ID, publication kind (`seller`/`community`), provenance (`platform_recorded`/`user_reported`/`legacy_import`), immutable public manifest/reference and hash, publication schema version, consent/policy version, publication state, published/withdrawn timestamps, withdrawal reason. |
| `externalEvidenceReports` | Author, listing/version, user-declared inputs, outputs, model/date/rubric metadata, attachments with safety checks, notes and submission time. User declarations never become attested provider results. |
| `marketplaceListings` additions | `publicationMode` distinguishing legacy/v2, current sellable workflow version ID, current seller evidence-publication ID, evidence summary revision. Keep existing status enum values initially. Render model/date summaries from publications or a transactionally refreshed cache. |
| `evidenceReports` | Reporter, target publication/listing/version, reason and supporting evidence, assessment status, seller reply, actor/timestamp audit trail. No automatic economic penalty from a score difference. |

Every listing/publication/version attachment must be checked for ownership and exact version compatibility. A public endpoint returns only the manifest of a currently public, authorized publication; never a raw `benchmarks` row selected by listing ID. A community publication has public author attribution compatible with the approved privacy policy and links to the test conditions.

Store original test completion time separately from publication time. Re-publishing old evidence must not reset “tested on.” Model identifiers include requested ID, returned ID, provider/route, and nullable revision/fingerprint. If an exact revision is unavailable, say “not exposed by provider”; never infer one from a friendly model name.

### 6.3 Scoring and numeric representation

Persist per-dimension raw score, lower/upper scale bounds, weights, and rubric anchors. Reject out-of-range, missing, NaN, or malformed values rather than coercing them to zero. Weights are finite/nonnegative and sum to one after an explicit validated normalization recorded in the rubric version.

Proposed aggregate convention: normalize each valid dimension to [0,1] using its declared bounds, then compute the weighted sum. Store normalized aggregate as `DECIMAL(7,6)` and display a clearly labeled 0–100 rubric score. Raw 0–10 scores may use `DECIMAL(8,4)`; `DECIMAL(3,2)` is insufficient for 10.00. A score is not a percentage of objective quality or a probability of correctness.

Mixed/missing judgment coverage yields an incomplete summary, not an silently reweighted “complete” result. Store cost at adequate fixed precision (proposal `DECIMAL(18,8)` for estimated API cost) and currency explicitly. Money transferred uses currency minor-unit accounting and deterministic rounding; do not use floating-point arithmetic for settlement.

### 6.4 Access, trial, and financial additions

| Proposed entity/change | Required fields and invariants |
|---|---|
| `executionGrants` | Subject, listing/version scope, purchase or trial source, state, grant/expiry/revocation times, policy version. Retain `pipeline:run:<listingId>` for compatibility, but do not treat it as a grant to read or copy definitions. |
| `trialGrants` and `trialReservations` | Unique subject/listing/policy window, allowed quota, reserved/consumed counters; reservation bound to an idempotent execution ID. No paid purchase row fabricated for a trial. |
| `marketplacePurchases` extension | Keep `amountPaid`, `platformFee`, `creatorEarnings`, Stripe references, and status. Add immutable checkout/listing-version references and commission/policy snapshot. Deduplicate existing records before adding applicable unique payment/session constraints. |
| `settlementEntries` | Purchase/refund/adjustment source, seller, currency, gross amount, commission basis/rate, fees/tax allocation references, net payable, hold policy/until, dispute state, immutable ledger events. Refund allocation must reconcile to the original transaction. |
| `payoutAttempts` | Settlement allocation(s), stable idempotency key, provider transfer reference, requested amount/currency, pending/processing/succeeded/failed/unknown state, provider-confirmed timestamps and redacted failure. |
| `jobOutbox` / notification outbox | Unique event key, resource/operation ID, payload reference, delivery state, retry time/count. No plaintext secrets. Can share an established durable outbox if one is verified during implementation. |

Do not equate a local entitlement, a recorded seller earning, and an actual bank payout. These are separate states with reconciliation between them.

### 6.5 Keys, indexes, and retention

Require unique logical case/candidate/replication identities, unique call attempt indexes per operation, actor-scoped operation idempotency keys, and unique publication version IDs. Index owner/job state, benchmark/run membership, public listing/version, pending payout/hold time, and undelivered outbox work. Use transactions for multi-row invariants; MySQL nullable uniqueness is not a substitute for a defined dedupe key.

Financial/evidence records use restricted deletion or tombstones and approved retention rules, not new broad cascade deletes. Existing cascades must be assessed before account/template deletion can affect v2 records. Redaction/withdrawal creates an audit event and preserves only what the approved retention policy permits; immutability is not an excuse to retain personal data unlawfully.

## 7. Evaluation, provenance, and public disclosure

### 7.1 Rubrics and judges

The rubric editor stores dimension definitions, anchored scale, weights, and task reference material. Generated rubrics are drafts requiring confirmation. No fixed five-dimension business rubric is assumed valid for code, medicine, or every other domain.

Allow an explicitly configured judge panel; disclose judge count, models, prompts, and each result. Grade-only uses rubric scoring. Optional comparisons may use rubric scores or blinded pairwise preference with recorded/randomized orientation, ties, and an optional order-swap check. Do not compare scores from different rubrics as though they were calibrated.

Treat task inputs and candidate outputs as untrusted judge data. Delimit them, instruct judges not to follow embedded instructions, isolate judges from credentials/tools, validate structured responses, and test injection examples. These measures reduce but do not eliminate judge manipulation. No one-click preference adjustment may silently change an already published rubric or score.

Human feedback can be recorded against a specific evaluation version. If used to change a rubric or judge configuration, create and disclose a new version. Do not label two feedback clicks “high confidence” or validated domain calibration.

### 7.2 Deterministic checks and uncertainty

Use deterministic validation when applicable: schema conformance, expected-value checks, or owner-supplied tests. Record validator version, input artifacts, environment, pass/fail, timeout, and limitations. Never execute generated code in the web process or a production worker holding secrets. Code execution requires an isolated resource-limited sandbox with no default network/filesystem access; if such isolation is unavailable, that validator remains disabled.

For this release, quick-test summaries are descriptive: sample counts by independent cases, repeat count, score spread, agreement/disagreement, failures, and observed cost. Do not emit inferential confidence intervals, significance, or “equivalent quality” badges by default. A future inferential mode must define sampling unit, assumptions, dependencies, comparison correction, and analysis version before use. A few paraphrases do not establish broad generalization.

A comparison verdict states “highest observed score among these tested conditions,” or reports a tie/insufficient evidence. Optional cost-aware selection requires a user-defined score threshold or explicit preference; there is no universal cost-optimal winner. Generate core numerical explanations deterministically; optional LLM narrative is separately costed and must not invent evidence.

### 7.3 Public disclosure manifest

All seller and platform-recorded community publications must include:

- Workflow/listing version identity, public execution strategy summary, and evidence scope; no private workflow definition.
- Exact approved test inputs, final outputs, reference material used for judging where publishable, and disclosure of generated/paraphrased cases.
- Exact judging prompts/templates and resolved judging inputs, rubric/anchors/weights, judge identifiers/settings, all individual judgments, parse failures, validator outcomes, and documented aggregation rules.
- Requested and returned executor model identifiers, provider/route identity, exact revision when exposed, step-model map where relevant, test timestamps, and known reproducibility limitations.
- Run/case/candidate/repeat counts; every selected-plan attempt and failure with sanitized reason; cancellations, missing judgments, and retries. Distinguish planned from completed work.
- Generation cost per completed run and benchmark-total cost separately; design/preparation/judging/retries broken out; token usage, pricing date/source, currency, and missing/estimated cost labels.
- Provenance label, public test configuration, publication timestamp, and publication-policy version.

Full transparency means all evidence supporting the disclosed claim, not every internal seller instruction or every private experiment. Judges should receive public test input/output/reference material, not hidden seller instructions. If evidence cannot be safely disclosed, do not assert full disclosure: rerun with non-sensitive inputs or mark a separate limited-disclosure report that cannot satisfy the v2 seller-publication gate.

Before publication, display the exact public preview; scan for secrets/personal data and require rights/consent. Never auto-publish on job completion. Sanitize HTML/Markdown and downloads. Withdrawal removes the public representation according to policy; it does not turn old evidence into a fresh result or retroactively erase financial history.

## 8. Protected marketplace execution and abuse controls

### 8.1 Definition versus execution rights

Buyer execution must load the seller's immutable version inside a restricted server context. Do not copy it into a buyer-owned `pipelineTemplates`, `pipelineSteps`, project, or custom-agent record accessible by ordinary read/export APIs. Refactor `swarmService` to accept an authorized snapshot loader/resolved context while preserving the existing interpreter; do not implement a second simplified runner.

Execution contexts isolate owner, actor, payer, artifact scope, provider bindings, tools, and result visibility. Never reuse seller project files, conversation memory, Gitee tokens, or storage locations for a buyer run. Source project IDs are references, not permission to load seller data. Existing integrations/tool steps are denied for protected execution unless explicitly supported in this isolated context and covered by evidence.

Audit all leakage surfaces: HTTP, MCP, SSE, errors, logs, intermediates, history, search, export/import, template duplication/application, sharing, debug endpoints, and signed storage URLs. Owner editing continues to work; buyer capabilities return only permitted metadata, final output, sanitized progress, and usage. Admin inspection requires separately audited administrative access.

### 8.2 Trusted provider boundary

Private user-owned pipelines may keep current custom provider endpoints. Protected seller assets require approved destinations resolved server-side; a buyer-supplied URL is never a trusted executor or judge simply because it passes URL validation.

Validate endpoint origin/path policy, TLS verification, DNS/address ranges, redirect behavior, adapter/provider identity, and any proxy/aggregator route allowed to receive prompts. Prevent private-network/metadata egress and credential forwarding to a different origin. Provider references must belong to the authorized payer and remain enabled; seller bindings are not inherited as billable buyer bindings.

An approved provider may still expose request logs to the credential owner or retain inputs. Provider-by-provider logging/access behavior must be checked before claiming meaningful prompt protection under buyer BYOK. If an accepted BYOK route inherently exposes full requests to the buyer, either explicitly offer a weaker, seller-approved protection class or do not support protected execution through it. Do not claim that an endpoint allowlist alone guarantees secrecy.

Security promise: the platform does not offer buyers direct download/read access to protected definitions and reduces avoidable disclosure. It cannot guarantee immunity to output inference, prompt extraction, provider logs, or provider access. Prompts necessarily leave DeeWaanAI for the approved LLM endpoint.

### 8.3 Admission, rate limits, and trials

Admission order: authenticate → resolve execution rights/version → validate purpose/payer/endpoints → validate plan/spend approval → atomically reserve trial/resource capacity → persist run/outbox → execute. Reject before spending when any check fails.

Use existing distributed limiter infrastructure where appropriate, not purchase-row counts as a substitute for time-window execution logs. Limits are policy-configured, not the draft's arbitrary 2/10/50 values. Bound concurrent runs as well as rates; define provider throttling/backoff and tenant fairness. Inspect parameters for abuse without logging plaintext buyer inputs unnecessarily.

Trial reservation is atomic per subject/listing/policy scope. Concurrent requests cannot exceed available slots; retries with the same operation key reuse the reservation. Failure-consumption rules follow P4 and must distinguish not-started cancellation, billable provider failure, completed output, and unknown outcome. Pending/unknown reservations are reconciled, not blindly released for free retries. Paid grants must not accidentally consume trials.

## 9. Cost estimation and accounting

A preflight estimate is required before every paid generation/judging/design operation, including rubric/case preparation when it calls an LLM. Quote the frozen call plan and payer; a materially changed model, graph, case set, judge panel, or limit requires new approval.

Count according to the actual evaluation mode:

- Let C = cases (including explicitly chosen input variants), M = candidates, R = generation repeats, J = judges.
- Independent rubric grading: judgment count = C × M × R × J, multiplied again only if explicit judging-prompt repeats are requested.
- Pairwise comparison: judgment count = C × paired-repeat count × selected pair count × J × orientation count. Define which repeats are paired; never silently create every cross-product.
- Pipeline generation calls = sum of executed LLM steps over all case/candidate/repeat runs. Branches, gate calls, bounded loops, and retries change this number.

Worked structural example, not a price prediction: three cases × two candidates × one repeat × five fixed LLM steps yields 30 generation calls. With three judges independently grading each output, there are 18 judging calls. A single paired comparison for each case with three judges and one orientation instead yields nine judging calls; it is a different plan.

Estimate each call with that model's input/output/cached-token rates and bounded output, plus a disclosed assumption for context growth and branch behavior. Include preparation, design, validators with chargeable infrastructure if applicable, judging, optional narrative, and authorized retries. Show baseline and bounded-high estimates where justified; if prices or token use are unknown, show unknown rather than zero or a fabricated precise total.

Actual accounting sums all observed billable attempts, including failures/retries when usage is available. Separate API estimates from provider-invoiced amounts and platform/license charges. Cost per completed execution and total cost including failed attempts are distinct metrics. Never imply a trial is free of provider charges.

User-approved call/token/time limits are enforceable before dispatch; monetary ceilings are best-effort admission controls where providers expose incomplete billing or calls are in flight. Explain potential overshoot. Existing research-mode cost-cap policies are not changed by this marketplace specification.

## 10. Service/API contracts and state machines

### 10.1 Proposed interfaces

Implement thin tRPC procedures around shared services, registered in `api/router.ts`. New conceptual service files may be `api/services/benchmarkService.ts`, `evidenceService.ts`, `marketplaceExecutionService.ts`, and `settlementService.ts`; these are proposed additions. Equivalent existing modules may be extended where that avoids duplicate logic.

| Procedure family | Inputs / result | Authorization and side effects |
|---|---|---|
| `designJobs.start/get/cancel/apply` | Project/revision, objective, designer binding, approval/idempotency IDs → job/candidate IDs; apply uses expected revision. | Owner plus design capability. Start asynchronous; no implicit project overwrite. |
| `benchmark.create/updateDraft` | Owned workflow version or owned output reference, mode, cases, rubric, candidate/judge/validator configuration → benchmark ID. | Private, owner only. No listing required. Started plans immutable. |
| `benchmark.prepareRubric/prepareCases` | Draft description/configuration and spend approval if LLM-assisted → draft artifacts/job ID. | Owner-funded and private; preset loading does not make a paid call. |
| `benchmark.quote/start/get/cancel/resume` | Benchmark ID, frozen plan/quote hash, spending/idempotency IDs → job ID/status/results. | Ownership, payer, provider and capability checks in shared service. Completion never publishes. |
| `evidence.preview` | Completed benchmark + target listing/version → exact public manifest preview and hash. | Author-owned evidence; applies redaction/eligibility checks without publication. |
| `marketplace.publishVersion` | Listing, exact workflow version, eligible completed seller benchmark, preview hash, consent/policy version, expected listing revision. | Sole seller publication boundary, transactional and idempotent. Links immutable public evidence and sellable version together. |
| `communityEvidence.publish/reportExternal/withdraw` | Owned eligible run/benchmark or clearly declared external report; listing/version; preview/consent. | Authorized tester/contributor; external data stays user-reported. Withdrawal is logged. |
| `marketplace.getPublicEvidence/listCommunityEvidence` | Public listing/version and pagination/filter parameters. | Only public manifest DTOs, not private benchmark rows. Include version/model filters and provenance. |
| `marketplaceExecution.start/get/cancel` | Listing/version, user input, actor-owned provider binding, enabled purpose, spend approval, idempotency key. | Purchase/trial entitlement and safe endpoint policy; final-output-only buyer view. Returns durable run ID. |
| `evidenceReports.create/respond` | Publication/version, reason, supporting report; seller response. | Anti-spam limits, author attribution, audited assessment; no score-triggered automatic delisting. |
| `modelCatalog.recordRelease/notifications.dispatch` | Reviewed catalog event and relevance relationships. | Admin/internal service only; idempotent notices. No public caller can trigger mass notifications or runs. |

Runtime responses use `ctx.user.id` and existing authentication conventions, not v1's invented `ctx.userId`. Common structured errors distinguish not found/not authorized, invalid plan, changed revision, unavailable provider/model, missing pricing approval, exhausted trial, capacity limit, and retryable infrastructure failures. Do not leak cross-tenant existence through verbose errors.

### 10.2 States

| Resource | States and rules |
|---|---|
| Design job | `queued → running → succeeded / failed / cancelled`; recoverable blocked work may use `paused`. `succeeded` means a validated candidate exists, not necessarily that it overwrote the project. |
| Benchmark | `draft → queued → running → completed / partial / failed / cancelled`; `paused` when explicit action is required. A resumed run preserves prior attempts. `completed` requires all planned logical outputs/judgments/validators; terminal failures make `partial` or `failed`. |
| Evidence publication | Private preview is not public. `published → withdrawn`; replacement creates a new publication with a new ID/hash and link to the superseded one. Withdrawal does not silently delete historical run data. |
| Listing | Retain legacy status enum. V2 initially uses `draft`, `published`, `unpublished` plus `publicationMode`; a new revision under test does not change an already published version's status. No new `certifying` transition for v2. |
| Trial reservation | `reserved → consumed / released / uncertain`; transitions are idempotent and policy-controlled. |
| Settlement/payout | Earnings may be `held`, `eligible`, `processing`, `paid`, `failed`, `unknown`, or `reversed/adjusted` through ledger events. Only confirmed external success marks payment complete. Disputes block eligibility. |

Initial qualifying seller publication requires a completed plan; partial/failed plans may be attached as additional disclosed evidence, not substituted for complete proof. A plan can be deliberately small, but its scope must be clear. There is no LLM quality pass threshold.

A seller cannot withdraw the current required public evidence while leaving a v2 listing buyable without replacement evidence. The same transaction must replace it or unpublish the listing. Withdrawal must not automatically revoke paid execution rights; handle serious safety/legal exceptions via the approved policy.

## 11. Subscription, purchasing, and settlement

### 11.1 USD 9.99 subscription

Extend the existing `solo` plan/catalog rather than creating an unapproved Pro tier. Verify a configured USD 9.99 monthly Stripe price before enabling checkout. Whether this is tax-inclusive is P3, not an implicit assumption.

Target product capabilities are manual design, auto-design, evaluation, and seller publication, subject to explicit operational limits and P5. Review both `PLAN_CAPABILITIES` and tier-based grants: changing Stripe price alone will not consistently grant publishing. Use one shared permission service for HTTP, MCP, and workers; protect existing legacy entitlements and team-seat contracts.

A purchased license and the platform subscription are separate rights. P2 governs execution after subscription cancellation. Do not erase purchase history or seller earnings when a subscription lapses. Existing subscribers must not be repriced or lose rights without an approved migration/communication policy.

### 11.2 Existing 30% commission

Reuse `fulfillMarketplacePurchase` and `revokeMarketplacePurchase` through `billingService`; preserve the webhook as the authoritative paid-fulfillment entry. Checkout creation alone does not grant a purchase.

Persist an immutable quote with buyer, listing/version, currency, amount, commission basis/rate, refund/hold policy, and expiry. Validate confirmed payment status and server-derived amounts before fulfillment. Define delayed/asynchronous payment events explicitly if enabled; do not assume every checkout completion means funds are paid.

For an approved commission basis of USD 10.00, 30% is USD 3.00 and remaining gross seller earnings are USD 7.00 before any separately approved fee/tax adjustments. This is arithmetic, not a decision about which party bears processing fees. Store the commission basis and policy version on each sale so later price/policy edits do not rewrite history.

Use a transaction for purchase, entitlement, sales-counter and settlement-intent updates, plus an outbox for external work. Strengthen event/session/payment idempotency and uniqueness where necessary; a read-before-insert check is insufficient under concurrency. Duplicate/out-of-order webhooks must not double-grant rights or double-count revenue. Payment metadata alone is not trusted without matching the stored quote.

If a listing is unpublished or withdrawn after checkout but before payment confirmation, use an explicit paid-but-not-fulfillable reconciliation/refund path. Do not endlessly fail the webhook while leaving the buyer charged and without a recorded resolution. No launch until that path is tested.

### 11.3 Holds, disputes, transfers, and refunds

Delayed cash release is a mechanism, not a seven-day guarantee. Implement only the policy approved under P3. Hold duration is attached to each sale and cannot be shortened by a seller editing a listing. No automatic exemption based on ten sales.

Payout flow: confirm funds and seller eligibility → check no hold/dispute blocks → claim a settlement allocation transactionally → submit with a stable external idempotency key → record provider-confirmed success → mark the allocation paid. On timeout, record `unknown` and reconcile by reference before retry; do not issue another transfer under a new key. A local cron setting `released` is not a payout.

Paid sales require a verified payout integration: account onboarding/eligibility, currency/country support, transfer destination, asynchronous outcomes, failed payments, and reconciliation. Stripe Connect is a candidate, not an assumed installed capability or approved legal structure. An internal ledger alone is insufficient.

Refunds/chargebacks must update purchase/entitlement state according to policy, reverse or adjust commission and seller balance, cancel unreleased allocations, and reconcile already-paid amounts. Specify partial-refund entitlement behavior and recovery/reserve policy before launch. A refund after payout cannot be handled simply by deleting the original ledger row. Maintain an auditable settlement balance and retry-safe event processing.

## 12. Model freshness, notifications, and frontend

### 12.1 Model release awareness

Maintain a shared, versioned model catalog with provider, model ID, availability/source timestamp, explicit family/successor relationships, and verification status. Do not treat a user's `llmProviders.models` cache as a global release history or infer a successor from a name substring.

An admin-reviewed release event is an acceptable first source. Once an event is recorded, automatically find relevant seller publications and create deduplicated suggestions with in-app delivery. Automated feed/API ingestion can be added only after its interface and actual response semantics are verified. An API model list can reflect account access, aliases, or removals rather than a new release.

Notification uniqueness is seller/listing-version/catalog-event/channel. Allow dismiss/snooze and preferences. Email is optional until a real mail delivery integration is confirmed; this spec does not assume one exists. New models never trigger paid retesting or rewrite a seller's chosen model. Existing-model removal/deprecation may disable execution after a clear compatibility check, but must not erase the historical evidence.

Show tested provider/model/date prominently, including unknown revision and missing data. New evidence supplements/version-replaces old evidence without resetting old test dates. No mandatory three- or six-month retest interval and no age-only auto-delisting.

### 12.2 UI changes mapped to existing pages

| Page/component | Change |
|---|---|
| `PipelineEditor.tsx`, `PipelineConfigurator.tsx` | Offer plain solo and solo-plus-refine templates; keep existing graph/loop controls under appropriate advanced UI. Do not force a quality gate or refinement step on every workflow. |
| `MyPipelines.tsx` | Add Evaluate and Auto-design job status/actions for owned workflows. Owned editor access remains separate from purchased execution. |
| New benchmark workspace, routed in `src/App.tsx` | Private grade-only default; existing-output grading; optional candidate/frontier comparison; editable rubric/cases; explicit judge selection; cost approval; progress/resume/cancel; descriptive summary and evidence preview. No forced cheap/frontier pair. |
| `MarketplaceBrowse.tsx` | Public evidence/model/test-date summary and provenance; link to current sellable version. Do not imply “human certified” for v2. |
| `MarketplaceDetail.tsx` | Full disclosure manifest and downloadable safe evidence; filters for community model/version/rubric; conditions clearly separated; report/reply flow; protected run/trial action only if enabled and authorized. |
| `CreatorDashboard.tsx` | Seller drafts, version-specific publication, test history, suggested retests, consent previews, sales, and separately labeled held/eligible/paid earnings. No unsupported payout date promises. |
| Existing settings/billing/admin surfaces | Verified provider bindings, single subscription, policy-version controls, release catalog events, disputes, payout reconciliation. Admin-only operations audited. |

All new UI text follows existing i18n patterns, accessible labels, keyboard interactions, and error handling. Backend authorization is required even when controls are hidden. Display buyer-facing license/refund terms, not a misleading trust badge derived from payout speed.

## 13. Migration and rollout gates

No fixed calendar estimate is asserted. Implementation/deployment require separate authorization. Use additive, reversible rollout stages; never delete research archives, backup snapshots, or legacy review data as “cleanup” in this project.

### G0 — Inventory and policy boundary

Capture current schema/migration history, feature flags, legacy listing statuses, subscriptions, entitlement grants, pending payments/reviews, and relevant deployment versions. Verify backups by a restoration exercise in an isolated environment, not by object existence alone. Identify all clients of existing auto-design and purchase APIs. Resolve P1–P7 for each feature before enabling it.

Use the prepared preservation snapshot and separate staging/redesign service when authorized. Restore only into an explicitly identified isolated target; do not overwrite production. Scrub or restrict personal data in staging and disable live billing, email, scheduled spend, and external side effects.

### G1 — Additive foundations

Add version/evaluation/provenance/outbox schemas and explicit public/private contracts. Retain old enum values, review tables, deposits, refund ledger, encrypted prompts, existing purchases, and TeamSync data. Migrations must be restartable and validated on a production-like copy. Allocate the next migration number from the actual repository, not this document.

Feature-gate new readers/writers; old deployed code must tolerate additive fields. Rollback disables v2 entry points and workers safely while preserving v2 records, outstanding payouts, and purchase rights. Do not roll back by destructive schema removal.

### G2 — Private evaluation and durable design

Enable to internal users first. Test queue loss/restart, cancellation, resume, revision conflicts, provider ownership, grade-only behavior, cost completeness, and HTTP/MCP compatibility. No marketplace publication or real payments required for this stage.

### G3 — Protected execution and evidence publication

Verify approved endpoint/logging policy, run isolation, leakage tests, publication consent, immutable version binding, and community provenance. Run legacy certification paths against v2 fixtures to ensure they cannot bypass the new publication gate. Disable new legacy review tasks/points only for v2; preserve earned balances and existing obligations until explicitly resolved.

### G4 — Commercial cutover

Resolve license, subscription transition, purpose/payer, trial, tax/fee, hold/refund, provider payout eligibility, and moderation policies. Verify external services in sandbox and approved limited live checks. Do not enable new paid sales until refunds, duplicate-event handling, and successful/failed/unknown payouts are demonstrably reconciled.

### G5 — Legacy compatibility and observation

Legacy evidence is imported only with known fields and source links, labeled `legacy_import` with missing metadata shown. Never fabricate exact model versions, costs, judge prompts, or timestamps. Legacy published listings need an explicit preserve/retest/unpublish transition policy; do not silently certify them as v2-complete.

Keep legacy reads and entitlement compatibility until dependent clients and financial obligations are resolved. Disable obsolete UI/routes through feature controls where safe, without dropping tables. Any eventual deletion is a separately authorized retention project, not a step scheduled six weeks after launch.

Observe queue lag, error/timeout rates, incomplete costs, judge failures, blocked unsafe endpoints, public-data reports, duplicate payment attempts, ledger reconciliation discrepancies, and user completion rates. Thresholds and load targets must be measured/configured; v1's $5, ten-minute, NPS, participation, and six-week numbers are not verified commitments.

## 14. Acceptance tests and release evidence

The implementation agent must add tests in the repository's existing Vitest conventions, with integration tests for MySQL/Redis and provider/payment fixtures where required. Mocks cannot establish production settlement, queue durability, endpoint safety, or migration success. Use synthetic inputs for disclosure tests and sandbox credentials for external financial tests.

| ID | Acceptance criterion |
|---|---|
| A01 | An owner grades one existing private output without a listing or comparator. No generation/frontier call occurs unless explicitly requested; results remain private. |
| A02 | A two-candidate model comparison freezes workflow/cases/settings and overrides all model-backed steps consistently. A frontier-solo baseline is visibly a different strategy. |
| A03 | Functional critic/refiner roles and bounded branches/loops survive auto-design. Invalid graphs fail without deleting existing steps; concurrent edits produce a retained candidate rather than overwrite. |
| A04 | Design HTTP/MCP calls return durable job IDs and enforce the same capabilities/provider ownership. A desktop callback is not required for queued execution. |
| A05 | Queue outage, duplicate messages, worker crash, and outbox replay do not lose accepted intent or produce duplicate logical results. Unknown provider outcomes remain visible; repeated spend is not falsely claimed impossible. |
| A06 | Plan changes invalidate spend approval. Cancellation stops new dispatch; resume preserves attempts and does not silently rerun completed cases. |
| A07 | Score 10.00 is representable; out-of-range scores fail validation. Missing judges produce incomplete summaries, not zeros. Quick tests produce no unsupported confidence/significance badge. |
| A08 | The 3-case × 2-candidate × 3-judge independent-scoring plan estimates 18 judgments; the explicitly paired plan with one orientation estimates nine. Loops/retries and unknown prices are disclosed. |
| A09 | User-reported contradictory scores never become platform-recorded evidence. Same/different model, case, rubric, and workflow version are distinguishable; no auto-delisting occurs from a numerical difference. |
| A10 | Publication uses preview hash and consent; a job finishing does not publish. Public endpoints cannot retrieve drafts/private artifacts. Withdrawing required seller evidence replaces it or unpublishes the listing transactionally. |
| A11 | Publication retains original test dates, all selected-plan failures/attempts, model identifiers and unavailable-revision labels. A new workflow version cannot inherit old scores as its own. |
| A12 | A buyer cannot access protected prompts through template apply/duplicate, MCP reads, history, SSE, exports, storage URLs, errors, logs exposed to users, or project sharing. Owner editing still works. |
| A13 | Buyer-controlled endpoints, redirects, private-network destinations, and unapproved proxy routes are rejected before protected calls. Provider logging exposure is documented and approved for every allowed protection class. |
| A14 | A buyer run cannot use seller credentials, memory, project files, repository tokens, or artifacts. Unsupported tool access is denied rather than inherited from the seller project. |
| A15 | Parallel trial starts cannot exceed the enabled quota; idempotent retries reuse reservations; uncertain/failure cases follow policy. A non-purchaser can use an authorized trial without a fake purchase record. |
| A16 | USD 9.99 checkout grants the reviewed capability set consistently across HTTP/MCP/workers; legacy rights and separately purchased grants follow the approved migration/cancellation policy. |
| A17 | Duplicate/out-of-order payment events create one purchase/grant/settlement allocation. Amount/currency/listing-version mismatches fail safely. Paid-but-unfulfillable orders enter a recorded resolution path. |
| A18 | A failed/unknown transfer is never marked paid or blindly resent under a new key. Disputes block release. Full/partial refunds before and after payout reconcile according to approved policy. |
| A19 | A relevant catalog event generates at most one configured notice per recipient/version/channel; dismissal is respected and no paid test is auto-started. |
| A20 | A restoration and additive migration rehearsal preserve legacy reviews, deposits, purchases, entitlements, TeamSync, and research/backup artifacts. Feature rollback does not strand v2 payments or expose private data. |
| A21 | Generated code validators cannot reach production secrets/network/storage; judge prompt-injection tests and malformed responses remain contained and disclosed. |
| A22 | No new Pro tier, forced frontier default, unapproved fixed hold/trial entitlement, per-step optimizer, reward credits/points/badges, or automatic numerical punishment is introduced. |

Existing verification commands include `npm test`, `npm run check`, `npm run build`, and `npm run i18n:check`. These are implementation verification requirements, not commands executed by this document revision. Avoid repository-wide auto-formatting or migration execution during specification work.

Launch evidence must include actual test logs, migration/restore results, API/public-DTO checks, approved policy versions, and external integration verification. Static reading alone cannot establish that the integration works.

## 15. Implementation packages and delegation boundaries

Packages are dependencies, not time estimates. Assign disjoint file ownership where work runs in parallel; one integration owner manages shared schema/contracts/router registration and resolves cross-package assumptions.

| Package | Scope | Dependencies and completion gate |
|---|---|---|
| W1: contracts and versioning | Shared schemas, persistence, immutable workflow/evaluation models, additive migration definitions. | G0 inventory; A07/A11/A20 foundations. |
| W2: execution and auto-design | Shared authorization, snapshot execution, design jobs, outbox/recovery, MCP compatibility, cost/call ledger. | W1; A01–A08 and A14. |
| W3: evidence and marketplace | Publication manifest/consent, protected DTOs, versioned listing flow, community reports, release notices. | W1/W2; A09–A14/A19/A21. |
| W4: commercial controls | Plan/entitlement migration, execution/trial grants, settlement/refunds/payout reconciliation. | W1 plus resolved P1–P6 for enabled features; A15–A18. |
| W5: user interfaces | **Rescoped by D9 (2026-09-20):** MCP-first workbench instead of new authoring screens. Remaining UI work is adapting the existing shop front — marketplace browse/detail, public evidence page, pricing/checkout, account/credentials/consent — plus i18n and accessible errors. MCP tool responses become the primary interface and must return complete, well-shaped, renderable DTOs. | Agreed W1 contracts; adapt what already ships rather than inventing new screens; no UI may become the only place authorization exists. |
| W6: release verification | Cross-path authorization, migration rehearsal, load/fault tests, external-service sandbox checks, feature-gated rollout and rollback. | Prior packages and policy gates; full acceptance matrix. |

Do not modify the designer prompt, billing semantics, evidence model, or protected execution policy independently in different agents. Contract changes must be agreed before parallel edits consume them. No implementation package includes deleting archives or silently changing production access settings.

## 16. v1 audit closure and remaining verification

| v1 finding | v2 resolution |
|---|---|
| Mandatory frontier/marketplace comparison | Private grade-only journey and optional comparisons, sections 4 and 10. |
| Invented Pro tier, unlimited promises, fixed hold and sales-count exemptions | Confirmed/open decision split and launch gates, sections 1 and 11. |
| Reward/badge creep and automatic delisting | D7, community provenance/reporting, A09/A22. |
| “Different score = verified” | Separate provenance from agreement; recorded versus external evidence, sections 6 and 7. |
| Synchronous design and missing recovery | Shared durable jobs, outbox, MCP compatibility, section 5. |
| Contradictory completion/publication states | Independent job/publication states and one seller publication boundary, section 10. |
| Single-model/single-judge schema and missing version binding | Cases/candidates/runs/judgments/attempts linked to immutable versions, section 6. |
| Decimal overflow, cost undercount, unsupported confidence | Explicit scales, call arithmetic, descriptive-only quick summaries, sections 6, 7, and 9. |
| Weak protected-run promise and custom endpoint leak | Separate execute/read rights, trusted egress and provider logging gates, section 8. |
| Purchase-required trials and post-execution limits | Independent grants and atomic preflight reservation, sections 6 and 8. |
| Marking payout released before transfer | Separate immutable settlement and externally confirmed payout lifecycle, section 11. |
| Incorrect integration names/duplicate commission work | Verified architecture map and reuse of current 30% implementation, section 3. |
| Designer overconstraint and overgeneralized research | Preserve task-adapted design; scope claims to observed conditions, section 2. |
| Destructive migrations/fabricated legacy evidence | Additive staged migration, explicit legacy provenance, no table removal, section 13. |
| Assumed provider release/email APIs and six-week forecast | Verified-catalog event boundary, explicit external checks, stage gates without delivery claims. |

**Verification boundary:** This v2 revision is grounded in local source inspection, the prior audit, and confirmed user decisions. It does not claim a live Stripe payout integration, provider logging guarantees, email delivery, model-release feed behavior, restored production database, or passing runtime tests. Those require the gates and evidence above. It does not modify the paper or original offering report.

**Next implementation prerequisite:** Resolve the policies necessary for the chosen first release, approve the package boundaries, and authorize implementation separately. Private evaluation foundations can be implemented independently once authorized; unresolved paid/public features remain disabled.
