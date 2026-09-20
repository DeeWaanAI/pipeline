// Pure content builder for the deewaanai_help tool. No I/O — the tool
// handler resolves capabilities/flags/settings and passes them in, so this
// module is unit-testable. The catalog mirrors the registered MCP tools;
// buildHelp() filters it down to what the CALLER can actually use
// (scopes + capabilities + feature flags) and adds situation-aware tips.

export interface HelpCatalogEntry {
  name: string;
  group: "Discover" | "Run" | "Research" | "Author" | "Evaluate" | "Marketplace" | "Publish" | "Account" | "Your data" | "Team" | "Diagnostics";
  summary: string;
  example?: string;
  scopes: string[];
  capability?: string;
  flag?: string;
}

export interface BuildHelpInput {
  tier: string;
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
  tier: string;
  overview: string;
  sections: HelpSection[];
  locked: HelpSection[];
  upgradeCTA: string;
  tips: string[];
}

const GROUP_ORDER: HelpCatalogEntry["group"][] = [
  "Discover", "Run", "Research", "Author", "Evaluate", "Marketplace", "Publish", "Account", "Your data", "Team", "Diagnostics",
];

// ─── Tier marketing copy (internal upsell) ─────────────────────────
interface TierUpsell {
  name: string;
  unlocks: string[]; // capability strings
  pitch: string[];   // human-readable value props
}

const TIER_UPSELL: Record<string, TierUpsell[]> = {
  standard: [
    {
      name: "Pro Designer",
      unlocks: ["pipeline:custom", "llm:3", "marketplace:publish"],
      pitch: [
        "IF/WHILE quality gates — loop back automatically until output passes quality checks",
        "Up to 3 LLM providers per pipeline — mix GPT-4, Claude, DeepSeek in one chain",
        "Publish your pipelines to the marketplace and earn from every purchase",
      ],
    },
    {
      name: "Pro Auto",
      unlocks: ["pipeline:autodesign"],
      pitch: [
        "AI Auto-Designer — describe your goal in plain language, we build the optimal pipeline automatically",
        "Everything in Pro Designer included",
      ],
    },
  ],
  pro_designer: [
    {
      name: "Pro Auto",
      unlocks: ["pipeline:autodesign"],
      pitch: [
        "AI Auto-Designer — describe your goal in plain language, we build the optimal pipeline automatically",
      ],
    },
  ],
  pro_auto: [],
};

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
    summary: "Create a pipeline step by step: agents run in sequence; paid tiers add if/while quality gates that loop back until the output passes.",
    example: "\"Create a pipeline that drafts a post, critiques it, and refines it until it passes.\"",
  },
  {
    name: "update_pipeline", group: "Author", scopes: ["mcp:write"],
    summary: "Edit a pipeline you own: rename, reorder steps, change prompts or gate settings.",
  },
  {
    name: "design_pipeline", group: "Author", scopes: ["mcp:write"], capability: "pipeline:autodesign",
    summary: "Auto-designer: state the objective in plain language and the platform generates the optimal pipeline (agents, prompts, quality gates, approvals) as a new project plus a reusable template.",
    example: "\"Design a pipeline that turns a product idea into a launch plan.\"",
  },
  {
    name: "start_design_job", group: "Author", scopes: ["mcp:write"], capability: "pipeline:autodesign", flag: "v2DesignJobs",
    summary: "Durable auto-design: queues the designer as a background job on your configured provider (no live session needed) and returns a job id. The candidate is retained as an immutable version — review and apply it deliberately; your project is never overwritten silently.",
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
    summary: "Your benchmarks, newest first, with state and evidence availability.",
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
  // ── Marketplace ─────────────────────────────────────────────────
  {
    name: "publish_to_marketplace", group: "Marketplace", scopes: ["mcp:write"], capability: "marketplace:publish",
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
    summary: "Read any listing's published evidence: scores with their bounds and weights, judge agreement, attempts, costs and disclosure class. Public manifests only — never the seller's private prompts or benchmark rows.",
    example: "\"Show me the evidence behind listing 7 before I buy it.\"",
  },
  {
    name: "start_protected_run", group: "Marketplace", scopes: ["mcp:run"], flag: "v2ProtectedExecution",
    summary: "Run a pipeline you bought WITHOUT getting its definition. The seller's published immutable version executes server-side in a restricted context — their prompts, files, memory, repository tokens and tools are not reachable, your own approved provider is the only billable route, and the endpoint must be on the approved list. The result states the protection class and the provider's logging disclosure.",
    example: "\"Run listing 3 on this text using my OpenAI provider.\"",
  },
  {
    name: "marketplace_execution_right", group: "Marketplace", scopes: ["mcp:read"], flag: "v2ProtectedExecution",
    summary: "Whether you may run a listing, exactly which workflow version that covers (an old purchase cannot keep running a superseded version), how the right was obtained, when it expires, and which evidence hash currently backs it.",
  },
  {
    name: "protected_run_status", group: "Marketplace", scopes: ["mcp:read"], flag: "v2ProtectedExecution",
    summary: "Progress and final output of a protected run: step states, names, tokens and latency plus the answer — never the workflow's prompts or intermediate content.",
  },
  // ── Account ─────────────────────────────────────────────────────
  {
    name: "upgrade_tier", group: "Account", scopes: ["mcp:read"],
    summary: "Show your current tier, missing capabilities, and upgrade options with pricing and checkout links.",
    example: "\"What tiers are available and how much do they cost?\"",
  },
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
    summary: "Show your tier, capabilities, configured LLM providers, and default model.",
  },
  {
    name: "set_default_model", group: "Account", scopes: ["mcp:write"],
    summary: "Set your preferred model (and optionally provider) used for new pipeline work.",
  },
  {
    name: "deewaanai_help", group: "Account", scopes: ["mcp:read"],
    summary: "This guide — tailored to your tier and connected app.",
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
  // ── Team (TeamSync flag) ────────────────────────────────────────
  {
    name: "team_context_get", group: "Team", scopes: ["team:read"], flag: "teamsync",
    summary: "Read shared team context across connected desktop apps.",
  },
  {
    name: "team_memory_append", group: "Team", scopes: ["team:write"], flag: "teamsync",
    summary: "Append to shared team memory.",
  },
  {
    name: "team_runs_list", group: "Team", scopes: ["team:read"], flag: "teamsync",
    summary: "List runs shared with your team.",
  },
  {
    name: "team_run_resume", group: "Team", scopes: ["team:write"], flag: "teamsync",
    summary: "Resume a run handed off by another teammate or app.",
  },
  {
    name: "team_handoff", group: "Team", scopes: ["team:write"], flag: "teamsync",
    summary: "Hand off work to another teammate or connected app.",
  },
  {
    name: "team_feedback_submit", group: "Team", scopes: ["team:write"], flag: "teamsync",
    summary: "Submit structured feedback on a teammate's run.",
  },
  {
    name: "team_skills_list", group: "Team", scopes: ["team:read"], flag: "teamsync",
    summary: "List skills shared by your team.",
  },
  {
    name: "team_skill_use", group: "Team", scopes: ["team:write"], flag: "teamsync",
    summary: "Use a shared team skill.",
  },
  // ── Diagnostics ─────────────────────────────────────────────────
  {
    name: "sample_ping", group: "Diagnostics", scopes: ["mcp:read"], flag: "mcp_sampling",
    summary: "Check whether your connected desktop app can run pipeline steps on its own LLM (MCP sampling) instead of an API key.",
  },
];

export function buildHelp(input: BuildHelpInput): HelpContent {
  const caps = new Set(input.capabilities);
  const scopes = new Set(input.scopes);

  const visible = HELP_CATALOG.filter((e) => {
    if (!e.scopes.every((s) => scopes.has(s))) return false;
    if (e.capability && !caps.has(e.capability)) return false;
    if (e.flag && !input.flags[e.flag]) return false;
    return true;
  });

  const lockedTools = HELP_CATALOG.filter((e) => {
    if (!e.scopes.every((s) => scopes.has(s))) return false;
    if (e.flag && !input.flags[e.flag]) return false;
    // Show as "locked" if the user has the scope but lacks the capability
    return e.capability && !caps.has(e.capability);
  });

  const sections: HelpSection[] = [];
  for (const group of GROUP_ORDER) {
    const tools = visible
      .filter((e) => e.group === group)
      .map(({ name, summary, example }) => ({ name, summary, ...(example ? { example } : {}) }));
    if (tools.length > 0) sections.push({ group, tools });
  }

  const locked: HelpSection[] = [];
  if (lockedTools.length > 0) {
    for (const group of GROUP_ORDER) {
      const tools = lockedTools
        .filter((e) => e.group === group)
        .map(({ name, summary }) => ({ name, summary }));
      if (tools.length > 0) locked.push({ group, tools });
    }
  }

  const tips: string[] = [];
  const upsells = TIER_UPSELL[input.tier] ?? [];

  if (upsells.length > 0) {
    tips.push(
      `Your current plan is ${input.tier}. Upgrade to unlock more:`,
    );
    for (const u of upsells) {
      tips.push(`${u.name}: ${u.pitch.join("; ")}.`);
    }
    tips.push('Call upgrade_tier to see pricing and subscribe.');
  } else {
    tips.push("You're on the top tier — you have access to every feature.");
  }

  if (!caps.has("pipeline:autodesign")) {
    tips.push(
      "Auto-design (design_pipeline) is part of the top tier. On your current plan you can still build any pipeline manually with create_pipeline — describe the agents and steps and the assistant will create them.",
    );
  }
  if (!caps.has("pipeline:custom")) {
    tips.push(
      "Your plan supports sequential pipelines (agents run one after another). If/while quality gates that loop until the output passes are available on higher tiers.",
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
    "Pipelines are agents run one after another. Depending on your tier, if/while gates can review an agent's output and loop back until it passes, and approval steps pause for your OK. The auto designer generates the optimal chain from a plain-language objective.",
  );

  return {
    tier: input.tier,
    overview:
      "DeeWaanAI lets you build and run multi-agent pipelines from this chat. Everything below is filtered to what your account and connected app can actually do.",
    sections,
    locked,
    upgradeCTA: upsells.length > 0
      ? `You're on ${input.tier}. Call upgrade_tier to see plans and pricing.`
      : "You're on the top tier — every feature is unlocked.",
    tips,
  };
}
