// Pure content builder for the deewaanai_help tool. No I/O — the tool
// handler resolves what the caller owns/has enabled and passes it in, so this
// module is unit-testable. The catalog mirrors the registered MCP tools;
// buildHelp() filters it down to what the CALLER can actually use
// (scopes + feature flags) and adds situation-aware tips.
//
// There is no tier ladder (owner decision 2026-09-22): one flat monthly
// subscription, 7-day trial from signup, bring your own LLM keys, no per-run
// fees. So nothing here is gated on a plan, and there is no upsell copy to
// generate — a tool is shown if the caller's scopes and the enabled feature
// flags allow it.

export interface HelpCatalogEntry {
  name: string;
  group: "Discover" | "Run" | "Research" | "Author" | "Evaluate" | "Marketplace" | "Publish" | "Account" | "Your data" | "Diagnostics";
  summary: string;
  example?: string;
  scopes: string[];
  flag?: string;
}

export interface BuildHelpInput {
  /** What the account owns: unexpired entitlement rows (purchases, grants). */
  capabilities: string[];
  scopes: string[];
  /** flag key → enabled for this user */
  flags: Record<string, boolean>;
  /** whether the user has at least one LLM provider configured */
  hasProvider: boolean;
  /** null = no live session bridge; otherwise sampling support of the connected client */
  samplingSupported: boolean | null;
}

export interface HelpSection {
  group: string;
  tools: Array<{ name: string; summary: string; example?: string }>;
}

export interface HelpContent {
  overview: string;
  sections: HelpSection[];
  tips: string[];
}

const GROUP_ORDER: HelpCatalogEntry["group"][] = [
  "Discover", "Run", "Research", "Author", "Evaluate", "Marketplace", "Publish", "Account", "Your data", "Diagnostics",
];

export const HELP_CATALOG: HelpCatalogEntry[] = [
  // ── Discover ────────────────────────────────────────────────────
  {
    name: "list_pipelines", group: "Discover", scopes: ["mcp:read"],
    summary: "List your pipelines: projects (with step counts), saved templates, and purchased marketplace pipelines.",
    example: "\"What pipelines do I have?\"",
  },
  {
    name: "get_pipeline", group: "Discover", scopes: ["mcp:read"],
    summary: "Show one pipeline in full: agents, steps, if/while gates, approvals.",
    example: "\"Show me pipeline 12.\"",
  },
  {
    name: "get_shared_pipeline", group: "Discover", scopes: ["mcp:read"],
    summary: "Read a pipeline someone shared with you, at exactly the level your grant allows: a full share returns the real steps with every system prompt, a run_only share returns step order, names, roles and enabled flags only and says what was withheld. No account with no grant gets further than 'not found'.",
    example: "\"What did Ali share with me?\"",
  },
  {
    name: "project_context", group: "Discover", scopes: ["mcp:read"],
    summary: "Read a project's working context (goal, state summary, recent decisions).",
  },
  {
    name: "memory_get", group: "Discover", scopes: ["mcp:read"],
    summary: "Read your persistent memory notes for a project.",
  },
  {
    name: "search_marketplace", group: "Discover", scopes: ["mcp:read"],
    summary: "Search the marketplace for pre-built pipelines you can purchase and run.",
    example: "\"Find a pipeline for competitive analysis.\"",
  },
  // ── Run ─────────────────────────────────────────────────────────
  {
    name: "run_pipeline", group: "Run", scopes: ["mcp:run"],
    summary: "Start a pipeline run against a project, template, or purchased listing. Agents execute in order; if/while gates route or loop; approval steps pause for you. Optionally chain the output into another project via the chain parameter.",
    example: "\"Run pipeline 12 with input: …\"",
  },
  {
    name: "run_status", group: "Run", scopes: ["mcp:read"],
    summary: "Check a run: current step, agent outputs so far, whether it's waiting on your approval.",
  },
  {
    name: "run_shared_pipeline", group: "Run", scopes: ["mcp:run"],
    summary: "Run a pipeline that was shared with you, on YOUR provider. The definition never lands in your records: an immutable snapshot owned by the account that shared it executes inside a container of yours, and under a run_only grant the run's prompts are redacted at the write so there is nothing to leak later.",
    example: "\"Run the pipeline Ali shared with me on this text.\"",
  },
  {
    name: "shared_run_status", group: "Run", scopes: ["mcp:read"],
    summary: "Progress and final output of a run of a shared pipeline: step states, names, tokens and latency plus the answer. Step prompt and context columns are not part of this projection, and on a run_only share the provider's error text is reported as a category because it can quote the owner's workflow.",
  },
  {
    name: "approve_step", group: "Run", scopes: ["mcp:run"],
    summary: "Approve or reject a paused human-review step so the run continues.",
  },
  // ── Research ────────────────────────────────────────────────────
  {
    name: "run_batch", group: "Research", scopes: ["mcp:run"], flag: "batch_mode",
    summary: "Start a batch of 1–100 pipeline runs in parallel. Returns immediately — poll batch_status. Supports chaining to a target project on completion.",
  },
  {
    name: "batch_status", group: "Research", scopes: ["mcp:read"], flag: "batch_mode",
    summary: "Check a batch's progress: queued/running/completed/failed counts and member runs.",
  },
  {
    name: "resume_batch", group: "Research", scopes: ["mcp:run"], flag: "batch_mode",
    summary: "Resume a paused or partially-failed batch from where it stopped.",
  },
  {
    name: "export_batch_results", group: "Research", scopes: ["mcp:read"], flag: "batch_mode",
    summary: "Export all of a batch's run results as CSV for analysis.",
  },
  {
    name: "export_run", group: "Research", scopes: ["mcp:read"],
    summary: "Export one run's full granular history (every step, prompt, token count, and response) as portable JSON.",
  },
  // ── Author ──────────────────────────────────────────────────────
  {
    name: "create_pipeline", group: "Author", scopes: ["mcp:write"],
    summary: "Create a pipeline step by step: agents run in sequence, and if/while quality gates loop back until the output passes — every step type is open to every account.",
    example: "\"Create a pipeline that drafts a post, critiques it, and refines it until it passes.\"",
  },
  {
    name: "update_pipeline", group: "Author", scopes: ["mcp:write"],
    summary: "Edit a pipeline you own: rename, reorder steps, change prompts or gate settings.",
  },
  {
    name: "design_pipeline", group: "Author", scopes: ["mcp:write"],
    summary: "Auto-designer: state the objective in plain language and the platform generates the optimal pipeline (agents, prompts, quality gates, approvals) as a new project plus a reusable template. Included in your subscription — the LLM calls run on your own provider key.",
    example: "\"Design a pipeline that turns a product idea into a launch plan.\"",
  },
  {
    name: "start_design_job", group: "Author", scopes: ["mcp:write"], flag: "v2DesignJobs",
    summary: "Durable auto-design: queues the designer as a background job on your configured provider (no live session needed) and returns a job id. The candidate is retained as an immutable version — review and apply it deliberately; your project is never overwritten silently. Costs money on your own key, so it still goes quote → approve → start.",
    example: "\"Start a durable design job for: translate legal contracts from English to Arabic.\"",
  },
  {
    name: "design_job_status", group: "Author", scopes: ["mcp:read"], flag: "v2DesignJobs",
    summary: "Poll a design job: queued → running → succeeded/failed/cancelled, with the retained candidate and per-attempt records.",
  },
  {
    name: "cancel_design_job", group: "Author", scopes: ["mcp:write"], flag: "v2DesignJobs",
    summary: "Cancel a queued or running design job. Calls already incurred are not refunded.",
  },
  // ── Evaluate (private evaluation, offering redesign v2 / owner decision D9) ──
  {
    name: "create_benchmark", group: "Evaluate", scopes: ["mcp:write"], flag: "v2Benchmarks",
    summary: "Draft a PRIVATE evaluation of one of your workflows: real task inputs, your judging panel, grade_only by default. Optionally grade an output you already have instead of regenerating it.",
    example: "\"Benchmark my Arabic contract pipeline on these 5 real clauses.\"",
  },
  {
    name: "prepare_benchmark_rubric", group: "Evaluate", scopes: ["mcp:write"], flag: "v2Benchmarks",
    summary: "Pick a rubric template (generic / translation / code) or supply your own dimensions; weights are normalized server-side. Costs nothing.",
  },
  {
    name: "prepare_benchmark_cases", group: "Evaluate", scopes: ["mcp:write"], flag: "v2Benchmarks",
    summary: "Set the case list: trimmed, duplicates reported, stable ids kept so a resume still matches recorded attempts.",
  },
  {
    name: "quote_benchmark", group: "Evaluate", scopes: ["mcp:read"], flag: "v2Benchmarks",
    summary: "The cost preflight before any spend: planned provider calls per candidate, estimated cost (unknown where unpriced, never zero), disclosed upper bounds, and the planHash that binds your approval. Writes nothing.",
    example: "\"What will that benchmark cost before I approve it?\"",
  },
  {
    name: "approve_benchmark_spend", group: "Evaluate", scopes: ["mcp:write"], flag: "v2Benchmarks",
    summary: "Authorize spending on exactly the plan you were quoted, on your own enabled credentials. The hash is recomputed server-side; approvals expire and are used once.",
  },
  {
    name: "start_benchmark", group: "Evaluate", scopes: ["mcp:write"], flag: "v2Benchmarks",
    summary: "Freeze the approved plan and queue it. Your workflow is snapshotted as an immutable version and every candidate runs that snapshot — your project is never rewritten. Refused if anything changed since the quote.",
  },
  {
    name: "benchmark_status", group: "Evaluate", scopes: ["mcp:read"], flag: "v2Benchmarks",
    summary: "Progress and the descriptive summary: counts, spread, judge agreement, failures, observed cost. No confidence intervals, no certification wording, no winner in grade-only.",
  },
  {
    name: "list_benchmarks", group: "Evaluate", scopes: ["mcp:read"], flag: "v2Benchmarks",
    summary: "Your benchmarks, newest first, with state, evidence availability, child progress, best descriptive score and observed cost — the cheap poll. benchmark_status is the one with the summary.",
  },
  {
    name: "cancel_benchmark", group: "Evaluate", scopes: ["mcp:write"], flag: "v2Benchmarks",
    summary: "Stop a queued or running benchmark. Calls already made stay recorded and are not refunded; nothing is deleted.",
  },
  {
    name: "resume_benchmark", group: "Evaluate", scopes: ["mcp:write"], flag: "v2Benchmarks",
    summary: "Continue a partial or cancelled plan under its frozen hash. Finished work is never re-run and attempts are appended, never overwritten; needs a fresh approval because resuming spends again.",
  },
  {
    name: "memory_append", group: "Author", scopes: ["mcp:write"],
    summary: "Add a note to your persistent project memory (survives across chats).",
  },
  {
    name: "share_pipeline", group: "Author", scopes: ["mcp:write"],
    summary: "Lend ONE pipeline to ONE named account: run_only lets them run it and keep the answer while their reads show step names and states only, full lets them read the definition, and canModify (full only) lets them edit it. This is a grant between two people, not a team, and never a transfer — you stay the owner and the only account that can publish it.",
    example: "\"Share my contract pipeline with partner@example.com so they can run it but not read the prompts.\"",
  },
  {
    name: "list_pipeline_shares", group: "Author", scopes: ["mcp:read"],
    summary: "The shares involving your account: what you have lent out (revoked grants included, because the row is the record that access existed) and what is currently lent to you, each naming the original creator of the work so you can see that a shared pipeline is a loan.",
  },
  {
    name: "revoke_pipeline_share", group: "Author", scopes: ["mcp:write"],
    summary: "Take a share back, owner-only and idempotent. Access is re-read at dispatch, so a run that was already queued stops before its first provider call; completed runs stay with the account that ran them.",
  },
  {
    name: "update_shared_pipeline", group: "Author", scopes: ["mcp:write"],
    summary: "Edit the steps of a pipeline shared to you as full+canModify. The write lands on the owner's project, ownership does not move, and the recorded original creator is left exactly as it was — improving borrowed work cannot turn it into work you may sell.",
  },
  {
    name: "clone_shared_pipeline", group: "Author", scopes: ["mcp:write"],
    summary: "Copy a full-share pipeline into your own project with a template and a first immutable version. Your copy runs and reads like yours and stays ATTRIBUTED: the original creator is carried forward as data, so publishing stays refused for you. Refused for a run_only share.",
    example: "\"Clone the pipeline Ali shared with me so I can adapt it for our Arabic market.\"",
  },
  // ── Marketplace ─────────────────────────────────────────────────
  {
    name: "publish_to_marketplace", group: "Marketplace", scopes: ["mcp:write"],
    summary: "Create a marketplace listing from a pipeline project. Sets price and description. The listing starts as a draft — call submit_for_review when ready.",
    example: "\"Publish my pipeline 'Contract Redliner' to the marketplace at $4.99.\"",
  },
  {
    name: "submit_for_review", group: "Marketplace", scopes: ["mcp:write"],
    summary: "Submit a draft marketplace listing for certification. Three layers: (1) a deterministic security scan of your prompts; (2) AI triage that runs generated test inputs and gives feedback — it can reject low-quality submissions but can never approve; (3) blind human review — independent reviewers score real outputs without knowing who built it. Publication requires human consensus: a minimum average score plus a minimum pass ratio. If rejected at any layer, you get actionable findings and can fix and resubmit.",
    example: "\"Submit listing 1 for certification.\"",
  },
  {
    name: "get_listing_status", group: "Marketplace", scopes: ["mcp:read"],
    summary: "Check a marketplace listing's certification stage: generating test data, pending review, in blind review, certifying, rejected, or published.",
    example: "\"What's the status of listing 1?\"",
  },
  {
    name: "my_marketplace_listings", group: "Marketplace", scopes: ["mcp:read"],
    summary: "List all marketplace listings you have created (drafts, in review, published, rejected).",
    example: "\"Show my marketplace listings.\"",
  },
  {
    name: "my_purchases", group: "Marketplace", scopes: ["mcp:read"],
    summary: "List marketplace pipelines you have purchased. Includes subscription status and end dates.",
    example: "\"Show my purchased pipelines.\"",
  },
  {
    name: "enroll_reviewer", group: "Marketplace", scopes: ["mcp:write"],
    summary: "Join the marketplace reviewer pool. Reviewers evaluate pipeline test outputs and earn points redeemable for subscription days.",
    example: "\"Enroll me as a reviewer.\"",
  },
  {
    name: "get_next_review_task", group: "Marketplace", scopes: ["mcp:write"],
    summary: "Claim the next blind review task as an enrolled reviewer: one anonymized input/output pair plus the rubric, with the listing's identity never revealed. This is how the human half of certification is actually performed, so it must be discoverable from the guide.",
    example: "\"Give me my next review task.\"",
  },
  {
    name: "submit_review_task", group: "Marketplace", scopes: ["mcp:write"],
    summary: "Return your 1–5 scores for a claimed blind task and earn reviewer points. When a listing reaches the reviewer quorum, certification is decided from the consensus — published or rejected, never left in review.",
    example: "\"Score task 12: accuracy 4, completeness 4, clarity 5.\"",
  },
  // ── Publish (v2 evidence) ───────────────────────────────────────
  {
    name: "preview_evidence", group: "Publish", scopes: ["mcp:read"], flag: "v2Publication",
    summary: "See EXACTLY what would become public before anything is: the tested version, every case and judgment, the rubric and weights, all attempts and costs, and the validators recorded as disabled. Returns the hash you must echo back to publish, plus any credential it would leak and any reason a seller publication would be refused.",
    example: "\"Preview the evidence for benchmark 3 as seller evidence.\"",
  },
  {
    name: "publish_evidence_version", group: "Publish", scopes: ["mcp:write"], flag: "v2Publication",
    summary: "Publish your listing's evidence AND the exact workflow version it was measured on, together. This is the only way a listing becomes published under the v2 rules: it requires your consent to the preview hash, refuses stale or mismatched versions (a new revision cannot inherit old scores), and never routes through the legacy certification states.",
    example: "\"Publish benchmark 3's evidence for listing 1, version 4, hash abc123…\"",
  },
  {
    name: "publish_community_evidence", group: "Publish", scopes: ["mcp:write"], flag: "v2Publication",
    summary: "Publish your own measured report about a workflow. It can reference a listing but never becomes that listing's required seller evidence, so independent and seller-reported proof stay distinguishable.",
  },
  {
    name: "supersede_evidence", group: "Publish", scopes: ["mcp:write"], flag: "v2Publication",
    summary: "Replace published evidence with a new measurement: a NEW immutable row that records what it supersedes, with the original test date preserved. Nothing is edited in place.",
  },
  {
    name: "withdraw_evidence", group: "Publish", scopes: ["mcp:write"], flag: "v2Publication",
    summary: "Withdraw a publication you authored, with a logged reason. Historical runs and financial records are untouched. If it was a listing's current evidence, the same transaction unpublishes the listing — a v2 listing is never left buyable without evidence.",
  },
  {
    name: "listing_publication_state", group: "Publish", scopes: ["mcp:read"], flag: "v2Publication",
    summary: "Which version a listing sells, which evidence backs it, whether it is legacy or v2, and the revision number to send so you cannot clobber a concurrent change.",
  },
  {
    name: "get_public_evidence", group: "Publish", scopes: ["mcp:read"],
    summary: "Read evidence by listing, publication id or manifest hash, including standalone community reports. Purchased evidence remains readable after withdrawal for entitled buyers. Only disclosure manifests — never private workflow prompts or benchmark rows.",
    example: "\"Show me the evidence behind listing 7 before I buy it.\"",
  },
  {
    name: "preview_external_evidence", group: "Publish", scopes: ["mcp:read"], flag: "v2Publication",
    summary: "Preview a user-declared community report about a public v2 listing without writing anything: the exact disclosure, its consent hash, and any credential it would leak. Nothing is measured or run here, and no seller certification is created.",
    example: "\"Preview my report: I ran listing 7 on these five inputs and got these outputs.\"",
  },
  {
    name: "report_external_evidence", group: "Publish", scopes: ["mcp:write"], flag: "v2Publication",
    summary: "Publish the exact previewed external report after the user consents to its hash. Stored as user-reported and not independently verified — it can never be shown as platform-recorded evidence or become a listing's required seller proof.",
  },
  {
    name: "get_external_evidence", group: "Publish", scopes: ["mcp:read"],
    summary: "Read one user-declared community report by id: declared inputs/outputs/model/date, the conspicuous not-verified notice, and when it was submitted (which is NOT when anything was tested).",
  },
  {
    name: "list_external_evidence", group: "Publish", scopes: ["mcp:read"],
    summary: "List a listing's community reports, newest first, separately labelled from seller evidence. Every entry is user-reported and not independently verified.",
    example: "\"What have other users reported about listing 7?\"",
  },
  {
    name: "withdraw_external_evidence", group: "Publish", scopes: ["mcp:write"],
    summary: "Withdraw a community report you authored, with a logged reason. Author-only, idempotent and available even while publication is disabled — a user must always be able to retract their own disclosed data. The row and its consent proof are retained; withdrawal is not a quality verdict.",
  },
  {
    name: "start_protected_run", group: "Marketplace", scopes: ["mcp:run"], flag: "v2ProtectedExecution",
    summary: "Run a pipeline you bought WITHOUT getting its definition. The seller's published immutable version executes server-side in a restricted context — their prompts, files, memory, repository tokens and tools are not reachable, your own approved provider is the only billable route, and the endpoint must be on the approved list. The result states the protection class and the provider's logging disclosure.",
    example: "\"Run listing 3 on this text using my OpenAI provider.\"",
  },
  {
    name: "marketplace_execution_right", group: "Marketplace", scopes: ["mcp:read"], flag: "v2ProtectedExecution",
    summary: "Whether you may run a listing and which version your purchase or grant covers. Delisting stops new sales, not existing purchased access; purchased versions do not inherit a later version's evidence.",
  },
  {
    name: "protected_run_status", group: "Marketplace", scopes: ["mcp:read"], flag: "v2ProtectedExecution",
    summary: "Progress and final output of a protected run: step states, names, tokens and latency plus the answer — never the workflow's prompts or intermediate content.",
  },
  {
    name: "model_retest_suggestions", group: "Publish", scopes: ["mcp:read"], flag: "v2Publication",
    summary: "Your model-freshness suggestions from admin-reviewed release events. Nothing has been re-run and nothing has been spent; your published scores and test dates are untouched, and age alone never delists a listing.",
  },
  {
    name: "respond_retest_suggestion", group: "Publish", scopes: ["mcp:write"], flag: "v2Publication",
    summary: "Dismiss, snooze, or note that you intend to retest. 'plan_retest' starts nothing — you still create, quote and approve a benchmark yourself, so a suggestion can never turn into a billable run on its own.",
  },
  {
    name: "listing_model_freshness", group: "Publish", scopes: ["mcp:read"], flag: "v2Publication",
    summary: "Which provider/model/version a listing's published evidence was tested on and when, whether the provider has since deprecated it, and the reviewed successor — explicit lineage, never a name match.",
  },
  // ── Account ─────────────────────────────────────────────────────
  {
    name: "suggest_llm_providers", group: "Account", scopes: ["mcp:read"],
    summary: "Show a curated list of free, cheap, and local LLM providers with signup links and setup instructions. Start here if you don't have an API key yet.",
    example: "\"What free providers can I use?\"",
  },
  {
    name: "add_provider", group: "Account", scopes: ["mcp:write"],
    summary: "Add an LLM provider from this chat — just paste the slug and API key. The rest is auto-filled from known defaults.",
    example: "\"Add a Gemini provider with key: AI...\"",
  },
  {
    name: "get_settings", group: "Account", scopes: ["mcp:read"],
    summary: "Show what you own (purchased pipelines and other entitlements), configured LLM providers, and your default model.",
  },
  {
    name: "set_default_model", group: "Account", scopes: ["mcp:write"],
    summary: "Set your preferred model (and optionally provider) used for new pipeline work.",
  },
  {
    name: "deewaanai_help", group: "Account", scopes: ["mcp:read"],
    summary: "This guide — filtered to your scopes, what you own, and the connected app.",
  },
  // ── Your data (Batch B — no lock-in) ────────────────────────────
  {
    name: "export_pipeline", group: "Your data", scopes: ["mcp:read"],
    summary: "Export any pipeline you own as portable JSON. Ask your chat to save it anywhere — a local folder, GitHub, or paste it into another tool.",
    example: "\"Export pipeline 12 as JSON and save it to my Documents folder.\"",
  },
  {
    name: "export_my_data", group: "Your data", scopes: ["mcp:read"],
    summary: "Export everything you own (pipelines, agents, templates, settings) in one JSON bundle. Your data is always exportable.",
    example: "\"Export all my DeeWaanAI data.\"",
  },
  {
    name: "sync_to_github", group: "Your data", scopes: ["mcp:write"],
    summary: "Push a pipeline export to your connected GitHub repo.",
    example: "\"Back up my pipeline to GitHub.\"",
  },
  // ── Diagnostics ─────────────────────────────────────────────────
  {
    name: "sample_ping", group: "Diagnostics", scopes: ["mcp:read"], flag: "mcp_sampling",
    summary: "Check whether your connected desktop app can run pipeline steps on its own LLM (MCP sampling) instead of an API key.",
  },
];

export function buildHelp(input: BuildHelpInput): HelpContent {
  const scopes = new Set(input.scopes);

  // Nothing is capability-gated any more: a tool shows if the caller's scopes
  // and the enabled feature flags allow it. `capabilities` is only what the
  // account OWNS (purchases/grants), used for an informational tip below.
  const visible = HELP_CATALOG.filter((e) => {
    if (!e.scopes.every((s) => scopes.has(s))) return false;
    if (e.flag && !input.flags[e.flag]) return false;
    return true;
  });

  const sections: HelpSection[] = [];
  for (const group of GROUP_ORDER) {
    const tools = visible
      .filter((e) => e.group === group)
      .map(({ name, summary, example }) => ({ name, summary, ...(example ? { example } : {}) }));
    if (tools.length > 0) sections.push({ group, tools });
  }

  const tips: string[] = [];

  tips.push(
    "One flat monthly subscription covers everything here — every step type, the auto designer and marketplace publishing. Your trial runs 7 days from signup, you bring your own LLM keys, and DeeWaanAI never charges per run: every provider call is billed by your own provider.",
  );

  const owned = input.capabilities.filter((c) => c.startsWith("pipeline:run:"));
  if (owned.length > 0) {
    tips.push(
      `You own ${owned.length} purchased marketplace pipeline(s) — list_pipelines shows them under Purchased, and run_pipeline runs them on your own provider.`,
    );
  }

  const samplingFlagOn = !!input.flags["mcp_sampling"];
  if (samplingFlagOn && input.samplingSupported === true) {
    tips.push(
      "Your connected app supports MCP sampling — the auto designer can run on your app's own LLM, no API key needed.",
    );
  } else if (!input.hasProvider) {
    tips.push(
      "No LLM provider is configured yet. Pipelines need a provider API key to design and run. Call suggest_llm_providers to pick a free/cheap option (e.g. Gemini free tier or DeepSeek), then add_provider to paste your key right here — no need to open the web app.",
    );
  }

  tips.push(
    "Pipelines are agents run one after another. if/while gates can review an agent's output and loop back until it passes, and approval steps pause for your OK. The auto designer generates the optimal chain from a plain-language objective.",
  );

  return {
    overview:
      "DeeWaanAI lets you build and run multi-agent pipelines from this chat. Everything below is filtered to what your account and connected app can actually do.",
    sections,
    tips,
  };
}
