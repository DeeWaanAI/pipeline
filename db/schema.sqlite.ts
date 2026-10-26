// GENERATED FILE — do not edit. Source of truth: db/schema.ts.
// Regenerate: node scripts/gen-sqlite-schema.mjs (the mapping rules live there).
// Parity with the MySQL schema is enforced by api/services/schemaParity.test.ts.

import {
  sqliteTable,
  integer,
  text,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/sqlite-core";

// ─── USERS (supports both Kimi OAuth and local username/password) ────
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  unionId: text("unionId").unique(),
  username: text("username").unique(),
  passwordHash: text("password_hash"),
  name: text("name"),
  email: text("email"),
  avatar: text("avatar"),
  role: text("role", { enum: ["user", "admin"] }).default("user").notNull(),
  tier: text("tier", { enum: ["standard", "pro_designer", "pro_auto"] }).default("standard").notNull(),
  // User-level default LLM provider (nullable — falls back to per-project or system default).
  // NOTE: No FK reference to llmProviders.id to avoid circular type inference (llmProviders
  // references users below). Integrity enforced at app level.
  defaultProviderId: integer("default_provider_id"),
  defaultModel: text("default_model"),
  // Persisted UI preferences / user data (survives DB wipes, new deployments)
  preferences: text("preferences", { mode: "json" }).$type<{
    // Saved chat messages per project: { "projectId": [messages...] }
    savedMessages?: Record<string, Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
      agentName?: string;
      pipelineStep?: string;
    }>>;
    // UI state: sidebar collapsed, theme, locale, etc.
    uiState?: Record<string, unknown>;
    // Recent project IDs for quick access
    recentProjectIds?: number[];
  } | null>(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).defaultNow().notNull().$onUpdate(() => new Date()),
  lastSignInAt: integer("lastSignInAt", { mode: "timestamp_ms" }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── LLM PROVIDERS (plugin configurations) ──────────────────────────
export const llmProviders = sqliteTable("llm_providers", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  baseUrl: text("base_url").notNull(),
  // TEXT, not varchar(255): encrypted keys are salt:iv:authTag:ciphertext (131 chars
  // overhead + 2x key length) — modern OpenAI/Anthropic/Aliyun keys (100–165 chars)
  // overflow 255 and made createProvider fail with "Data too long" (migration 020).
  apiKeyRef: text("api_key_ref").notNull(),
  defaultModel: text("default_model").notNull(),
  models: text("models", { mode: "json" }).$type<string[]>(),
  config: text("config", { mode: "json" }).$type<{
    temperature?: number;
    topP?: number;
    timeout?: number;
    declaredRpm?: number; // user-declared provider tier RPM (Research Mode)
  }>(),
  isEnabled: integer("is_enabled", { mode: "boolean" }).default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  userIdIdx: index("idx_llm_providers_user_id").on(table.userId),
}));

// Owner-declared per-model prices (migration 034). The LAST rate source: live
// provider list -> platform price vector -> this. A declaration never overrides
// a number the host publishes, it turns UNKNOWN into a figure, and it is always
// disclosed under its own basis. Per 1M tokens as the provider consoles show it;
// a real 0.00 means a local model, which is a stated fact and not a missing
// measurement. Keyed by credential because the same model id on two hosts can
// cost differently.
export const declaredModelPrices = sqliteTable("declared_model_prices", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  providerRefId: integer("provider_ref_id")
    .references(() => llmProviders.id, { onDelete: "cascade" })
    .notNull(),
  modelId: text("model_id").notNull(),
  inputUsdPerMillion: text("input_usd_per_million").notNull(),
  outputUsdPerMillion: text("output_usd_per_million").notNull(),
  createdBy: integer("created_by")
    .references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => ({
  providerModelUq: uniqueIndex("uq_declared_price_provider_model").on(table.providerRefId, table.modelId),
}));

// ─── PROJECTS ──────────────────────────────────────────────────────
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  description: text("description"),
  giteeOwner: text("gitee_owner"),
  giteeRepo: text("gitee_repo"),
  giteeBranch: text("gitee_branch").default("main"),
  // GitHub integration (parallel to Gitee)
  githubOwner: text("github_owner"),
  githubRepo: text("github_repo"),
  githubBranch: text("github_branch").default("main"),
  localFolderName: text("local_folder_name"),
  stateSummaryPath: text("state_summary_path")
    .default(".ai-swarm/project-state.md"),
  defaultProviderId: integer("default_provider_id")
    .references(() => llmProviders.id),
  defaultModel: text("default_model"),
  pipelineConfig: text("pipeline_config", { mode: "json" }).$type<{
    maxIterations?: number;
    enabledAgents?: string[];
    stopOnNoImprovement?: boolean;
  }>(),
  pipelineTemplateId: integer("pipeline_template_id"), // References reusable template (nullable)
  // ─── LINEAGE: the account that ORIGINALLY created the work this pipeline
  // derives from. NULL (or equal to `user_id`) means "this account made it".
  // Set when a pipeline is cloned out of a share or an import, so a copy can
  // never launder provenance and a recipient can never sell what they were
  // only lent. No FK by design: the name outlives the account, and an FK here
  // would add a new delete constraint on `users`.
  originCreatorId: integer("origin_creator_id"),
  isArchived: integer("is_archived", { mode: "boolean" }).default(false),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
  // Project Intelligence Card (compact JSON, not file contents)
  intelligenceCard: text("intelligence_card", { mode: "json" }).$type<{
    version: number;
    generatedAt: string;
    projectType: string;
    primaryLanguage: string;
    framework: string;
    totalFiles: number;
    totalSize: number;
    fileTree: Array<{
      path: string;
      name: string;
      size: number;
      language: string;
      category: string;
      exports: string[];
      description: string;
      isEntryPoint: boolean;
    }>;
    entryPoints: string[];
    architecture: string;
    entities: Array<{ name: string; type: string; context: string }>;
    databaseTables: Array<{
      name: string;
      columns: Array<{ name: string; type: string; constraints?: string }>;
      sourceFile: string;
    }>;
    apiEndpoints: Array<{ method: string; path: string; sourceFile: string }>;
    todos: string[];
    giteeOwner?: string;
    giteeRepo?: string;
    giteeCommitSha?: string;
  } | null>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  userIdIdx: index("idx_projects_user_id").on(table.userId),
}));

// ─── AGENTS ────────────────────────────────────────────────────────
export const agents = sqliteTable("agents", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  role: text("role").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  providerId: integer("provider_id")
    .references(() => llmProviders.id),
  model: text("model"),
  temperature: text("temperature").default("0.7"),
  maxTokens: integer("max_tokens").default(4096),
  pipelineOrder: integer("pipeline_order").default(0),
  maxIterations: integer("max_iterations").default(1),
  isEnabled: integer("is_enabled", { mode: "boolean" }).default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
});

// ─── SWARM RUNS ────────────────────────────────────────────────────
export const swarmRuns = sqliteTable("swarm_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  userId: integer("user_id")
    .references(() => users.id)
    .notNull(),
  userPrompt: text("user_prompt").notNull(),
  status: text("status").notNull().default("pending"),
  currentStep: text("current_step").default("init"),
  pipelineVersion: text("pipeline_version").default("cascade-v1"),
  agentsUsed: text("agents_used", { mode: "json" }).$type<string[]>(),
  iterationsUsed: integer("iterations_used").default(0),
  // Test mode: when running a pipeline for testing/marketplace review purposes
  isTestRun: integer("is_test_run", { mode: "boolean" }).default(false),
  testFixtureId: integer("test_fixture_id"), // References a test fixture ZIP if applicable
  finalResponseId: integer("final_response_id"),
  totalTokensUsed: integer("total_tokens_used"),
  totalLatencyMs: integer("total_latency_ms"),
  // For resumable pipeline execution (human-in-the-loop, etc.)
  executionState: text("execution_state", { mode: "json" }).$type<{
    currentIndex: number;
    chain: Array<{ id: number; content: string; agentRole: string; agentName: string }>;
    iterationCounts: Record<number, number>;
    modifyInstructions?: string;
    pendingApproval?: {
      stepOrder: number;
      lastOutput: string;
      action?: "approve" | "reject" | "modify";
      instructions?: string;
    };
  } | null>(),
  // Worker rehydration payload (F0.5): the original execute/resume request,
  // persisted so the pipeline worker can rebuild the run after a crash/deploy.
  runParams: text("run_params", { mode: "json" }).$type<{
    source: "execute" | "resumePipeline";
    prompt: string;
    giteeTokenEnc?: string; // encrypted with the master key
    memoryMode?: string;
    attachments?: unknown[];
    includeProjectFiles?: boolean;
    autoApprove?: boolean;
    clientTraceId?: string;
    // Research Mode: pipeline chaining
    stateless?: boolean;
    chain?: {
      targetProjectId: number;
      inputTemplate?: string;
      depth: number;
      lineage: number[];
    };
    // Offering redesign v2: execute an immutable workflow-version snapshot
    // instead of the mutable project steps (benchmark candidates, P3
    // protected runs). callPlanId links back to the benchmark for ledger
    // traceability.
    snapshotVersionId?: number;
    callPlanId?: number;
    /** §8.1 protected (non-owner) execution context. Typed loosely here
     *  because this module must not import from api/; `swarmService` casts it
     *  to its own SwarmRunParams, and nothing is trusted from this blob — the
     *  right is re-resolved from current rows before a single call is made. */
    protectedRun?: object;
    /** A pipeline ONE ACCOUNT shared with another (api/services/
     *  pipelineSharing.ts): the grant that authorized this run, recorded so the
     *  read surfaces can apply the same redaction they apply to a buyer run.
     *  Nothing is trusted from this blob — the grant row is re-read before a
     *  single provider call, so a revoked share stops an already-queued run. */
    sharedRun?: object;
  } | null>(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).defaultNow(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  // Batch membership (Research Mode): NULL = standalone run
  batchId: integer("batch_id"),
  error: text("error"),
}, (table) => ({
  projectIdIdx: index("idx_swarm_runs_project_id").on(table.projectId),
  userIdIdx: index("idx_swarm_runs_user_id").on(table.userId),
  statusIdx: index("idx_swarm_runs_status").on(table.status),
  batchIdIdx: index("idx_swarm_runs_batch_id").on(table.batchId),
}));

// ─── SWARM BATCHES (Research Mode: batch run groups) ───────────────
export const swarmBatches = sqliteTable("swarm_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name"),
  status: text("status").notNull().default("running"),
  totalRuns: integer("total_runs").notNull(),
  completedRuns: integer("completed_runs").notNull().default(0),
  failedRuns: integer("failed_runs").notNull().default(0),
  totalTokensUsed: integer("total_tokens_used").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
}, (table) => ({
  userIdIdx: index("idx_swarm_batches_user_id").on(table.userId),
  projectIdIdx: index("idx_swarm_batches_project_id").on(table.projectId),
  statusIdx: index("idx_swarm_batches_status").on(table.status),
}));

// ─── AGENT RUNS ────────────────────────────────────────────────────
export const agentRuns = sqliteTable("agent_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  swarmRunId: integer("swarm_run_id")
    .references(() => swarmRuns.id, { onDelete: "cascade" })
    .notNull(),
  agentId: integer("agent_id"), // References custom_agents.id (no FK — legacy agents table may not have the agent)
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  agentName: text("agent_name").notNull(),
  agentRole: text("agent_role").notNull(),
  pipelineStep: integer("pipeline_step").notNull(),
  iteration: integer("iteration").default(1),
  systemPrompt: text("system_prompt"),
  userPrompt: text("user_prompt").notNull(),
  contextInput: text("context_input"),
  status: text("status").notNull().default("pending"),
  tokensUsed: integer("tokens_used"),
  latencyMs: integer("latency_ms"),
  modelUsed: text("model_used"),
  providerUsed: text("provider_used"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).defaultNow(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
}, (table) => ({
  swarmRunIdIdx: index("idx_agent_runs_swarm_run_id").on(table.swarmRunId),
  projectIdIdx: index("idx_agent_runs_project_id").on(table.projectId),
}));

// ─── AGENT RESPONSES ───────────────────────────────────────────────
const agentResponsesTable = sqliteTable("agent_responses", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  agentRunId: integer("agent_run_id")
    .references(() => agentRuns.id, { onDelete: "cascade" })
    .notNull(),
  swarmRunId: integer("swarm_run_id")
    .references(() => swarmRuns.id, { onDelete: "cascade" })
    .notNull(),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  parentResponseId: integer("parent_response_id"),
  responseType: text("response_type").notNull(),
  content: text("content").notNull(),
  metadata: text("metadata", { mode: "json" }).$type<{
    model: string;
    provider: string;
    providerSlug: string;
    // `complete` is absent on rows written before the usage-provenance fix:
    // their zeros may be a provider that never reported usage, so readers must
    // treat a missing flag as UNKNOWN, not as measured zero.
    tokensUsed: { prompt: number; completion: number; total: number; complete?: boolean };
    latencyMs: number;
    temperature: number;
    maxTokens: number;
    topP?: number;
    agentName: string;
    agentRole: string;
    agentSlug: string;
    pipelineStep: number;
    iteration: number;
    buildMethod: string;
    sourceResponseIds: number[];
    qualityScore?: number;
    humanRating?: number;
  }>().notNull(),
  humanReviewed: integer("human_reviewed", { mode: "boolean" }).default(false),
  humanNotes: text("human_notes"),
  isFlagged: integer("is_flagged", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
}, (table) => ({
  swarmRunIdIdx: index("idx_agent_responses_swarm_run_id").on(table.swarmRunId),
  agentRunIdIdx: index("idx_agent_responses_agent_run_id").on(table.agentRunId),
  projectIdIdx: index("idx_agent_responses_project_id").on(table.projectId),
}));

export { agentResponsesTable as agentResponses };

// ─── DEBUG LOGS ────────────────────────────────────────────────────
export const debugLogs = sqliteTable("debug_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  swarmRunId: integer("swarm_run_id")
    .references(() => swarmRuns.id, { onDelete: "cascade" })
    .notNull(),
  agentRunId: integer("agent_run_id")
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  promptId: text("prompt_id").notNull(),
  agentName: text("agent_name").notNull(),
  eventType: text("event_type").notNull(),
  payload: text("payload", { mode: "json" }).$type<{
    message: string;
    details?: Record<string, unknown>;
    latencyMs?: number;
    tokensUsed?: number;
  }>().notNull(),
  timestamp: integer("timestamp", { mode: "timestamp_ms" }).defaultNow(),
}, (table) => ({
  swarmRunIdIdx: index("idx_debug_logs_swarm_run_id").on(table.swarmRunId),
  projectIdIdx: index("idx_debug_logs_project_id").on(table.projectId),
}));

// ─── PROJECT FILES ─────────────────────────────────────────────────
export const projectFiles = sqliteTable("project_files", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  path: text("path").notNull(),
  name: text("name").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  content: text("content"), // Text content for AI reading
  isDirectory: integer("is_directory", { mode: "boolean" }).default(false),
  parentPath: text("parent_path"),
  giteeSha: text("gitee_sha"),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow(),
}, (table) => ({
  projectIdIdx: index("idx_project_files_project_id").on(table.projectId),
  pathIdx: index("idx_project_files_path").on(table.projectId, table.path),
}));

// ─── PROJECT FILE CONTENTS (local storage for fast LLM access) ─────
// Stores full text content of imported project files.
// Used by Phase 2: the LLM sees the Intelligence Card, requests specific
// files by path, and we fetch their contents from this table (no Gitee round-trip).
export const projectFileContents = sqliteTable("project_file_contents", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  path: text("path").notNull(),
  content: text("content").notNull(), // Full file text content
  sizeBytes: integer("size_bytes"),
  language: text("language"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
});

// ─── FILE DEPENDENCIES (cross-file awareness) ──────────────────────
export const fileDependencies = sqliteTable("file_dependencies", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  sourceFileId: integer("source_file_id").notNull(),
  targetFileId: integer("target_file_id").notNull(),
  importType: text("import_type"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
}, (table) => ({
  sourceFileIdx: index("idx_file_deps_source").on(table.sourceFileId),
  targetFileIdx: index("idx_file_deps_target").on(table.targetFileId),
}));

// ─── API KEY STORE ─────────────────────────────────────────────────
export const apiKeyStore = sqliteTable("api_key_store", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  providerSlug: text("provider_slug").notNull(),
  encryptedKey: text("encrypted_key").notNull(),
  salt: text("salt").notNull(),
  iterations: integer("iterations").default(480000),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
});

// ─── CUSTOM AGENTS (Pro Designer: user's reusable agent library) ───
export const customAgents = sqliteTable("custom_agents", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  role: text("role").notNull(), // builder, critic, reviewer, refiner, translator, summarizer, custom
  systemPrompt: text("system_prompt").notNull(),
  defaultProviderId: integer("default_provider_id")
    .references(() => llmProviders.id),
  defaultModel: text("default_model"),
  temperature: text("temperature").default("0.7"),
  maxTokens: integer("max_tokens").default(4096),
  description: text("description"), // What this agent does (shown in UI)
  isTemplate: integer("is_template", { mode: "boolean" }).default(false), // Pre-built templates users can clone
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
}, (table) => ({
  userIdIdx: index("idx_custom_agents_user_id").on(table.userId),
  slugIdx: index("idx_custom_agents_slug").on(table.userId, table.slug),
}));

// ─── PIPELINE STEPS (Pro Designer: per-project agent sequence) ─────
export const pipelineSteps = sqliteTable("pipeline_steps", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  stepOrder: integer("step_order").notNull(), // 1, 2, 3, ... execution order
  agentId: integer("agent_id")
    .references(() => customAgents.id, { onDelete: "cascade" }),
  // Step type: agent (normal), if (conditional branch), while (loop), approval (human-in-the-loop)
  stepType: text("step_type").default("agent").notNull(),
  providerId: integer("provider_id")
    .references(() => llmProviders.id), // Override: which LLM to use for this step
  model: text("model"), // Override: which specific model to use
  name: text("name").notNull(), // Display name
  role: text("role").notNull(),
  systemPrompt: text("system_prompt").notNull(), // Can be customized per pipeline
  temperature: text("temperature").default("0.7"),
  maxTokens: integer("max_tokens").default(4096),
  parameters: text("parameters", { mode: "json" }).$type<Record<string, unknown> | null>(),
  // For IF steps: { options: ["polish","rewrite"], mappings: { "polish": 4, "rewrite": 2 } }
  ifConfig: text("if_config", { mode: "json" }).$type<{ options: string[]; mappings: Record<string, number> } | null>(),
  // For WHILE steps: { targetStep: 2, maxIterations: 3 }
  whileConfig: text("while_config", { mode: "json" }).$type<{ targetStep: number; maxIterations: number } | null>(),
  isEnabled: integer("is_enabled", { mode: "boolean" }).default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
}, (table) => ({
  projectIdIdx: index("idx_pipeline_steps_project_id").on(table.projectId),
  orderIdx: index("idx_pipeline_steps_order").on(table.projectId, table.stepOrder),
}));

// ─── PIPELINE TEMPLATES (reusable pipelines across chats) ──────────
export const pipelineTemplates = sqliteTable("pipeline_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  description: text("description"),
  steps: text("steps", { mode: "json" }).$type<Array<{
    name: string;
    role: string;
    systemPrompt: string;
    stepType?: string;
    ifConfig?: { options: string[]; mappings: Record<string, number> } | null;
    whileConfig?: { targetStep: number; maxIterations: number } | null;
    providerId?: number | null;
    model?: string | null;
    temperature?: string;
    maxTokens?: number;
  }>>().notNull(),
  isAuto: integer("is_auto", { mode: "boolean" }).default(false).notNull(),
  sourceProjectId: integer("source_project_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
});

// ═════════════════════════════════════════════════════════════════════
// MARKETPLACE MODULE
// ═════════════════════════════════════════════════════════════════════

// ─── MARKETPLACE LISTINGS ──────────────────────────────────────────
export const marketplaceListings = sqliteTable("marketplace_listings", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  creatorId: integer("creator_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  templateId: integer("template_id")
    .references(() => pipelineTemplates.id, { onDelete: "cascade" })
    .notNull(),
  title: text("title").notNull(),
  description: text("description"),
  // Structured description fields for better test generation & reviewer clarity
  objectives: text("objectives"),        // What the pipeline aims to accomplish
  inputFormat: text("input_format"),      // Expected format of user input
  outputFormat: text("output_format"),    // Expected format of pipeline output
  remarks: text("remarks"),               // Additional notes for reviewers
  category: text("category", { enum: ["translation", "writing", "code", "analysis", "creative", "other",] }).default("other"),
  price: text("price").notNull(),
  isSubscription: integer("is_subscription", { mode: "boolean" }).default(false),
  subscriptionPrice: text("subscription_price"),
  status: text("status", { enum: ["draft", "generating", "pending_review", "reviewing", "certifying", "rejected", "approved", "published", "unpublished",] }).default("draft"),
  grade: text("grade"),
  reviewCount: integer("review_count").default(0),
  kappaScore: text("kappa_score"),
  aiCorrelation: text("ai_correlation"),
  // AI Ensemble Review (Phase 1: automated certification before human review)
  aiGrade: text("ai_grade"),
  aiKappaScore: text("ai_kappa_score"),
  aiFeedback: text("ai_feedback"),
  aiReviewedAt: integer("ai_reviewed_at", { mode: "timestamp_ms" }),
  // Set when blind human review certifies the listing into `published` (spec 0.8).
  // Joined later against refunds/reports to tune triage floor and thresholds.
  certifiedAt: integer("certified_at", { mode: "timestamp_ms" }),
  salesCount: integer("sales_count").default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().$onUpdate(() => new Date()),
});

// ─── TEST PROMPTS (auto-generated for each listing) ────────────────
export const testPrompts = sqliteTable("test_prompts", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  listingId: integer("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  promptIndex: integer("prompt_index").notNull(),
  category: text("category", { enum: ["simple", "medium", "complex", "edge", "adversarial"] }).notNull(),
  inputText: text("input_text").notNull(),
  actualOutput: text("actual_output"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
});

// ─── LISTING REVIEWS (human reviews) ───────────────────────────────
export const listingReviews = sqliteTable("listing_reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  listingId: integer("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  reviewerId: integer("reviewer_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  promptIndex: integer("prompt_index").notNull(),
  accuracy: integer("accuracy").notNull(),
  completeness: integer("completeness").notNull(),
  clarity: integer("clarity").notNull(),
  tokenEfficiency: integer("token_efficiency").notNull(),
  speed: integer("speed").notNull(),
  consistency: integer("consistency").notNull(),
  weightedScore: text("weighted_score").notNull(),
  reviewTime: integer("review_time").notNull(), // seconds spent
  flagged: integer("flagged", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
});

// ─── AI ENSEMBLE REVIEWS ───────────────────────────────────────────
export const aiEnsembleReviews = sqliteTable("ai_ensemble_reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  listingId: integer("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  promptIndex: integer("prompt_index").notNull(),
  providerId: integer("provider_id")
    .references(() => llmProviders.id, { onDelete: "cascade" }),
  modelSlug: text("model_slug"),
  accuracy: integer("accuracy"),
  completeness: integer("completeness"),
  clarity: integer("clarity"),
  tokenEfficiency: integer("token_efficiency"),
  speed: integer("speed"),
  consistency: integer("consistency"),
  weightedScore: text("weighted_score"),
  rawResponse: text("raw_response"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
});

// ─── REVIEWER PROFILES ─────────────────────────────────────────────
export const reviewerProfiles = sqliteTable("reviewer_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  trustScore: integer("trust_score").default(100),
  reviewsCompleted: integer("reviews_completed").default(0),
  reviewsFlagged: integer("reviews_flagged").default(0),
  arbiterRulingsAgainst: integer("arbiter_rulings_against").default(0),
  // Points system (MVP: reviewers earn points → redeem for subscription days)
  pointsEarned: integer("points_earned").default(0),
  pointsBalance: integer("points_balance").default(0),
  // Subscription days earned from point redemption
  subscriptionDays: integer("subscription_days").default(0),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  status: text("status", { enum: ["active", "suspended", "banned"] }).default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().$onUpdate(() => new Date()),
});

// ─── REVIEW ASSIGNMENTS ────────────────────────────────────────────
export const reviewAssignments = sqliteTable("review_assignments", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  listingId: integer("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  reviewerId: integer("reviewer_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  status: text("status", { enum: ["pending", "in_progress", "completed", "overdue"] }).default("pending"),
  assignedAt: integer("assigned_at", { mode: "timestamp_ms" }).defaultNow(),
  dueAt: integer("due_at", { mode: "timestamp_ms" }),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

// ─── BLIND REVIEW TASKS (spec 0.5 — anonymized per-prompt review pool) ──
// When a listing enters `certifying`, one pooled row is enqueued per test
// prompt. Reviewers CLAIM tasks via getNextReviewTask; the listingId is
// SERVER-ONLY and is never serialized to the client (blind review).
//
// Status interpretation (spec says "do NOT pre-assign"; reconciled design):
//   pooled    — in the pool, unassigned (reviewerId NULL). This is the state
//               rows are created in; the spec's default 'assigned' is split
//               into pooled→assigned so "unassigned" is representable.
//   assigned  — claimed by a reviewer (reviewerId set, assignedAt set)
//   completed — review submitted via submitReviewTask
//   expired   — claimed but never completed (reserved for a later sweeper)
//
// NOTE (MySQL): unique indexes treat NULLs as distinct, so the
// (listing_id, prompt_index, reviewer_id) unique index does NOT dedupe
// pooled rows (reviewer_id NULL). Pooled-row idempotency is enforced in
// code by enqueueBlindReviewTasks(); the index still prevents one reviewer
// being assigned the same (listing, prompt) twice.
export const blindReviewTasks = sqliteTable("blind_review_tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  listingId: integer("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  promptIndex: integer("prompt_index").notNull(),
  reviewerId: integer("reviewer_id")
    .references(() => users.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["pooled", "assigned", "completed", "expired"] }).default("pooled"),
  assignedAt: integer("assigned_at", { mode: "timestamp_ms" }),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
}, (table) => ({
  listingPromptReviewerUniq: uniqueIndex("uq_blind_review_tasks_listing_prompt_reviewer")
    .on(table.listingId, table.promptIndex, table.reviewerId),
  poolIdx: index("idx_blind_review_tasks_pool").on(table.status, table.listingId),
}));

// ─── CREATOR DEPOSITS (review cost tracking) ──────────────────────
export const creatorDeposits = sqliteTable("creator_deposits", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  creatorId: integer("creator_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  listingId: integer("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  depositType: text("deposit_type", { enum: ["ai_test", "human_review"] }).notNull(),
  amount: text("amount").notNull(),
  tokensUsed: integer("tokens_used"),
  status: text("status", { enum: ["pending", "completed", "refunded", "partial_refund"] }).default("pending"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

// ─── REFUND LEDGER ─────────────────────────────────────────────────
export const refundLedger = sqliteTable("refund_ledger", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  creatorId: integer("creator_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  listingId: integer("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  depositId: integer("deposit_id")
    .references(() => creatorDeposits.id, { onDelete: "cascade" })
    .notNull(),
  saleId: integer("sale_id").notNull(),
  commissionEarned: text("commission_earned").notNull(),
  amountRefunded: text("amount_refunded").notNull(),
  isFullyRefunded: integer("is_fully_refunded", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
});

// ─── MARKETPLACE PURCHASES ─────────────────────────────────────────
export const marketplacePurchases = sqliteTable("marketplace_purchases", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  buyerId: integer("buyer_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  listingId: integer("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  amountPaid: text("amount_paid").notNull(),
  platformFee: text("platform_fee").notNull(),
  creatorEarnings: text("creator_earnings").notNull(),
  isSubscription: integer("is_subscription", { mode: "boolean" }).default(false),
  subscriptionEnd: integer("subscription_end", { mode: "timestamp_ms" }),
  status: text("status", { enum: ["active", "refunded", "cancelled"] }).default("active"),
  // Stripe references (Phase 1): fulfillment + refund matching
  stripeSessionId: text("stripe_session_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  workflowVersionId: integer("workflow_version_id"),
  evidencePublicationId: integer("evidence_publication_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
}, (table) => ({
  versionFk: foreignKey({ name: "fk_purchase_workflow_version", columns: [table.workflowVersionId], foreignColumns: [pipelineVersions.id] }).onDelete("restrict"),
  evidenceFk: foreignKey({ name: "fk_purchase_evidence_publication", columns: [table.evidencePublicationId], foreignColumns: [evidencePublications.id] }).onDelete("restrict"),
}));

// ─── TEST PROMPT INTERMEDIATE RESPONSES ──────────────────────────
// Stores every agent step's output for every test prompt run
export const testPromptIntermediate = sqliteTable("test_prompt_intermediate", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  testPromptId: integer("test_prompt_id")
    .references(() => testPrompts.id, { onDelete: "cascade" })
    .notNull(),
  stepIndex: integer("step_index").notNull(),         // which pipeline step (0, 1, 2...)
  stepName: text("step_name").notNull(),
  stepRole: text("step_role"),
  inputText: text("input_text").notNull(),         // what this agent received
  outputText: text("output_text").notNull(),       // what this agent produced
  tokensUsed: integer("tokens_used"),                  // token count if available
  latencyMs: integer("latency_ms"),                    // response time
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
});

// ─── ENCRYPTED PROMPTS ─────────────────────────────────────────────
export const encryptedPrompts = sqliteTable("encrypted_prompts", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  listingId: integer("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  agentIndex: integer("agent_index").notNull(),
  encryptedPrompt: text("encrypted_prompt").notNull(),
  iv: text("iv").notNull(),
  version: integer("version").default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
});

// ═══════════════════════════════════════════════════════════════════════
// TEAM & BETA TESTING SYSTEM
// ═══════════════════════════════════════════════════════════════════════

// ─── TEAMS ───────────────────────────────────────────────────────────
export const teams = sqliteTable("teams", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: integer("owner_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  inviteCode: text("invite_code").unique(),
  inviteQrUrl: text("invite_qr_url"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
});

// ─── TEAM MEMBERS ────────────────────────────────────────────────────
export const teamMembers = sqliteTable("team_members", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  teamId: integer("team_id")
    .references(() => teams.id, { onDelete: "cascade" })
    .notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  role: text("role", { enum: ["owner", "admin", "tester", "viewer"] })
    .default("tester")
    .notNull(),
  joinedAt: integer("joined_at", { mode: "timestamp_ms" }).defaultNow(),
  lastActiveAt: integer("last_active_at", { mode: "timestamp_ms" }).defaultNow(),
  engagementScore: integer("engagement_score").default(0),
}, (table) => ({
  userIdIdx: index("idx_team_members_user_id").on(table.userId),
  teamIdIdx: index("idx_team_members_team_id").on(table.teamId),
  teamUserUniq: uniqueIndex("uq_team_members_team_user").on(table.teamId, table.userId),
}));

// ─── TEAM PROJECTS (shared projects) ─────────────────────────────────
export const teamProjects = sqliteTable("team_projects", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  teamId: integer("team_id")
    .references(() => teams.id, { onDelete: "cascade" })
    .notNull(),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  addedBy: integer("added_by")
    .references(() => users.id)
    .notNull(),
  addedAt: integer("added_at", { mode: "timestamp_ms" }).defaultNow(),
}, (table) => ({
  teamIdIdx: index("idx_team_projects_team_id").on(table.teamId),
  projectIdIdx: index("idx_team_projects_project_id").on(table.projectId),
  teamProjectUniq: uniqueIndex("uq_team_projects_team_project").on(table.teamId, table.projectId),
}));

// ─── TEST FIXTURES (reusable test project ZIPs for pipeline testing) ──
// Users/teams upload ZIPs here once; pipelines reference them during test runs.
export const testFixtures = sqliteTable("test_fixtures", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  teamId: integer("team_id")
    .references(() => teams.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  // Complexity tag — helps match pipelines to appropriate test projects
  complexity: text("complexity", { enum: ["easy", "medium", "complex"] }).default("medium"),
  // Where the ZIP is stored (disk path under data/test-fixtures/<id>.zip)
  storagePath: text("storage_path").notNull(),
  sizeBytes: integer("size_bytes"),
  fileCount: integer("file_count").default(0),
  // Optional Gitee mirror path for syncing with team
  giteePath: text("gitee_path"),
  isPublic: integer("is_public", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
}, (table) => ({
  userIdIdx: index("idx_test_fixtures_user_id").on(table.userId),
  teamIdIdx: index("idx_test_fixtures_team_id").on(table.teamId),
}));

// ─── USER PRIVACY CONSENT ────────────────────────────────────────────
export const userPrivacyConsent = sqliteTable("user_privacy_consent", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  allowPromptStorage: integer("allow_prompt_storage", { mode: "boolean" }).default(true),
  allowFeedbackStorage: integer("allow_feedback_storage", { mode: "boolean" }).default(true),
  allowScreenshots: integer("allow_screenshots", { mode: "boolean" }).default(true),
  allowConversationHistory: integer("allow_conversation_history", { mode: "boolean" }).default(false),
  consentedAt: integer("consented_at", { mode: "timestamp_ms" }).defaultNow(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().$onUpdate(() => new Date()),
});

// ─── FEEDBACK (messages + general UI feedback) ───────────────────────
export const feedback = sqliteTable("feedback", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  teamId: integer("team_id")
    .references(() => teams.id, { onDelete: "cascade" }),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" }),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  targetType: text("target_type", { enum: ["message", "ui", "general"] })
    .default("general")
    .notNull(),
  targetMessageId: integer("target_message_id"),
  feedbackType: text("feedback_type", { enum: ["bug", "suggestion", "praise", "confusion"] })
    .notNull(),
  severity: text("severity", { enum: ["critical", "major", "minor", "cosmetic"] })
    .default("minor"),
  content: text("content").notNull(),
  screenshotUrl: text("screenshot_url"),
  contextJson: text("context_json", { mode: "json" }).$type<{
    url?: string;
    browser?: string;
    os?: string;
    consoleLogs?: string[];
    activePipeline?: string;
    activeStep?: string;
    modelUsed?: string;
    tokenCount?: number;
    latencyMs?: number;
  } | null>(),
  tagsJson: text("tags_json", { mode: "json" }).$type<string[] | null>(),
  status: text("status", { enum: ["new", "triaged", "in_progress", "resolved", "verified", "closed"] })
    .default("new")
    .notNull(),
  assignedTo: integer("assigned_to")
    .references(() => users.id),
  convertedToIssueId: integer("converted_to_issue_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
}, (table) => ({
  teamIdIdx: index("idx_feedback_team_id").on(table.teamId),
  projectIdIdx: index("idx_feedback_project_id").on(table.projectId),
  userIdIdx: index("idx_feedback_user_id").on(table.userId),
  statusIdx: index("idx_feedback_status").on(table.status),
}));

// ─── CONSENTED FEEDBACK ATTACHMENTS (D11, ticket #22) ────────────────
// "Send feedback about THIS pipeline / run / benchmark" — one opt-in per
// object, never a harvest. Nothing is written here automatically: every row
// exists because the author ticked that one item and the row records WHICH
// consent text they ticked (`consent_version`, stamped server-side from
// `DEFAULT_CONSENT_VERSION` in api/services/evidenceService.ts, so a client
// cannot claim an older or a made-up one). A missing consent is refused in
// api/services/feedbackAttachments.ts, not defaulted.
//
// `snapshot` is the whole point and the whole risk. It is a FROZEN COPY taken
// at submit time through the SAME projections the author already reads
// (`pipelineSharing.getSharedWorkflow`, `runAccess.projectRunDetail`,
// `pipelineSharing.getSharedRunView`, `marketplaceExecutionService
// .getProtectedRunView`, `benchmarkService.getBenchmarkProgress`) — never a
// fresh join on `agentRuns`/`pipelineSteps` invented here. So an attachment can
// never widen what its author is entitled to: an owned object carries the real
// detail, a `run_only` share or a marketplace buyer run carries the redacted
// view that run's own owner already sees, and spec A12's promise (another
// account's prompt text does not reach an unentitled account) survives the
// feedback path exactly as it survives export, debug and the response chain.
export const feedbackAttachments = sqliteTable("feedback_attachments", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  // Cascade WITH the feedback item and only that way: an attachment is a
  // receipt attached to one feedback row, and deleting the feedback ends its
  // purpose. It never reaches back into the attached object — that object is
  // the user's pipeline/run/benchmark row and stays exactly where it is.
  feedbackId: integer("feedback_id")
    .references(() => feedback.id, { onDelete: "cascade" })
    .notNull(),
  // The consenting author. Same account rules the read back: an attachment is
  // visible to the account that consented to it (and to support).
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  // The three objects this product actually has: a pipeline (a project and its
  // steps), a run of one, and a benchmark. No fourth kind, and nothing here
  // about teams, workspaces or orgs — those concepts are deleted.
  kind: text("kind", { enum: ["pipeline", "run", "benchmark"] }).notNull(),
  // The object's own id: `projects.id`, `swarm_runs.id` or `benchmarks.id`.
  // Deliberately NOT a foreign key: the consent is to the SNAPSHOT, and the
  // receipt must still be readable after the user deletes the object it
  // describes. An FK here would either cascade into the feedback row or block
  // a legitimate delete, and neither is what a feedback receipt means.
  refId: integer("ref_id").notNull(),
  consentVersion: text("consent_version").notNull(),
  // Canonical JSON snapshot (same storage choice as `pipeline_versions
  // .definition`: a frozen blob that can legitimately be large).
  snapshot: text("snapshot").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  feedbackIdx: index("idx_feedback_attachments_feedback_id").on(table.feedbackId),
  userIdIdx: index("idx_feedback_attachments_user_id").on(table.userId),
  // "which objects has this feedback been about?" — the support-side lookup.
  kindRefIdx: index("idx_feedback_attachments_kind_ref").on(table.kind, table.refId),
}));

export type FeedbackAttachment = typeof feedbackAttachments.$inferSelect;
export type InsertFeedbackAttachment = typeof feedbackAttachments.$inferInsert;

// ─── ISSUES (derived from feedback or created manually) ──────────────
export const issues = sqliteTable("issues", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  teamId: integer("team_id")
    .references(() => teams.id, { onDelete: "cascade" }),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  priority: text("priority", { enum: ["p0", "p1", "p2", "p3"] })
    .default("p2")
    .notNull(),
  status: text("status", { enum: ["open", "in_progress", "resolved", "verified", "closed"] })
    .default("open")
    .notNull(),
  assigneeId: integer("assignee_id")
    .references(() => users.id),
  relatedFeedbackIdsJson: text("related_feedback_ids_json", { mode: "json" }).$type<number[] | null>(),
  resolutionNotes: text("resolution_notes"),
  createdBy: integer("created_by")
    .references(() => users.id)
    .notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
}, (table) => ({
  teamIdIdx: index("idx_issues_team_id").on(table.teamId),
  projectIdIdx: index("idx_issues_project_id").on(table.projectId),
  statusIdx: index("idx_issues_status").on(table.status),
}));

// ─── FIX VERIFICATIONS ───────────────────────────────────────────────
export const fixVerifications = sqliteTable("fix_verifications", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  issueId: integer("issue_id")
    .references(() => issues.id, { onDelete: "cascade" })
    .notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  status: text("status", { enum: ["pending", "verified", "failed"] })
    .default("pending")
    .notNull(),
  testerComment: text("tester_comment"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
  verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
});

// ─── ACTIVITY LOG (for engagement scoring) ───────────────────────────
export const activityLog = sqliteTable("activity_log", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  teamId: integer("team_id")
    .references(() => teams.id, { onDelete: "cascade" }),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" }),
  action: text("action", { enum: ["sent_message", "gave_feedback", "ran_pipeline", "imported_project", "viewed_dashboard", "created_issue", "verified_fix",] }).notNull(),
  metadataJson: text("metadata_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
}, (table) => ({
  userIdIdx: index("idx_activity_log_user_id").on(table.userId),
  teamIdIdx: index("idx_activity_log_team_id").on(table.teamId),
}));

// ─── CHANGELOG ENTRIES ───────────────────────────────────────────────
export const changelogEntries = sqliteTable("changelog_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  teamId: integer("team_id")
    .references(() => teams.id, { onDelete: "cascade" })
    .notNull(),
  title: text("title").notNull(),
  description: text("description"),
  relatedIssueIdsJson: text("related_issue_ids_json", { mode: "json" }).$type<number[] | null>(),
  releasedAt: integer("released_at", { mode: "timestamp_ms" }).defaultNow(),
});

// ─── FEATURE FLAGS ───────────────────────────────────────────────────
// Enables modular architecture: features can be toggled per-deployment,
// per-user, or rolled out gradually. Used by the plugin system.
export const featureFlags = sqliteTable("feature_flags", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  key: text("key").notNull().unique(),   // e.g. "circuit_breaker"
  name: text("name").notNull(),         // human-readable
  description: text("description"),
  enabled: integer("enabled", { mode: "boolean" }).default(false).notNull(),     // master switch
  rolloutPercent: integer("rollout_percent").default(0),        // 0=off, 100=all
  allowedUserIds: text("allowed_user_ids", { mode: "json" }).$type<number[] | null>(), // beta testers
  pluginId: text("plugin_id"),           // links to plugin
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().$onUpdate(() => new Date()),
});

// ─── VOUCHERS (beta tester tier access) ─────────────────────────────
export const vouchers = sqliteTable("vouchers", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  code: text("code").notNull().unique(),
  tier: text("tier", { enum: ["pro_designer", "pro_auto"] }).notNull(),
  durationDays: integer("duration_days").notNull().default(30),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  label: text("label"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdBy: integer("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
});

// ─── NOTIFICATIONS ──────────────────────────────────────────────────
export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  type: text("type").notNull(), // pipeline_complete, pipeline_error, team_invite, etc.
  title: text("title").notNull(),
  message: text("message"),
  dataJson: text("data_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
  isRead: integer("is_read", { mode: "boolean" }).default(false).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow(),
}, (table) => ({
  userIdIdx: index("idx_notifications_user_id").on(table.userId),
  unreadIdx: index("idx_notifications_unread").on(table.userId, table.isRead),
}));

export type FeatureFlag = typeof featureFlags.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════
// FOUNDATION SPRINT (F0) — billing, entitlements, usage, tokens
// ═══════════════════════════════════════════════════════════════════════

// ─── SUBSCRIPTIONS (Stripe-backed; user or team scope) ──────────────
export const subscriptions = sqliteTable("subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  teamId: integer("team_id").references(() => teams.id, { onDelete: "cascade" }),
  plan: text("plan").notNull(),
  status: text("status").notNull().default("active"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  seats: integer("seats").default(1).notNull(),
  currentPeriodEnd: integer("current_period_end", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  userIdIdx: index("idx_subscriptions_user_id").on(table.userId),
  teamIdIdx: index("idx_subscriptions_team_id").on(table.teamId),
}));

// ─── ENTITLEMENTS (the single "can user X do Y" source) ─────────────
export const entitlements = sqliteTable("entitlements", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  subjectType: text("subject_type", { enum: ["user", "team"] }).notNull(),
  subjectId: integer("subject_id").notNull(),
  capability: text("capability").notNull(),
  source: text("source", { enum: ["tier", "subscription", "voucher", "purchase", "manual"] }).notNull(),
  sourceRef: text("source_ref"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  subjectCapabilityIdx: index("idx_entitlements_subject_capability").on(table.subjectId, table.capability),
}));

// ─── USAGE COUNTERS (per-subject metering, monthly periods) ─────────
export const usageCounters = sqliteTable("usage_counters", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  subjectId: integer("subject_id").notNull(),
  metric: text("metric").notNull(),
  period: text("period").notNull(), // yyyymm
  count: integer("count").default(0).notNull(),
}, (table) => ({
  subjectMetricPeriodUniq: uniqueIndex("uq_usage_counters_subject_metric_period").on(table.subjectId, table.metric, table.period),
}));

// ─── IDEMPOTENCY KEYS (webhooks, checkout, external events) ─────────
export const idempotencyKeys = sqliteTable("idempotency_keys", {
  key: text("key").primaryKey().notNull(),
  scope: text("scope").notNull(),
  responseHash: text("response_hash"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  createdAtIdx: index("idx_idempotency_keys_created_at").on(table.createdAt),
}));

// ─── OAUTH REFRESH TOKENS (opaque, SHA-256 hashed at rest) ──────────
export const oauthRefreshTokens = sqliteTable("oauth_refresh_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  clientId: text("client_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  scopes: text("scopes", { mode: "json" }).$type<string[]>(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("idx_oauth_refresh_tokens_user_id").on(table.userId),
}));

// ─── VOUCHER REDEMPTIONS (per-user voucher usage + expiry) ──────────
export const voucherRedemptions = sqliteTable("voucher_redemptions", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  voucherId: integer("voucher_id")
    .references(() => vouchers.id, { onDelete: "cascade" })
    .notNull(),
  tier: text("tier").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("idx_voucher_redemptions_user_id").on(table.userId),
  voucherIdIdx: index("idx_voucher_redemptions_voucher_id").on(table.voucherId),
}));

// ═══════════════════════════════════════════════════════════════════════
// COMPANION MCP SERVER (F0) — OAuth 2.1 clients/codes + MCP audit log
// ═══════════════════════════════════════════════════════════════════════

// ─── OAUTH CLIENTS (RFC 7591 dynamic client registration) ───────────
export const oauthClients = sqliteTable("oauth_clients", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  clientId: text("client_id").notNull().unique(),
  clientName: text("client_name"),
  redirectUris: text("redirect_uris", { mode: "json" }).$type<string[]>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
});

// ─── OAUTH AUTHORIZATION CODES (auth code + PKCE, SHA-256 hashed) ───
export const oauthAuthCodes = sqliteTable("oauth_auth_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  codeHash: text("code_hash").notNull().unique(),
  clientId: text("client_id").notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  redirectUri: text("redirect_uri"),
  codeChallenge: text("code_challenge"),
  codeChallengeMethod: text("code_challenge_method"),
  scopes: text("scopes", { mode: "json" }).$type<string[]>(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  clientIdIdx: index("idx_oauth_auth_codes_client_id").on(table.clientId),
}));

// ─── MCP AUDIT LOG (one row per tool call: latency + status) ────────
export const mcpAuditLog = sqliteTable("mcp_audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  clientId: text("client_id").notNull(),
  toolName: text("tool_name").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  status: text("status").notNull(),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("idx_mcp_audit_log_user_id").on(table.userId),
  createdAtIdx: index("idx_mcp_audit_log_created_at").on(table.createdAt),
}));

// ═══════════════════════════════════════════════════════════════════════
// TEAMSYNC (Phase 2) — seat billing, memory locking, approval handoffs
// ═══════════════════════════════════════════════════════════════════════

// ─── TEAM SEATS (seat billing state per team) ───────────────────────
export const teamSeats = sqliteTable("team_seats", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  teamId: integer("team_id")
    .references(() => teams.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  seats: integer("seats").default(1).notNull(),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripeSubscriptionItemId: text("stripe_subscription_item_id"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

// ─── MEMORY LOCKS (optimistic concurrency for shared project state) ──
export const memoryLocks = sqliteTable("memory_locks", {
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .primaryKey()
    .notNull(),
  version: integer("version").default(1).notNull(),
  lastWriterId: integer("last_writer_id").references(() => users.id),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

// ─── APPROVAL ASSIGNMENTS (cross-app run handoffs) ──────────────────
export const approvalAssignments = sqliteTable("approval_assignments", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  swarmRunId: integer("swarm_run_id")
    .references(() => swarmRuns.id, { onDelete: "cascade" })
    .notNull(),
  assigneeUserId: integer("assignee_user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  assignedBy: integer("assigned_by")
    .references(() => users.id)
    .notNull(),
  status: text("status", { enum: ["pending", "completed", "cancelled"] })
    .default("pending")
    .notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
}, (table) => ({
  assigneeIdx: index("idx_approval_assign_assignee").on(table.assigneeUserId, table.status),
  runIdx: index("idx_approval_assign_run").on(table.swarmRunId),
}));

// ═══════════════════════════════════════════════════════════════════════
// ENTERPRISE (Phase 3) — SSO connections, on-prem relay
// ═══════════════════════════════════════════════════════════════════════

// ─── SSO CONNECTIONS (OIDC + SAML, one per email domain) ────────────
export const ssoConnections = sqliteTable("sso_connections", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  type: text("type", { enum: ["oidc", "saml"] }).notNull(),
  domain: text("domain").notNull().unique(),
  displayName: text("display_name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  oidcIssuer: text("oidc_issuer"),
  oidcClientId: text("oidc_client_id"),
  oidcClientSecretEnc: text("oidc_client_secret_enc"),
  oidcScopes: text("oidc_scopes").default("openid email profile").notNull(),
  samlEntryPoint: text("saml_entry_point"),
  samlIssuer: text("saml_issuer"),
  samlCert: text("saml_cert"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

// ─── RELAY REGISTRATIONS (on-prem connectors, token stored hashed) ──
export const relayRegistrations = sqliteTable("relay_registrations", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  ownerUserId: integer("owner_user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  status: text("status", { enum: ["active", "revoked"] }).default("active").notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
});

// ─── RELAY REQUESTS (cloud-side queue for outbound-only relays) ─────
export const relayRequests = sqliteTable("relay_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  relayId: integer("relay_id")
    .references(() => relayRegistrations.id, { onDelete: "cascade" })
    .notNull(),
  kind: text("kind").notNull(),
  payloadJson: text("payload_json", { mode: "json" }).notNull(),
  status: text("status", { enum: ["pending", "claimed", "completed", "failed"] })
    .default("pending")
    .notNull(),
  resultJson: text("result_json", { mode: "json" }),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
}, (table) => ({
  relayStatusIdx: index("idx_relay_req_status").on(table.relayId, table.status),
}));

// ─── ADMIN AUDIT LOG (persistent trail for privileged mutations) ────
export const adminAuditLog = sqliteTable("admin_audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  adminUserId: integer("admin_user_id")
    .references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
  ip: text("ip"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  createdIdx: index("idx_admin_audit_log_created").on(table.createdAt),
  adminIdx: index("idx_admin_audit_log_admin").on(table.adminUserId),
}));

// ─── WAITLIST (Pioneer 100, marketing site) ─────────────────────────
export const waitlistEntries = sqliteTable("waitlist_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  email: text("email").notNull(),
  role: text("role", { enum: ["creator", "user", "both"] }).notNull(),
  ref: text("ref"),
  referralCode: text("referral_code").notNull(),
  invitedAt: integer("invited_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  emailUniq: uniqueIndex("uq_waitlist_email").on(table.email),
  referralCodeUniq: uniqueIndex("uq_waitlist_referral_code").on(table.referralCode),
}));

// ═══════════════════════════════════════════════════════════════════════
// OFFERING REDESIGN V2 (P1 — additive foundations)
// ═══════════════════════════════════════════════════════════════════════
// Governed by DeeWaanAI-Next/OFFERING-REDESIGN-TECH-SPECS.md (v2.0).
// Everything below is ADDITIVE: no existing table, column, enum value, or
// cascade is modified. Legacy rows are unaffected; v2 readers/writers are
// feature-flagged. Score/cost decimals follow spec §6.3 (DECIMAL(7,6)
// normalized aggregate, DECIMAL(8,4) raw 0–10 so 10.00 is representable,
// DECIMAL(18,8) API cost). Money columns keep the repo's existing
// DECIMAL(10,2) minor-unit style. Large text uses mediumtext with
// app-enforced size limits (spec §6). Private definition refs never embed
// live credentials.

// ─── PIPELINE VERSIONS (immutable workflow snapshots, spec §6.1) ─────
export const pipelineVersions = sqliteTable("pipeline_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  ownerId: integer("owner_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  // Source references are NOT cascade-deleted: a purchased/evidentiary
  // version must survive source project or template deletion (spec §6.1).
  sourceProjectId: integer("source_project_id"),
  sourceTemplateId: integer("source_template_id"),
  versionNumber: integer("version_number").notNull(),
  definitionSchemaVersion: integer("definition_schema_version").default(1).notNull(),
  // Canonical JSON snapshot: all prompts, graph/loop config, decoding and
  // tool/runtime configuration required for execution. No credentials.
  definition: text("definition").notNull(),
  definitionHash: text("definition_hash").notNull(),
  designerMethod: text("designer_method", { enum: ["manual", "auto"] }).default("manual").notNull(),
  designerProviderId: integer("designer_provider_id"),
  designerModel: text("designer_model"),
  designerPromptVersion: text("designer_prompt_version"),
  parentVersionId: integer("parent_version_id"),
  // ─── LINEAGE (owner decision 2026-09-22: only the ORIGINAL creator may
  // publish on the marketplace). Provenance is DATA, never a name or a prompt
  // similarity: a version copied out of a shared/imported pipeline carries the
  // account that originally created the work forward, and publishing evidence
  // or listing a version requires the caller to BE that account.
  // NULL means "predates lineage", and the reader falls back to `owner_id` —
  // so every pre-existing version stays publishable by whoever created it.
  // No FK on purpose (like `parentVersionId`/`sourceProjectId`): provenance
  // must outlive the user rows it names, and adding a constraint here would
  // silently change what account deletion is allowed to do.
  originCreatorId: integer("origin_creator_id"),
  // The earliest known version this one derives from, when different from the
  // version itself. Together with `origin_creator_id` this is the receipt that
  // says where the work came from.
  originVersionId: integer("origin_version_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  ownerVersionUniq: uniqueIndex("uq_pipeline_versions_owner_version").on(table.ownerId, table.sourceProjectId, table.versionNumber),
  definitionHashIdx: index("idx_pipeline_versions_hash").on(table.definitionHash),
}));

export type PipelineVersion = typeof pipelineVersions.$inferSelect;
export type InsertPipelineVersion = typeof pipelineVersions.$inferInsert;

// ─── PIPELINE SHARES ────────────────────────────────────────────────
// A per-object grant between TWO INDIVIDUAL ACCOUNTS (owner decision
// 2026-09-22). This is NOT a team and carries no group, workspace or org
// concept: one row says "account A lets account B use this one pipeline".
//
//  * `run_only` — B may RUN the workflow and read the RESULTS, and may not
//    read the step prompts, the system prompts or the workflow definition.
//    Reads of B's runs go through the same redacted projection the
//    buyer-facing marketplace code already produces (api/services/runAccess).
//  * `full` — B may also read the definition, and may edit it only while
//    `can_modify` is true.
//
// A share is a row, never a transfer: `projects.user_id` and every version's
// `owner_id` stay with the grantor, the grant is revocable, and no share —
// at any privilege level — carries the right to publish on the marketplace
// (see the lineage columns above).
export const pipelineShares = sqliteTable("pipeline_shares", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  // The shared object. `cascade` because the grant is meaningless without the
  // pipeline it names, and the pipeline's steps are already cascade-deleted
  // with the project; runs and versions the grant produced are separate rows
  // and are never touched by this.
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  // Denormalized grantor, so "what have I shared out" is one indexed lookup
  // and a re-share can be proven to come from the actual owner.
  ownerId: integer("owner_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  granteeId: integer("grantee_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  accessMode: text("access_mode", { enum: ["run_only", "full"] }).default("run_only").notNull(),
  canModify: integer("can_modify", { mode: "boolean" }).default(false).notNull(),
  // Revocation flips this instead of deleting: the row is the record that the
  // access was ever granted, and an in-flight run re-reads it at dispatch.
  state: text("state", { enum: ["active", "revoked"] }).default("active").notNull(),
  note: text("note"),
  grantedAt: integer("granted_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
}, (table) => ({
  // One grant per pair: "share with one named other user" is upserted, never
  // stacked into several rows whose modes could disagree about who wins.
  projectGranteeUniq: uniqueIndex("uq_pipeline_shares_project_grantee").on(table.projectId, table.granteeId),
  granteeStateIdx: index("idx_pipeline_shares_grantee_state").on(table.granteeId, table.state),
  ownerStateIdx: index("idx_pipeline_shares_owner_state").on(table.ownerId, table.state),
}));

export type PipelineShare = typeof pipelineShares.$inferSelect;
export type InsertPipelineShare = typeof pipelineShares.$inferInsert;

// ─── DESIGN JOBS (durable auto-design, spec §5/§6.1) ─────────────────
export const designJobs = sqliteTable("design_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  actorId: integer("actor_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  // (Revision + step-content snapshot fields are grouped below `state`.)
  designerProviderId: integer("designer_provider_id")
    .references(() => llmProviders.id, { onDelete: "set null" }),
  designerModel: text("designer_model"),
  designerPromptVersion: text("designer_prompt_version"),
  objective: text("objective").notNull(),
  spendApprovalId: integer("spend_approval_id"),
  state: text("state", { enum: ["queued", "running", "succeeded", "failed", "cancelled", "paused"] })
    .default("queued").notNull(),
  // Cancel intent while running: the worker finalizes as cancelled instead of
  // succeeded and stops dispatching further work (spec §5.3).
  cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp_ms" }),
  candidateVersionId: integer("candidate_version_id"),
  // Candidate graph JSON snapshot produced by generation. Held on the job
  // until apply so a changed project revision can retain it for the owner
  // instead of dropping work already paid for.
  candidateDefinition: text("candidate_definition"),
  candidateDefinitionHash: text("candidate_definition_hash"),
  applyState: text("apply_state", { enum: ["not_applied", "applied", "revision_conflict"] })
    .default("not_applied").notNull(),
  // Revision counter AND canonical step-content snapshot at start: v2 apply
  // checks both, because legacy step writers do not bump the counter.
  expectedRevision: integer("expected_revision").notNull(),
  baseStepHash: text("base_step_hash"),
  // Durable provider-call attempt summaries (spec §5.3): this is the P2a
  // bridge until the full callAttempts ledger is wired in P2b.
  providerCallAttempts: text("provider_call_attempts", { mode: "json" }).$type<Array<{
    attemptIndex: number;
    outcome: "success" | "failed" | "uncertain";
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    providerRequestId?: string;
    errorSummary?: string;
    startedAt: string;
    finishedAt?: string;
  }>>(),
  // DB lease/generation token: duplicate workers cannot finalize the same
  // logical job (spec §5.3).
  leaseToken: text("lease_token"),
  leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
  attemptCount: integer("attempt_count").default(0).notNull(),
  idempotencyKey: text("idempotency_key"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
}, (table) => ({
  actorIdempotencyUniq: uniqueIndex("uq_design_jobs_actor_idempotency").on(table.actorId, table.idempotencyKey),
  stateIdx: index("idx_design_jobs_state").on(table.state),
  projectIdx: index("idx_design_jobs_project").on(table.projectId),
}));

export type DesignJob = typeof designJobs.$inferSelect;
export type InsertDesignJob = typeof designJobs.$inferInsert;

// ─── JOB OUTBOX (transactional enqueue intent, spec §5.3) ────────────
// Persisted in the same transaction as the job row; a dispatcher drains it
// with a stable idempotency key. Unenqueued records are reconciled after
// crashes so accepted intent is never lost.
export const jobOutbox = sqliteTable("job_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  eventKey: text("event_key").notNull().unique(),
  resourceType: text("resource_type").notNull(),
  resourceId: integer("resource_id").notNull(),
  operation: text("operation").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(), // IDs only — never keys/prompts
  deliveryState: text("delivery_state", { enum: ["pending", "delivered", "failed", "dead"] })
    .default("pending").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  nextRetryAt: integer("next_retry_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
}, (table) => ({
  pendingIdx: index("idx_job_outbox_pending").on(table.deliveryState, table.nextRetryAt),
}));

export type JobOutbox = typeof jobOutbox.$inferSelect;
export type InsertJobOutbox = typeof jobOutbox.$inferInsert;

// ─── PROJECT REVISION COUNTER (optimistic concurrency for design apply) ─
// Separate table so `projects` rows are untouched by v2 writers. Incremented
// transactionally whenever pipeline steps change.
export const projectRevisions = sqliteTable("project_revisions", {
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .primaryKey().notNull(),
  revision: integer("revision").default(0).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type ProjectRevision = typeof projectRevisions.$inferSelect;
export type InsertProjectRevision = typeof projectRevisions.$inferInsert;

// ─── SPEND APPROVALS (frozen call-plan consent, spec §6.1/§9) ────────
export const spendApprovals = sqliteTable("spend_approvals", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  actorId: integer("actor_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  payerId: integer("payer_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  purpose: text("purpose", { enum: ["private_design", "private_evaluation", "seller_evidence", "buyer_execution", "trial", "community_evaluation",] }).notNull(),
  planHash: text("plan_hash").notNull(),
  planSnapshot: text("plan_snapshot").notNull(), // exact frozen call plan
  bindings: text("bindings", { mode: "json" }).$type<Array<{ providerId: number; model: string }>>().notNull(),
  limits: text("limits", { mode: "json" }).$type<{
    maxCalls?: number;
    maxTokens?: number;
    maxRuntimeSeconds?: number;
  }>(),
  spendCeilingUsd: text("spend_ceiling_usd"), // optional user-approved ceiling
  status: text("status", { enum: ["active", "consumed", "expired", "revoked"] })
    .default("active").notNull(),
  policyVersion: text("policy_version").notNull(),
  approvedAt: integer("approved_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
}, (table) => ({
  actorStatusIdx: index("idx_spend_approvals_actor_status").on(table.actorId, table.status),
}));

export type SpendApproval = typeof spendApprovals.$inferSelect;
export type InsertSpendApproval = typeof spendApprovals.$inferInsert;

// ─── BENCHMARKS (evaluation runs, spec §6.1) ─────────────────────────
// listingId is NULLABLE: private grade-only evaluation needs no listing (D1).
// plan/planHash are frozen at start; later edits create a new benchmark.
export const benchmarks = sqliteTable("benchmarks", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  ownerId: integer("owner_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  listingId: integer("listing_id").references(() => marketplaceListings.id, { onDelete: "set null" }),
  // NULL while the benchmark is a draft: the immutable snapshot is only
  // frozen at start (migration 026). Authoritative afterwards.
  pipelineVersionId: integer("pipeline_version_id")
    .references(() => pipelineVersions.id, { onDelete: "restrict" }),
  executionMode: text("execution_mode", { enum: ["grade_only", "compare_models", "compare_frontier_solo"] })
    .notNull(),
  schemaVersion: integer("schema_version").default(1).notNull(),
  plan: text("plan"), // immutable frozen plan JSON after start
  planHash: text("plan_hash"),
  rubricRef: text("rubric_ref"),
  judgeConfigRef: text("judge_config_ref"),
  spendApprovalId: integer("spend_approval_id").references(() => spendApprovals.id, { onDelete: "restrict" }),
  state: text("state", { enum: ["draft", "queued", "running", "paused", "completed", "partial", "failed", "cancelled"] })
    .default("draft").notNull(),
  aggregateAvailability: text("aggregate_availability", { enum: ["none", "complete", "incomplete"] })
    .default("none").notNull(), // missing coverage → incomplete, never silently reweighted (§6.3)
  leaseToken: text("lease_token"),
  leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
  cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp_ms" }),
  // Draft-stage source pointer (projects.id). Frozen pipelineVersionId is
  // authoritative after start; this only lets quote/validate re-snapshot.
  sourceProjectId: integer("source_project_id"),
  idempotencyKey: text("idempotency_key"),
  costCurrency: text("cost_currency").default("USD"),
  totalEstimatedCost: text("total_estimated_cost"),
  totalObservedCost: text("total_observed_cost"),
  costCompleteness: text("cost_completeness", { enum: ["complete", "partial", "unknown"] }).default("unknown"),
  // Descriptive-only evaluation summary (spec §7.2): counts, spread,
  // agreement, failures, observed cost. NEVER a place for inferred
  // statistics or quality certification.
  summary: text("summary"),
  summaryComputedAt: integer("summary_computed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
}, (table) => ({
  ownerStateIdx: index("idx_benchmarks_owner_state").on(table.ownerId, table.state),
  versionIdx: index("idx_benchmarks_pipeline_version").on(table.pipelineVersionId),
  actorIdempotencyUniq: uniqueIndex("uq_benchmarks_owner_idempotency").on(table.ownerId, table.idempotencyKey),
}));

export type Benchmark = typeof benchmarks.$inferSelect;
export type InsertBenchmark = typeof benchmarks.$inferInsert;

// ─── BENCHMARK CASES (task inputs, spec §6.1) ────────────────────────
export const benchmarkCases = sqliteTable("benchmark_cases", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  benchmarkId: integer("benchmark_id")
    .references(() => benchmarks.id, { onDelete: "cascade" })
    .notNull(),
  stableCaseId: text("stable_case_id").notNull(),
  caseOrder: integer("case_order").notNull(),
  inputText: text("input_text"),
  inputArtifactRef: text("input_artifact_ref"), // large inputs: private object storage
  origin: text("origin", { enum: ["user", "generated", "paraphrase"] }).default("user").notNull(),
  baseCaseId: text("base_case_id"), // paraphrase grouping
  expectedOutput: text("expected_output"), // reference when provided
  contentHash: text("content_hash").notNull(),
  provenanceNotes: text("provenance_notes"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  benchmarkCaseUniq: uniqueIndex("uq_benchmark_cases_benchmark_case").on(table.benchmarkId, table.stableCaseId),
}));

export type BenchmarkCase = typeof benchmarkCases.$inferSelect;
export type InsertBenchmarkCase = typeof benchmarkCases.$inferInsert;

// ─── BENCHMARK CANDIDATES (execution strategies under test, §6.1) ────
export const benchmarkCandidates = sqliteTable("benchmark_candidates", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  benchmarkId: integer("benchmark_id")
    .references(() => benchmarks.id, { onDelete: "cascade" })
    .notNull(),
  stableCandidateId: text("stable_candidate_id").notNull(),
  // `imported_output` = grade an output the owner already has, without
  // regenerating it (spec §4.1/A01, migration 027).
  strategy: text("strategy", { enum: ["pipeline", "solo_baseline", "imported_output"] }).notNull(),
  workflowVersionId: integer("workflow_version_id").references(() => pipelineVersions.id, { onDelete: "restrict" }),
  // The owner's existing response being graded. SET NULL: the graded text and
  // hash are copied onto benchmark_runs, so the evidence stands on its own.
  importedResponseId: integer("imported_response_id").references(() => agentResponsesTable.id, { onDelete: "set null" }),
  baselinePrompt: text("baseline_prompt"), // solo_baseline only
  baselinePromptVersion: text("baseline_prompt_version"),
  requestedProviderId: integer("requested_provider_id"), // payer-owned, resolved server-side
  requestedModel: text("requested_model"),
  stepResolutionPolicy: text("step_resolution_policy", { mode: "json" }).$type<{
    mode: "as_configured" | "override_all";
    overrideModel?: string;
    overrideProviderId?: number;
  }>(),
  decodingSnapshot: text("decoding_snapshot", { mode: "json" }).$type<{
    temperature?: number;
    maxTokens?: number;
    topP?: number;
  }>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  benchmarkCandidateUniq: uniqueIndex("uq_benchmark_candidates_benchmark_candidate").on(table.benchmarkId, table.stableCandidateId),
}));

export type BenchmarkCandidate = typeof benchmarkCandidates.$inferSelect;
export type InsertBenchmarkCandidate = typeof benchmarkCandidates.$inferInsert;

// ─── BENCHMARK RUNS (one execution per case×candidate×replication) ───
export const benchmarkRuns = sqliteTable("benchmark_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  benchmarkId: integer("benchmark_id")
    .references(() => benchmarks.id, { onDelete: "cascade" })
    .notNull(),
  caseId: integer("case_id")
    .references(() => benchmarkCases.id, { onDelete: "cascade" })
    .notNull(),
  candidateId: integer("candidate_id")
    .references(() => benchmarkCandidates.id, { onDelete: "cascade" })
    .notNull(),
  replicationIndex: integer("replication_index").default(1).notNull(),
  logicalExecutionId: text("logical_execution_id").notNull(),
  linkedSwarmRunId: integer("linked_swarm_run_id").references(() => swarmRuns.id, { onDelete: "set null" }),
  // For grading existing outputs: user-reported origin is NOT attested
  // platform execution evidence (spec §4.1). `owned_run` means the text came
  // from a response row this platform recorded for the same owner, so its
  // model/timestamp are known — still not execution performed by THIS plan.
  importedProvenance: text("imported_provenance", { mode: "json" }).$type<{
    kind: "user_reported" | "owned_run";
    reportedModel?: string;
    reportedAt?: string;
    sourceResponseId?: number;
    sourceSwarmRunId?: number;
  }>(),
  status: text("status", { enum: ["pending", "running", "completed", "failed", "cancelled", "uncertain"] })
    .default("pending").notNull(),
  outputText: text("output_text"),
  outputHash: text("output_hash"),
  executorMetadata: text("executor_metadata", { mode: "json" }).$type<{
    stepModels?: Array<{ stepOrder: number; requestedModel: string; returnedModel?: string | null }>;
    providerRoute?: string;
    revisionExposed?: string | null; // null → "not exposed by provider"
  }>(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  usageSummary: text("usage_summary", { mode: "json" }).$type<{ promptTokens?: number; completionTokens?: number; complete?: boolean }>(),
  errorSummary: text("error_summary"), // sanitized
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  logicalRunUniq: uniqueIndex("uq_benchmark_runs_logical_execution").on(table.logicalExecutionId),
  runMembershipIdx: index("idx_benchmark_runs_benchmark").on(table.benchmarkId, table.status),
  caseCandidateUniq: uniqueIndex("uq_benchmark_runs_case_candidate_replication").on(
    table.caseId, table.candidateId, table.replicationIndex,
  ),
}));

export type BenchmarkRun = typeof benchmarkRuns.$inferSelect;
export type InsertBenchmarkRun = typeof benchmarkRuns.$inferInsert;

// ─── BENCHMARK JUDGMENTS (rubric scores or pair preferences, §6.1) ───
// Score scale is EXPLICIT per §6.3: rawScore DECIMAL(8,4) with declared
// lower/upper bounds → 10.00 representable; normalized DECIMAL(7,6) ∈ [0,1].
export const benchmarkJudgments = sqliteTable("benchmark_judgments", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  benchmarkId: integer("benchmark_id")
    .references(() => benchmarks.id, { onDelete: "cascade" })
    .notNull(),
  runId: integer("run_id").references(() => benchmarkRuns.id, { onDelete: "cascade" }),
  runAId: integer("run_a_id"),
  runBId: integer("run_b_id"),
  judgeSlot: integer("judge_slot").notNull(), // discloses panel size (spec §7.1)
  rubricVersionRef: text("rubric_version_ref").notNull(),
  judgePromptVersion: text("judge_prompt_version").notNull(),
  judgeModel: text("judge_model").notNull(),
  judgeProviderRoute: text("judge_provider_route"),
  judgeRevision: text("judge_revision"), // nullable → not exposed
  orientation: text("orientation", { enum: ["none", "ab", "ba"] }), // paired only, recorded/randomized
  kind: text("kind", { enum: ["rubric", "pairwise"] }).default("rubric").notNull(),
  dimensionScores: text("dimension_scores", { mode: "json" }).$type<Array<{
    dimension: string;
    rawScore: string;      // decimal string, range-validated at write
    lowerBound: string;
    upperBound: string;
    weight: string;        // finite, nonnegative; sums to 1 after normalization
  }>>(),
  rawAggregate: text("raw_aggregate"), // e.g. 0–10 scale
  normalizedAggregate: text("normalized_aggregate"), // [0,1]
  pairPreference: text("pair_preference", { enum: ["a", "b", "tie"] }),
  rationale: text("rationale"),
  rawResponseRef: text("raw_response_ref"),
  status: text("status", { enum: ["pending", "completed", "parse_failed", "validation_failed", "failed"] })
    .default("pending").notNull(),
  validationNotes: text("validation_notes", { mode: "json" }).$type<{ outOfRange?: string[]; missingDimensions?: string[] }>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  judgmentUniq: uniqueIndex("uq_benchmark_judgments_run_judge_orientation").on(
    table.runId, table.judgeSlot, table.orientation, table.judgePromptVersion,
  ),
  benchmarkIdx: index("idx_benchmark_judgments_benchmark").on(table.benchmarkId, table.status),
  fkRunA: foreignKey({ name: "fk_benchmark_judgments_run_a", columns: [table.runAId], foreignColumns: [benchmarkRuns.id] }).onDelete("cascade"),
  fkRunB: foreignKey({ name: "fk_benchmark_judgments_run_b", columns: [table.runBId], foreignColumns: [benchmarkRuns.id] }).onDelete("cascade"),
}));

export type BenchmarkJudgment = typeof benchmarkJudgments.$inferSelect;
export type InsertBenchmarkJudgment = typeof benchmarkJudgments.$inferInsert;

// ─── CALL ATTEMPTS (append-only provider ledger, spec §6.1/§9) ───────
// Retries NEVER overwrite prior attempts; uncertain outcomes stay visible.
export const callAttempts = sqliteTable("call_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  operationKind: text("operation_kind", { enum: ["generation", "judgment", "design", "narrative", "preparation"] }).notNull(),
  operationId: integer("operation_id").notNull(), // row ID within kind (run/judgment/job)
  benchmarkId: integer("benchmark_id").references(() => benchmarks.id, { onDelete: "cascade" }),
  purpose: text("purpose", { enum: ["private_design", "private_evaluation", "seller_evidence", "buyer_execution", "trial", "community_evaluation",] }).notNull(),
  actorId: integer("actor_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  payerId: integer("payer_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  providerRefId: integer("provider_ref_id"), // private; never exposed cross-tenant
  requestedModel: text("requested_model").notNull(),
  returnedModel: text("returned_model"),
  providerRequestId: text("provider_request_id"),
  attemptIndex: integer("attempt_index").notNull(),
  outcome: text("outcome", { enum: ["success", "failed", "uncertain"] }).notNull(),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  cachedTokens: integer("cached_tokens"),
  priceVectorVersion: text("price_vector_version"),
  // Where a priced row's rate came from. NULL = "this row is not priceable",
  // which is NOT the same as zero (spec §9).
  costBasis: text("cost_basis"),
  costPricingAsOf: integer("cost_pricing_as_of", { mode: "timestamp_ms" }),
  estimatedCostUsd: text("estimated_cost_usd"),
  costCompleteness: text("cost_completeness", { enum: ["complete", "partial", "unknown"] }).default("unknown").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  latencyMs: integer("latency_ms"),
  errorMessage: text("error_message"), // redacted
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  attemptUniq: uniqueIndex("uq_call_attempts_operation_attempt").on(table.operationKind, table.operationId, table.attemptIndex),
  benchmarkIdx: index("idx_call_attempts_benchmark").on(table.benchmarkId),
  payerIdx: index("idx_call_attempts_payer_created").on(table.payerId, table.createdAt),
}));

export type CallAttempt = typeof callAttempts.$inferSelect;
export type InsertCallAttempt = typeof callAttempts.$inferInsert;

// ─── EVIDENCE PUBLICATIONS (immutable public manifests, spec §6.2) ───
// Job completion NEVER publishes (§10.2). A replacement is a new row that
// supersedes the old; withdrawal never rewrites history.
export const evidencePublications = sqliteTable("evidence_publications", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  authorId: integer("author_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  benchmarkId: integer("benchmark_id").references(() => benchmarks.id, { onDelete: "restrict" }),
  externalReportId: integer("external_report_id"), // set for user-reported evidence
  listingId: integer("listing_id").references(() => marketplaceListings.id, { onDelete: "restrict" }),
  listingWorkflowVersionId: integer("listing_workflow_version_id"),
  publicationKind: text("publication_kind", { enum: ["seller", "community"] }).notNull(),
  provenance: text("provenance", { enum: ["platform_recorded", "user_reported", "legacy_import"] }).notNull(),
  publicManifest: text("public_manifest").notNull(),
  manifestHash: text("manifest_hash").notNull(),
  // ATTESTATION (v3): who issued this record, not merely that it is unedited.
  // Nullable on purpose — a pre-signature row and a row published while the
  // platform has no signing key configured are both real, published evidence, and
  // NULL says so out loud instead of pretending. The signature itself also lives
  // inside `publicManifest`; these columns exist so a query can ask "is there any
  // published evidence NOT signed by the platform key we trust?" without parsing
  // JSON, which is what a revocation or re-issue sweep needs.
  signature: text("signature"),
  signingKeyId: text("signing_key_id"),
  signedAt: integer("signed_at", { mode: "timestamp_ms" }),
  schemaVersion: integer("schema_version").default(1).notNull(),
  consentVersion: text("consent_version").notNull(),
  state: text("state", { enum: ["draft_preview", "published", "withdrawn"] }).default("draft_preview").notNull(),
  supersedesPublicationId: integer("supersedes_publication_id"),
  // Original test completion time is SEPARATE from publication time —
  // re-publishing must not reset "tested on" (§6.2).
  testedAt: integer("tested_at", { mode: "timestamp_ms" }).notNull(),
  publishedAt: integer("published_at", { mode: "timestamp_ms" }),
  withdrawnAt: integer("withdrawn_at", { mode: "timestamp_ms" }),
  withdrawalReason: text("withdrawal_reason"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  listingPublicIdx: index("idx_evidence_publications_listing_state").on(table.listingId, table.state),
  authorIdx: index("idx_evidence_publications_author").on(table.authorId),
  fkWorkflowVersion: foreignKey({ name: "fk_evidence_pub_workflow_version", columns: [table.listingWorkflowVersionId], foreignColumns: [pipelineVersions.id] }).onDelete("restrict"),
}));

export type EvidencePublication = typeof evidencePublications.$inferSelect;
export type InsertEvidencePublication = typeof evidencePublications.$inferInsert;

// ─── EXTERNAL EVIDENCE REPORTS (user-declared, never attested, §6.2) ──
export const externalEvidenceReports = sqliteTable("external_evidence_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  authorId: integer("author_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  listingId: integer("listing_id").references(() => marketplaceListings.id, { onDelete: "restrict" }).notNull(),
  workflowVersionId: integer("workflow_version_id"),
  declaredInputs: text("declared_inputs").notNull(),
  declaredOutputs: text("declared_outputs").notNull(),
  declaredModel: text("declared_model"),
  declaredDate: text("declared_date"), // user-reported, not trusted as timestamp
  declaredRubric: text("declared_rubric"),
  attachments: text("attachments", { mode: "json" }).$type<Array<{ ref: string; name: string; mime: string; sizeBytes: number; safetyScan: string }>>(),
  notes: text("notes"),
  publicationState: text("publication_state", { enum: ["draft", "published", "withdrawn"] }).default("draft").notNull(),
  consentVersion: text("consent_version"),
  previewHash: text("preview_hash"),
  publishedAt: integer("published_at", { mode: "timestamp_ms" }),
  withdrawnAt: integer("withdrawn_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  listingIdx: index("idx_external_evidence_reports_listing").on(table.listingId),
  fkWorkflowVersion: foreignKey({ name: "fk_external_reports_workflow_version", columns: [table.workflowVersionId], foreignColumns: [pipelineVersions.id] }).onDelete("set null"),
}));

export type ExternalEvidenceReport = typeof externalEvidenceReports.$inferSelect;
export type InsertExternalEvidenceReport = typeof externalEvidenceReports.$inferInsert;

// ─── EVIDENCE REPORTS (community contradiction flags, spec §4.4) ──────
// A score DIFFERENCE never auto-verifies, auto-refunds, or auto-delists.
export const evidenceReports = sqliteTable("evidence_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  reporterId: integer("reporter_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  targetPublicationId: integer("target_publication_id"),
  targetListingId: integer("target_listing_id").references(() => marketplaceListings.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  supportingRef: text("supporting_ref"),
  assessmentStatus: text("assessment_status", { enum: ["open", "reviewing", "upheld", "dismissed"] })
    .default("open").notNull(),
  sellerReply: text("seller_reply"),
  sellerRepliedAt: integer("seller_replied_at", { mode: "timestamp_ms" }),
  assessedBy: integer("assessed_by").references(() => users.id, { onDelete: "set null" }),
  assessedAt: integer("assessed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  targetIdx: index("idx_evidence_reports_target").on(table.targetPublicationId, table.assessmentStatus),
  fkTargetPub: foreignKey({ name: "fk_evidence_reports_target_pub", columns: [table.targetPublicationId], foreignColumns: [evidencePublications.id] }).onDelete("restrict"),
}));

export type EvidenceReport = typeof evidenceReports.$inferSelect;
export type InsertEvidenceReport = typeof evidenceReports.$inferInsert;

// ─── EXECUTION GRANTS (execute ≠ read, spec §6.4) ─────────────────────
// pipeline:run:<listingId> entitlements stay as-is for compatibility, but
// only these grants authorize loading a protected version server-side.
export const executionGrants = sqliteTable("execution_grants", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  subjectType: text("subject_type", { enum: ["user", "team"] }).notNull(),
  subjectId: integer("subject_id").notNull(),
  listingId: integer("listing_id").references(() => marketplaceListings.id, { onDelete: "restrict" }).notNull(),
  workflowVersionId: integer("workflow_version_id").references(() => pipelineVersions.id, { onDelete: "restrict" }),
  source: text("source", { enum: ["purchase", "trial", "manual"] }),
  sourceRef: text("source_ref"),
  state: text("state", { enum: ["active", "revoked", "expired"] }).default("active").notNull(),
  policyVersion: text("policy_version"),
  grantedAt: integer("granted_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
}, (table) => ({
  subjectListingIdx: index("idx_execution_grants_subject_listing").on(table.subjectId, table.listingId, table.state),
}));

export type ExecutionGrant = typeof executionGrants.$inferSelect;
export type InsertExecutionGrant = typeof executionGrants.$inferInsert;

// ─── TRIAL GRANTS / RESERVATIONS (atomic quota, spec §6.4/§8.3) ───────
// Feature-flagged off until policy P4 resolves. No fabricated purchase rows.
export const trialGrants = sqliteTable("trial_grants", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  subjectId: integer("subject_id").notNull(),
  listingId: integer("listing_id").references(() => marketplaceListings.id, { onDelete: "restrict" }).notNull(),
  policyWindow: text("policy_window").notNull(), // e.g. "all-time" or "2026-09"
  policyVersion: text("policy_version").notNull(),
  allowedQuota: integer("allowed_quota").notNull(),
  reservedCount: integer("reserved_count").default(0).notNull(),
  consumedCount: integer("consumed_count").default(0).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  grantUniq: uniqueIndex("uq_trial_grants_subject_listing_window_policy").on(
    table.subjectId, table.listingId, table.policyWindow, table.policyVersion,
  ),
}));

export type TrialGrant = typeof trialGrants.$inferSelect;
export type InsertTrialGrant = typeof trialGrants.$inferInsert;

export const trialReservations = sqliteTable("trial_reservations", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  trialGrantId: integer("trial_grant_id")
    .references(() => trialGrants.id, { onDelete: "restrict" })
    .notNull(),
  operationKey: text("operation_key").notNull(), // idempotent execution ID
  state: text("state", { enum: ["reserved", "consumed", "released", "uncertain"] }).default("reserved").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
}, (table) => ({
  operationKeyUniq: uniqueIndex("uq_trial_reservations_operation_key").on(table.operationKey),
  grantStateIdx: index("idx_trial_reservations_grant_state").on(table.trialGrantId, table.state),
}));

export type TrialReservation = typeof trialReservations.$inferSelect;
export type InsertTrialReservation = typeof trialReservations.$inferInsert;

// ─── SETTLEMENT ENTRIES (seller earnings ledger, spec §6.4/§11) ───────
// A recorded earning is NOT a bank payout. Minor-unit decimal(10,2); the
// commission basis/rate is snapshotted per sale so history is immutable.
export const settlementEntries = sqliteTable("settlement_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  purchaseId: integer("purchase_id").references(() => marketplacePurchases.id, { onDelete: "restrict" }),
  adjustmentSource: text("adjustment_source", { enum: ["purchase", "refund", "chargeback", "manual_adjustment"] }).notNull(),
  sellerId: integer("seller_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  currency: text("currency").default("USD").notNull(),
  grossAmount: text("gross_amount").notNull(),
  commissionBasis: text("commission_basis").notNull(),
  commissionRate: text("commission_rate").notNull(), // e.g. 0.30
  feesTaxRef: text("fees_tax_ref"),
  netPayable: text("net_payable").notNull(),
  state: text("state", { enum: ["held", "eligible", "processing", "paid", "failed", "unknown", "reversed", "adjusted"] })
    .default("held").notNull(),
  holdPolicyVersion: text("hold_policy_version"),
  holdUntil: integer("hold_until", { mode: "timestamp_ms" }),
  disputeState: text("dispute_state", { enum: ["none", "open", "resolved"] }).default("none").notNull(),
  policySnapshot: text("policy_snapshot", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  sellerStateIdx: index("idx_settlement_entries_seller_state").on(table.sellerId, table.state),
  holdIdx: index("idx_settlement_entries_hold").on(table.state, table.holdUntil),
}));

export type SettlementEntry = typeof settlementEntries.$inferSelect;
export type InsertSettlementEntry = typeof settlementEntries.$inferInsert;

// ─── PAYOUT ATTEMPTS (external-confirmed transfers, spec §6.4/§11.3) ──
// Only provider-confirmed success marks a payout paid. Timeouts record
// `unknown` and reconcile by reference — never a new-key resend.
export const payoutAttempts = sqliteTable("payout_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  settlementEntryId: integer("settlement_entry_id")
    .references(() => settlementEntries.id, { onDelete: "restrict" })
    .notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  provider: text("provider").notNull(), // e.g. "stripe_connect" once approved (P3)
  providerTransferRef: text("provider_transfer_ref"),
  amount: text("amount").notNull(),
  currency: text("currency").notNull(),
  state: text("state", { enum: ["pending", "processing", "succeeded", "failed", "unknown"] }).default("pending").notNull(),
  providerConfirmedAt: integer("provider_confirmed_at", { mode: "timestamp_ms" }),
  failureReason: text("failure_reason"), // redacted
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  settlementIdx: index("idx_payout_attempts_settlement").on(table.settlementEntryId, table.state),
  pendingIdx: index("idx_payout_attempts_unreconciled").on(table.state, table.createdAt),
}));

export type PayoutAttempt = typeof payoutAttempts.$inferSelect;
export type InsertPayoutAttempt = typeof payoutAttempts.$inferInsert;

// ─── MODEL CATALOG (versioned, admin-reviewed release events, §12.1) ──
// NOT inferred from user llmProviders.models caches or name substrings.
export const modelCatalog = sqliteTable("model_catalog", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  provider: text("provider").notNull(),
  modelId: text("model_id").notNull(),
  family: text("family"),
  /** D12: the model's DEVELOPER (e.g. "deepseek", "meta", "zhipu"), NOT the
   *  hosting provider whose key served the call — one host serves many
   *  vendors' models. Admin-reviewed like every other catalog field. NULL =
   *  vendor unknown: an unknown vendor counts as disjoint from nothing, so it
   *  can never satisfy the evidence-panel gate (and never collides with
   *  another model either). Migration 031. */
  vendor: text("vendor"),
  successorOfModelId: text("successor_of_model_id"), // explicit lineage
  availabilitySource: text("availability_source", { enum: ["admin_reviewed", "feed_import"] }).default("admin_reviewed").notNull(),
  sourceUrl: text("source_url"),
  verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
  availableAt: integer("available_at", { mode: "timestamp_ms" }),
  deprecatedAt: integer("deprecated_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  providerModelUniq: uniqueIndex("uq_model_catalog_provider_model").on(table.provider, table.modelId),
}));

export type ModelCatalogEntry = typeof modelCatalog.$inferSelect;
export type InsertModelCatalogEntry = typeof modelCatalog.$inferInsert;

export const modelReleaseEvents = sqliteTable("model_release_events", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  modelCatalogId: integer("model_catalog_id")
    .references(() => modelCatalog.id, { onDelete: "cascade" })
    .notNull(),
  eventKey: text("event_key").notNull().unique(), // dedupe source event
  recordedBy: integer("recorded_by").references(() => users.id, { onDelete: "set null" }),
  relevanceRule: text("relevance_rule"), // e.g. same_family
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
});

export type ModelReleaseEvent = typeof modelReleaseEvents.$inferSelect;
export type InsertModelReleaseEvent = typeof modelReleaseEvents.$inferInsert;

// Deduplicated retest SUGGESTIONS — a suggestion never starts paid work (D5).
export const retestSuggestions = sqliteTable("retest_suggestions", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  sellerId: integer("seller_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  listingId: integer("listing_id").references(() => marketplaceListings.id, { onDelete: "cascade" }).notNull(),
  workflowVersionId: integer("workflow_version_id").references(() => pipelineVersions.id, { onDelete: "cascade" }),
  releaseEventId: integer("release_event_id")
    .references(() => modelReleaseEvents.id, { onDelete: "cascade" })
    .notNull(),
  channel: text("channel", { enum: ["in_app", "email"] }).default("in_app").notNull(),
  state: text("state", { enum: ["pending", "dismissed", "snoozed", "retest_started"] }).default("pending").notNull(),
  snoozedUntil: integer("snoozed_until", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  noticeUniq: uniqueIndex("uq_retest_suggestions_seller_version_event_channel").on(
    table.sellerId, table.workflowVersionId, table.releaseEventId, table.channel,
  ),
  sellerStateIdx: index("idx_retest_suggestions_seller").on(table.sellerId, table.state),
}));

export type RetestSuggestion = typeof retestSuggestions.$inferSelect;
export type InsertRetestSuggestion = typeof retestSuggestions.$inferInsert;

// ─── V2 COLUMNS ON EXISTING TABLES (additive, nullable) ──────────────
// marketplaceListings: v2 publication-mode pointers (spec §6.2). Existing
// status enum values are RETAINED; publicationMode separates legacy from v2.
// (Added to the table definition above would touch existing rows' DDL, so
// these are delivered as ALTER TABLE ADD COLUMN in migration 022 and
// mirrored here as a separate attachment table to keep schema.ts purely
// additive for the P1 push path.)
export const marketplaceListingV2 = sqliteTable("marketplace_listing_v2", {
  listingId: integer("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .primaryKey().notNull(),
  publicationMode: text("publication_mode", { enum: ["legacy", "v2"] }).default("legacy").notNull(),
  currentWorkflowVersionId: integer("current_workflow_version_id"),
  currentEvidencePublicationId: integer("current_evidence_publication_id"),
  evidenceSummaryRevision: integer("evidence_summary_revision").default(0).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  fkWorkflowVersion: foreignKey({ name: "fk_listing_v2_workflow_version", columns: [table.currentWorkflowVersionId], foreignColumns: [pipelineVersions.id] }).onDelete("set null"),
  fkEvidencePublication: foreignKey({ name: "fk_listing_v2_evidence_publication", columns: [table.currentEvidencePublicationId], foreignColumns: [evidencePublications.id] }).onDelete("set null"),
}));

export type MarketplaceListingV2 = typeof marketplaceListingV2.$inferSelect;
export type InsertMarketplaceListingV2 = typeof marketplaceListingV2.$inferInsert;

// marketplacePurchases + quotes: immutable checkout quote per sale (spec
// §6.4/§11.2). Separate table keeps the purchase row untouched; linked by
// unique purchaseId once fulfillment occurs.
export const marketplaceCheckoutQuotes = sqliteTable("marketplace_checkout_quotes", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  buyerId: integer("buyer_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  listingId: integer("listing_id").notNull(),
  workflowVersionId: integer("workflow_version_id"),
  currency: text("currency").default("USD").notNull(),
  amount: text("amount").notNull(),
  commissionBasis: text("commission_basis").notNull(),
  commissionRate: text("commission_rate").notNull(),
  refundPolicyVersion: text("refund_policy_version"),
  holdPolicyVersion: text("hold_policy_version"),
  stripeSessionId: text("stripe_session_id").unique(),
  status: text("status", { enum: ["created", "confirmed", "paid", "fulfilled", "expired", "unfulfillable"] })
    .default("created").notNull(),
  purchaseId: integer("purchase_id"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  purchaseUniq: uniqueIndex("uq_checkout_quotes_purchase").on(table.purchaseId),
  buyerIdx: index("idx_checkout_quotes_buyer_status").on(table.buyerId, table.status),
  fkListing: foreignKey({ name: "fk_checkout_quotes_listing", columns: [table.listingId], foreignColumns: [marketplaceListings.id] }).onDelete("restrict"),
  fkWorkflowVersion: foreignKey({ name: "fk_checkout_quotes_workflow_version", columns: [table.workflowVersionId], foreignColumns: [pipelineVersions.id] }).onDelete("restrict"),
  fkPurchase: foreignKey({ name: "fk_checkout_quotes_purchase", columns: [table.purchaseId], foreignColumns: [marketplacePurchases.id] }).onDelete("restrict"),
}));

export type MarketplaceCheckoutQuote = typeof marketplaceCheckoutQuotes.$inferSelect;
export type InsertMarketplaceCheckoutQuote = typeof marketplaceCheckoutQuotes.$inferInsert;

// Trusted provider endpoints for PROTECTED execution (spec §8.2). Buyer
// BYOK custom endpoints are never in this set implicitly.
export const trustedProviderEndpoints = sqliteTable("trusted_provider_endpoints", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  provider: text("provider").notNull(),
  baseUrl: text("base_url").notNull(),
  adapterKind: text("adapter_kind").notNull(),
  endpointClass: text("endpoint_class", { enum: ["first_party", "approved_proxy"] }).default("first_party").notNull(),
  loggingDisclosure: text("logging_disclosure").notNull(), // provider-side logging exposure, reviewed
  protectionClass: text("protection_class", { enum: ["standard", "reduced"] }).default("standard").notNull(),
  approvedBy: integer("approved_by").references(() => users.id, { onDelete: "set null" }),
  policyVersion: text("policy_version").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  endpointUniq: uniqueIndex("uq_trusted_endpoints_provider_base").on(table.provider, table.baseUrl),
}));

export type TrustedProviderEndpoint = typeof trustedProviderEndpoints.$inferSelect;
export type InsertTrustedProviderEndpoint = typeof trustedProviderEndpoints.$inferInsert;

// ─── PROMOTIONS (migration 035) ────────────────────────────────────
// Admin-defined free-days grants — "7 days free for newcomers" — so a launch
// promotion is data, not a code change. Nothing here discounts the price:
// Stripe carries the grant as a subscription trial
// (`subscription_data.trial_period_days` at checkout), so the account is billed
// the standard price once the days run out and there is no second price path to
// reconcile. The retired `vouchers` table cannot be reused for this: its NOT
// NULL `tier` enum only accepts the plan-ladder values deleted with the ladder,
// and inventing a fake tier there would be a lie in the data.
export const promotions = sqliteTable("promotions", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  name: text("name").notNull(),
  days: integer("days").notNull(),
  // 'new_signups' is granted automatically to accounts that sign up inside the
  // window and have never subscribed; 'code' is only given on redemption.
  audience: text("audience", { enum: ["new_signups", "code"] }).notNull(),
  // Required for 'code', NULL for 'new_signups'. MySQL treats NULLs as distinct
  // in a UNIQUE index, so several automatic promotions coexist while codes stay
  // one-per-promotion.
  code: text("code"),
  startsAt: integer("starts_at", { mode: "timestamp_ms" }),
  endsAt: integer("ends_at", { mode: "timestamp_ms" }),
  // NULL = unlimited. Counted from redemption rows rather than a mutable
  // counter column, so a redemption cannot be lost or double-counted.
  maxRedemptions: integer("max_redemptions"),
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  note: text("note"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => ({
  codeUq: uniqueIndex("uq_promotions_code").on(table.code),
  audienceActiveIdx: index("idx_promotions_audience_active").on(table.audience, table.active),
}));

// The grant as it was given. `days` is copied from the promotion so editing or
// deactivating one cannot rewrite what people already received, and
// (user_id, promotion_id) is unique so the same grant cannot be claimed twice.
export const promotionRedemptions = sqliteTable("promotion_redemptions", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  promotionId: integer("promotion_id").references(() => promotions.id, { onDelete: "cascade" }).notNull(),
  days: integer("days").notNull(),
  source: text("source", { enum: ["signup", "code"] }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  userPromotionUq: uniqueIndex("uq_promotion_redemption_user_promo").on(table.userId, table.promotionId),
  promotionIdx: index("idx_promotion_redemption_promo").on(table.promotionId),
}));

export type Promotion = typeof promotions.$inferSelect;
export type InsertPromotion = typeof promotions.$inferInsert;
export type PromotionRedemption = typeof promotionRedemptions.$inferSelect;

// ─── DEVICE AUTHORIZATION (V3 local-first, L3) ──────────────────────
// OAuth-style device flow for linking a local install to a marketplace
// account: the local app shows a short user code, the user approves on the
// hosted site while logged in, and the local install exchanges the device
// code for a long-lived token. Codes expire quickly and are single-use.
export const deviceCodes = sqliteTable("device_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }).notNull(),
  deviceCode: text("device_code").notNull(),
  userCode: text("user_code").notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["pending", "approved", "denied"] }).default("pending").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).defaultNow().notNull(),
}, (table) => ({
  deviceCodeUq: uniqueIndex("uq_device_codes_device_code").on(table.deviceCode),
  userCodeUq: uniqueIndex("uq_device_codes_user_code").on(table.userCode),
}));

export type DeviceCode = typeof deviceCodes.$inferSelect;
