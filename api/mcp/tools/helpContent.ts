// Pure content builder for the deewaanai_help tool. No I/O — the tool
// handler resolves what the caller owns/has enabled and passes it in, so this
// module is unit-testable. The catalog mirrors the registered MCP tools;
// buildHelp() filters it down to what the CALLER can actually use
// (scopes + feature flags) and adds situation-aware tips.
//
// There is no tier ladder (owner decision 2026-09-22): one flat monthly
// v3 commercial model (owner, 2026-10-12/13): no subscription — the studio and the
// MCP are free, bring your own LLM keys, no per-run
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
    name: "project_context", group: "Discover", scopes: ["mcp:read"],
    summary: "Read a project's working context (goal, state summary, recent decisions).",
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
    name: "approve_step", group: "Run", scopes: ["mcp:run"],
    summary: "Approve or reject a paused human-review step so the run continues.",
  },
  // ── Research ────────────────────────────────────────────────────
  {
    name: "export_run", group: "Research", scopes: ["mcp:read"],
    summary: "Export one run's authorized history plus archive.files: input, final output, step records, full run JSON and a hash manifest. The chat client must write decoded UTF-8 contents into your selected folder and verify byte counts and SHA-256 before claiming success. Protected intermediate data remains withheld; nothing is deleted.",
  },
  // ── Author ──────────────────────────────────────────────────────
  {
    name: "create_pipeline", group: "Author", scopes: ["mcp:write"],
    summary: "Create a pipeline step by step: agents run in sequence, and if/while quality gates loop back until the output passes — every step type is open to every account. Choose each step's model and owned providerId (get_settings lists ids); get_pipeline returns the saved routes for editing.",
    example: "\"Create a pipeline that drafts a post, critiques it, and refines it until it passes.\"",
  },
  {
    name: "update_pipeline", group: "Author", scopes: ["mcp:write"],
    summary: "Edit a pipeline you own: rename, reorder steps, change prompts or gate settings.",
  },
  {
    name: "design_pipeline", group: "Author", scopes: ["mcp:write"],
    summary: "Auto-designer: state the objective in plain language and the platform generates the optimal pipeline (agents, prompts, quality gates, approvals) as a new project plus a reusable template. Free to use — the LLM calls run on your own provider key.",
    example: "\"Design a pipeline that turns a product idea into a launch plan.\"",
  },
  {
    name: "start_design_job", group: "Author", scopes: ["mcp:write"], flag: "v2DesignJobs",
    summary: "Durable auto-design: queues the designer as a background job on your configured provider (no live session needed) and returns a job id. The candidate is retained as an immutable version — review and apply it deliberately; your project is never overwritten silently. Costs money on your own key, so it still goes quote → approve → start.",
    example: "\"Start a durable design job for: translate legal contracts from English to Arabic.\"",
  },
  {
    name: "design_job_status", group: "Author", scopes: ["mcp:read"], flag: "v2DesignJobs",
    summary: "Poll a design job: queued → running → succeeded/failed/cancelled, with the retained candidate version id and per-attempt records. Apply a successful candidate with apply_design_job after approval.",
  },
  {
    name: "apply_design_job", group: "Author", scopes: ["mcp:write"], flag: "v2DesignJobs",
    summary: "Apply a successful design candidate to its original pipeline after you approve replacing the steps. No new LLM call. A changed project returns revision_conflict; an unfinished job returns not_ready. Use get_pipeline to inspect the applied steps before running.",
    example: "Apply the successful design job to my pipeline.",
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
    name: "get_judge_prompts", group: "Evaluate", scopes: ["mcp:read"], flag: "v2Benchmarks",
    summary: "Read complete judging templates or preview custom framing without spending. Returns the revision for saving; the platform editor is /judging?benchmarkId=<id>.",
  },
  {
    name: "save_judge_prompts", group: "Evaluate", scopes: ["mcp:write"], flag: "v2Benchmarks",
    summary: "Save custom judging framing on an owned draft using its revision. Started evaluations stay immutable. Re-quote and approve after edits; no LLM call is made here.",
  },
  {
    name: "export_benchmark", group: "Evaluate", scopes: ["mcp:read"], flag: "v2Benchmarks",
    summary: "Export one private evaluation as an exact local archive — the frozen plan, the full text of every judging prompt the panel used, every case input and candidate output, every judgment including the failures, the cost ledger rows, and a SHA-256 manifest. Read out the manifest's `incomplete` list: those are bodies the server no longer holds and cannot recover. Writes nothing itself and sweeps nothing.",
  },
  // ── Marketplace ─────────────────────────────────────────────────
  {
    name: "export_pipeline_bundle", group: "Your data", scopes: ["mcp:read"],
    summary: "Export your own pipeline as one portable file to send to anyone — no listing, no server. Attach a benchmark's optional archive and its cases, outputs, judgments and judging prompts travel inside the same signed file, bound to the pipeline.",
    example: "\"Export my redliner pipeline with its benchmark so I can send it to a colleague.\"",
  },
  {
    name: "import_pipeline_bundle", group: "Your data", scopes: ["mcp:write"],
    summary: "Import a pipeline bundle file into your account as a project you own and can edit. Verified before anything is written: the steps must match the declared hash and the evidence signature must name this exact pipeline; an unsigned file imports but is reported as unproven.",
    example: "\"Import the bundle I just saved to my folder.\"",
  },
  // ── Publish (v2 evidence) ───────────────────────────────────────
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
    name: "export_my_data", group: "Your data", scopes: ["mcp:read"],
    summary: "Export everything you own (pipelines, agents, templates, settings) in one JSON bundle. Your data is always exportable.",
    example: "\"Export all my DeeWaanAI data.\"",
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
    "DeeWaanAI is free: the studio, your evaluations and the companion MCP are all on your account — no plan, no seats, nothing to renew. You bring your own LLM keys and every provider call is billed by your own provider, never metered per run by us. The marketplace is where money moves: a pipeline sells as a copy you own, and the platform takes a share of that sale.",
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
