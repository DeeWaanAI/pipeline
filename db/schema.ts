import {
  mysqlTable,
  int,
  mysqlEnum,
  varchar,
  text,
  mediumtext,
  boolean,
  bigint,
  timestamp,
  json,
  decimal,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/mysql-core";

// ─── USERS (supports both Kimi OAuth and local username/password) ────
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey().notNull(),
  unionId: varchar("unionId", { length: 255 }).unique(),
  username: varchar("username", { length: 100 }).unique(),
  passwordHash: varchar("password_hash", { length: 255 }),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  avatar: text("avatar"),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  tier: mysqlEnum("tier", ["standard", "pro_designer", "pro_auto"]).default("standard").notNull(),
  // User-level default LLM provider (nullable — falls back to per-project or system default).
  // NOTE: No FK reference to llmProviders.id to avoid circular type inference (llmProviders
  // references users below). Integrity enforced at app level.
  defaultProviderId: int("default_provider_id"),
  defaultModel: varchar("default_model", { length: 100 }),
  // Persisted UI preferences / user data (survives DB wipes, new deployments)
  preferences: json("preferences").$type<{
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
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  lastSignInAt: timestamp("lastSignInAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── LLM PROVIDERS (plugin configurations) ──────────────────────────
export const llmProviders = mysqlTable("llm_providers", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull(),
  baseUrl: varchar("base_url", { length: 512 }).notNull(),
  // TEXT, not varchar(255): encrypted keys are salt:iv:authTag:ciphertext (131 chars
  // overhead + 2x key length) — modern OpenAI/Anthropic/Aliyun keys (100–165 chars)
  // overflow 255 and made createProvider fail with "Data too long" (migration 020).
  apiKeyRef: text("api_key_ref").notNull(),
  defaultModel: varchar("default_model", { length: 100 }).notNull(),
  models: json("models").$type<string[]>(),
  config: json("config").$type<{
    temperature?: number;
    topP?: number;
    timeout?: number;
    declaredRpm?: number; // user-declared provider tier RPM (Research Mode)
  }>(),
  isEnabled: boolean("is_enabled").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow(),
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
export const declaredModelPrices = mysqlTable("declared_model_prices", {
  id: int("id").autoincrement().primaryKey().notNull(),
  providerRefId: int("provider_ref_id")
    .references(() => llmProviders.id, { onDelete: "cascade" })
    .notNull(),
  modelId: varchar("model_id", { length: 191 }).notNull(),
  inputUsdPerMillion: decimal("input_usd_per_million", { precision: 18, scale: 8 }).notNull(),
  outputUsdPerMillion: decimal("output_usd_per_million", { precision: 18, scale: 8 }).notNull(),
  createdBy: int("created_by")
    .references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  providerModelUq: uniqueIndex("uq_declared_price_provider_model").on(table.providerRefId, table.modelId),
}));

// ─── PROJECTS ──────────────────────────────────────────────────────
export const projects = mysqlTable("projects", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  giteeOwner: varchar("gitee_owner", { length: 100 }),
  giteeRepo: varchar("gitee_repo", { length: 100 }),
  giteeBranch: varchar("gitee_branch", { length: 100 }).default("main"),
  // GitHub integration (parallel to Gitee)
  githubOwner: varchar("github_owner", { length: 100 }),
  githubRepo: varchar("github_repo", { length: 100 }),
  githubBranch: varchar("github_branch", { length: 100 }).default("main"),
  localFolderName: varchar("local_folder_name", { length: 255 }),
  stateSummaryPath: varchar("state_summary_path", { length: 255 })
    .default(".ai-swarm/project-state.md"),
  defaultProviderId: int("default_provider_id")
    .references(() => llmProviders.id),
  defaultModel: varchar("default_model", { length: 100 }),
  pipelineConfig: json("pipeline_config").$type<{
    maxIterations?: number;
    enabledAgents?: string[];
    stopOnNoImprovement?: boolean;
  }>(),
  pipelineTemplateId: int("pipeline_template_id"), // References reusable template (nullable)
  // ─── LINEAGE: the account that ORIGINALLY created the work this pipeline
  // derives from. NULL (or equal to `user_id`) means "this account made it".
  // Set when a pipeline is cloned out of a share or an import, so a copy can
  // never launder provenance and a recipient can never sell what they were
  // only lent. No FK by design: the name outlives the account, and an FK here
  // would add a new delete constraint on `users`.
  originCreatorId: int("origin_creator_id"),
  isArchived: boolean("is_archived").default(false),
  lastSyncedAt: timestamp("last_synced_at"),
  // Project Intelligence Card (compact JSON, not file contents)
  intelligenceCard: json("intelligence_card").$type<{
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
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow(),
}, (table) => ({
  userIdIdx: index("idx_projects_user_id").on(table.userId),
}));

// ─── AGENTS ────────────────────────────────────────────────────────
export const agents = mysqlTable("agents", {
  id: int("id").autoincrement().primaryKey().notNull(),
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull(),
  role: varchar("role", { length: 50 }).notNull(),
  systemPrompt: text("system_prompt").notNull(),
  providerId: int("provider_id")
    .references(() => llmProviders.id),
  model: varchar("model", { length: 100 }),
  temperature: varchar("temperature", { length: 10 }).default("0.7"),
  maxTokens: int("max_tokens").default(4096),
  pipelineOrder: int("pipeline_order").default(0),
  maxIterations: int("max_iterations").default(1),
  isEnabled: boolean("is_enabled").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── SWARM RUNS ────────────────────────────────────────────────────
export const swarmRuns = mysqlTable("swarm_runs", {
  id: int("id").autoincrement().primaryKey().notNull(),
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  userId: int("user_id")
    .references(() => users.id)
    .notNull(),
  userPrompt: mediumtext("user_prompt").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  currentStep: varchar("current_step", { length: 50 }).default("init"),
  pipelineVersion: varchar("pipeline_version", { length: 20 }).default("cascade-v1"),
  agentsUsed: json("agents_used").$type<string[]>(),
  iterationsUsed: int("iterations_used").default(0),
  // Test mode: when running a pipeline for testing/marketplace review purposes
  isTestRun: boolean("is_test_run").default(false),
  testFixtureId: int("test_fixture_id"), // References a test fixture ZIP if applicable
  finalResponseId: int("final_response_id"),
  totalTokensUsed: int("total_tokens_used"),
  totalLatencyMs: int("total_latency_ms"),
  // For resumable pipeline execution (human-in-the-loop, etc.)
  executionState: json("execution_state").$type<{
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
  runParams: json("run_params").$type<{
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
  startedAt: timestamp("started_at").defaultNow(),
  completedAt: timestamp("completed_at"),
  // Batch membership (Research Mode): NULL = standalone run
  batchId: int("batch_id"),
  error: text("error"),
}, (table) => ({
  projectIdIdx: index("idx_swarm_runs_project_id").on(table.projectId),
  userIdIdx: index("idx_swarm_runs_user_id").on(table.userId),
  statusIdx: index("idx_swarm_runs_status").on(table.status),
  batchIdIdx: index("idx_swarm_runs_batch_id").on(table.batchId),
}));

// ─── SWARM BATCHES (Research Mode: batch run groups) ───────────────
export const swarmBatches = mysqlTable("swarm_batches", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  name: varchar("name", { length: 200 }),
  status: varchar("status", { length: 30 }).notNull().default("running"),
  totalRuns: int("total_runs").notNull(),
  completedRuns: int("completed_runs").notNull().default(0),
  failedRuns: int("failed_runs").notNull().default(0),
  totalTokensUsed: int("total_tokens_used").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  userIdIdx: index("idx_swarm_batches_user_id").on(table.userId),
  projectIdIdx: index("idx_swarm_batches_project_id").on(table.projectId),
  statusIdx: index("idx_swarm_batches_status").on(table.status),
}));

// ─── AGENT RUNS ────────────────────────────────────────────────────
export const agentRuns = mysqlTable("agent_runs", {
  id: int("id").autoincrement().primaryKey().notNull(),
  swarmRunId: int("swarm_run_id")
    .references(() => swarmRuns.id, { onDelete: "cascade" })
    .notNull(),
  agentId: int("agent_id"), // References custom_agents.id (no FK — legacy agents table may not have the agent)
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  agentName: varchar("agent_name", { length: 100 }).notNull(),
  agentRole: varchar("agent_role", { length: 50 }).notNull(),
  pipelineStep: int("pipeline_step").notNull(),
  iteration: int("iteration").default(1),
  systemPrompt: mediumtext("system_prompt"),
  userPrompt: mediumtext("user_prompt").notNull(),
  contextInput: mediumtext("context_input"),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  tokensUsed: int("tokens_used"),
  latencyMs: int("latency_ms"),
  modelUsed: varchar("model_used", { length: 100 }),
  providerUsed: varchar("provider_used", { length: 100 }),
  startedAt: timestamp("started_at").defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  swarmRunIdIdx: index("idx_agent_runs_swarm_run_id").on(table.swarmRunId),
  projectIdIdx: index("idx_agent_runs_project_id").on(table.projectId),
}));

// ─── AGENT RESPONSES ───────────────────────────────────────────────
const agentResponsesTable = mysqlTable("agent_responses", {
  id: int("id").autoincrement().primaryKey().notNull(),
  agentRunId: int("agent_run_id")
    .references(() => agentRuns.id, { onDelete: "cascade" })
    .notNull(),
  swarmRunId: int("swarm_run_id")
    .references(() => swarmRuns.id, { onDelete: "cascade" })
    .notNull(),
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  parentResponseId: int("parent_response_id"),
  responseType: varchar("response_type", { length: 20 }).notNull(),
  content: mediumtext("content").notNull(),
  metadata: json("metadata").$type<{
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
  humanReviewed: boolean("human_reviewed").default(false),
  humanNotes: text("human_notes"),
  isFlagged: boolean("is_flagged").default(false),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  swarmRunIdIdx: index("idx_agent_responses_swarm_run_id").on(table.swarmRunId),
  agentRunIdIdx: index("idx_agent_responses_agent_run_id").on(table.agentRunId),
  projectIdIdx: index("idx_agent_responses_project_id").on(table.projectId),
}));

export { agentResponsesTable as agentResponses };

// ─── DEBUG LOGS ────────────────────────────────────────────────────
export const debugLogs = mysqlTable("debug_logs", {
  id: int("id").autoincrement().primaryKey().notNull(),
  swarmRunId: int("swarm_run_id")
    .references(() => swarmRuns.id, { onDelete: "cascade" })
    .notNull(),
  agentRunId: int("agent_run_id")
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  promptId: varchar("prompt_id", { length: 64 }).notNull(),
  agentName: varchar("agent_name", { length: 100 }).notNull(),
  eventType: varchar("event_type", { length: 20 }).notNull(),
  payload: json("payload").$type<{
    message: string;
    details?: Record<string, unknown>;
    latencyMs?: number;
    tokensUsed?: number;
  }>().notNull(),
  timestamp: timestamp("timestamp").defaultNow(),
}, (table) => ({
  swarmRunIdIdx: index("idx_debug_logs_swarm_run_id").on(table.swarmRunId),
  projectIdIdx: index("idx_debug_logs_project_id").on(table.projectId),
}));

// ─── PROJECT FILES ─────────────────────────────────────────────────
export const projectFiles = mysqlTable("project_files", {
  id: int("id").autoincrement().primaryKey().notNull(),
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  path: varchar("path", { length: 500 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  mimeType: varchar("mime_type", { length: 100 }),
  sizeBytes: int("size_bytes"),
  content: text("content"), // Text content for AI reading
  isDirectory: boolean("is_directory").default(false),
  parentPath: varchar("parent_path", { length: 500 }),
  giteeSha: varchar("gitee_sha", { length: 64 }),
  lastSyncedAt: timestamp("last_synced_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  projectIdIdx: index("idx_project_files_project_id").on(table.projectId),
  pathIdx: index("idx_project_files_path").on(table.projectId, table.path),
}));

// ─── PROJECT FILE CONTENTS (local storage for fast LLM access) ─────
// Stores full text content of imported project files.
// Used by Phase 2: the LLM sees the Intelligence Card, requests specific
// files by path, and we fetch their contents from this table (no Gitee round-trip).
export const projectFileContents = mysqlTable("project_file_contents", {
  id: int("id").autoincrement().primaryKey().notNull(),
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  path: varchar("path", { length: 500 }).notNull(),
  content: text("content").notNull(), // Full file text content
  sizeBytes: int("size_bytes"),
  language: varchar("language", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── FILE DEPENDENCIES (cross-file awareness) ──────────────────────
export const fileDependencies = mysqlTable("file_dependencies", {
  id: int("id").autoincrement().primaryKey().notNull(),
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  sourceFileId: int("source_file_id").notNull(),
  targetFileId: int("target_file_id").notNull(),
  importType: varchar("import_type", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  sourceFileIdx: index("idx_file_deps_source").on(table.sourceFileId),
  targetFileIdx: index("idx_file_deps_target").on(table.targetFileId),
}));

// ─── API KEY STORE ─────────────────────────────────────────────────
export const apiKeyStore = mysqlTable("api_key_store", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  providerSlug: varchar("provider_slug", { length: 100 }).notNull(),
  encryptedKey: text("encrypted_key").notNull(),
  salt: varchar("salt", { length: 64 }).notNull(),
  iterations: int("iterations").default(480000),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── CUSTOM AGENTS (Pro Designer: user's reusable agent library) ───
export const customAgents = mysqlTable("custom_agents", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull(),
  role: varchar("role", { length: 50 }).notNull(), // builder, critic, reviewer, refiner, translator, summarizer, custom
  systemPrompt: text("system_prompt").notNull(),
  defaultProviderId: int("default_provider_id")
    .references(() => llmProviders.id),
  defaultModel: varchar("default_model", { length: 100 }),
  temperature: varchar("temperature", { length: 10 }).default("0.7"),
  maxTokens: int("max_tokens").default(4096),
  description: text("description"), // What this agent does (shown in UI)
  isTemplate: boolean("is_template").default(false), // Pre-built templates users can clone
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  userIdIdx: index("idx_custom_agents_user_id").on(table.userId),
  slugIdx: index("idx_custom_agents_slug").on(table.userId, table.slug),
}));

// ─── PIPELINE STEPS (Pro Designer: per-project agent sequence) ─────
export const pipelineSteps = mysqlTable("pipeline_steps", {
  id: int("id").autoincrement().primaryKey().notNull(),
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  stepOrder: int("step_order").notNull(), // 1, 2, 3, ... execution order
  agentId: int("agent_id")
    .references(() => customAgents.id, { onDelete: "cascade" }),
  // Step type: agent (normal), if (conditional branch), while (loop), approval (human-in-the-loop)
  stepType: varchar("step_type", { length: 20 }).default("agent").notNull(),
  providerId: int("provider_id")
    .references(() => llmProviders.id), // Override: which LLM to use for this step
  model: varchar("model", { length: 100 }), // Override: which specific model to use
  name: varchar("name", { length: 100 }).notNull(), // Display name
  role: varchar("role", { length: 50 }).notNull(),
  systemPrompt: text("system_prompt").notNull(), // Can be customized per pipeline
  temperature: varchar("temperature", { length: 10 }).default("0.7"),
  maxTokens: int("max_tokens").default(4096),
  // For IF steps: { options: ["polish","rewrite"], mappings: { "polish": 4, "rewrite": 2 } }
  ifConfig: json("if_config").$type<{ options: string[]; mappings: Record<string, number> } | null>(),
  // For WHILE steps: { targetStep: 2, maxIterations: 3 }
  whileConfig: json("while_config").$type<{ targetStep: number; maxIterations: number } | null>(),
  isEnabled: boolean("is_enabled").default(true),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  projectIdIdx: index("idx_pipeline_steps_project_id").on(table.projectId),
  orderIdx: index("idx_pipeline_steps_order").on(table.projectId, table.stepOrder),
}));

// ─── PIPELINE TEMPLATES (reusable pipelines across chats) ──────────
export const pipelineTemplates = mysqlTable("pipeline_templates", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  steps: json("steps").$type<Array<{
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
  isAuto: boolean("is_auto").default(false).notNull(),
  sourceProjectId: int("source_project_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ═════════════════════════════════════════════════════════════════════
// MARKETPLACE MODULE
// ═════════════════════════════════════════════════════════════════════

// ─── MARKETPLACE LISTINGS ──────────────────────────────────────────
export const marketplaceListings = mysqlTable("marketplace_listings", {
  id: int("id").autoincrement().primaryKey().notNull(),
  creatorId: int("creator_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  templateId: int("template_id")
    .references(() => pipelineTemplates.id, { onDelete: "cascade" })
    .notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  description: text("description"),
  // Structured description fields for better test generation & reviewer clarity
  objectives: text("objectives"),        // What the pipeline aims to accomplish
  inputFormat: text("input_format"),      // Expected format of user input
  outputFormat: text("output_format"),    // Expected format of pipeline output
  remarks: text("remarks"),               // Additional notes for reviewers
  category: mysqlEnum("category", [
    "translation",
    "writing",
    "code",
    "analysis",
    "creative",
    "other",
  ]).default("other"),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  isSubscription: boolean("is_subscription").default(false),
  subscriptionPrice: decimal("subscription_price", { precision: 10, scale: 2 }),
  status: mysqlEnum("status", [
    "draft",
    "generating",      // test data generation in progress (background)
    "pending_review",  // waiting for reviewers (legacy human-assignment flow)
    "reviewing",       // reviewers are working (legacy human-assignment flow)
    "certifying",      // VISIBLE in marketplace but NOT buyable — blind human review pool (spec 0.1)
    "rejected",
    "approved",
    "published",       // BUYABLE & human-certified
    "unpublished",
  ]).default("draft"),
  grade: decimal("grade", { precision: 3, scale: 2 }),
  reviewCount: int("review_count").default(0),
  kappaScore: decimal("kappa_score", { precision: 4, scale: 3 }),
  aiCorrelation: decimal("ai_correlation", { precision: 4, scale: 3 }),
  // AI Ensemble Review (Phase 1: automated certification before human review)
  aiGrade: decimal("ai_grade", { precision: 3, scale: 2 }),
  aiKappaScore: decimal("ai_kappa_score", { precision: 4, scale: 3 }),
  aiFeedback: text("ai_feedback"),
  aiReviewedAt: timestamp("ai_reviewed_at"),
  // Set when blind human review certifies the listing into `published` (spec 0.8).
  // Joined later against refunds/reports to tune triage floor and thresholds.
  certifiedAt: timestamp("certified_at"),
  salesCount: int("sales_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow(),
});

// ─── TEST PROMPTS (auto-generated for each listing) ────────────────
export const testPrompts = mysqlTable("test_prompts", {
  id: int("id").autoincrement().primaryKey().notNull(),
  listingId: int("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  promptIndex: int("prompt_index").notNull(),
  category: mysqlEnum("category", ["simple", "medium", "complex", "edge", "adversarial"]).notNull(),
  inputText: text("input_text").notNull(),
  actualOutput: text("actual_output"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── LISTING REVIEWS (human reviews) ───────────────────────────────
export const listingReviews = mysqlTable("listing_reviews", {
  id: int("id").autoincrement().primaryKey().notNull(),
  listingId: int("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  reviewerId: int("reviewer_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  promptIndex: int("prompt_index").notNull(),
  accuracy: int("accuracy").notNull(),
  completeness: int("completeness").notNull(),
  clarity: int("clarity").notNull(),
  tokenEfficiency: int("token_efficiency").notNull(),
  speed: int("speed").notNull(),
  consistency: int("consistency").notNull(),
  weightedScore: decimal("weighted_score", { precision: 4, scale: 2 }).notNull(),
  reviewTime: int("review_time").notNull(), // seconds spent
  flagged: boolean("flagged").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── AI ENSEMBLE REVIEWS ───────────────────────────────────────────
export const aiEnsembleReviews = mysqlTable("ai_ensemble_reviews", {
  id: int("id").autoincrement().primaryKey().notNull(),
  listingId: int("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  promptIndex: int("prompt_index").notNull(),
  providerId: int("provider_id")
    .references(() => llmProviders.id, { onDelete: "cascade" }),
  modelSlug: varchar("model_slug", { length: 100 }),
  accuracy: int("accuracy"),
  completeness: int("completeness"),
  clarity: int("clarity"),
  tokenEfficiency: int("token_efficiency"),
  speed: int("speed"),
  consistency: int("consistency"),
  weightedScore: decimal("weighted_score", { precision: 4, scale: 2 }),
  rawResponse: text("raw_response"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── REVIEWER PROFILES ─────────────────────────────────────────────
export const reviewerProfiles = mysqlTable("reviewer_profiles", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  trustScore: int("trust_score").default(100),
  reviewsCompleted: int("reviews_completed").default(0),
  reviewsFlagged: int("reviews_flagged").default(0),
  arbiterRulingsAgainst: int("arbiter_rulings_against").default(0),
  // Points system (MVP: reviewers earn points → redeem for subscription days)
  pointsEarned: int("points_earned").default(0),
  pointsBalance: int("points_balance").default(0),
  // Subscription days earned from point redemption
  subscriptionDays: int("subscription_days").default(0),
  isActive: boolean("is_active").default(true),
  status: mysqlEnum("status", ["active", "suspended", "banned"]).default("active"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow(),
});

// ─── REVIEW ASSIGNMENTS ────────────────────────────────────────────
export const reviewAssignments = mysqlTable("review_assignments", {
  id: int("id").autoincrement().primaryKey().notNull(),
  listingId: int("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  reviewerId: int("reviewer_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  status: mysqlEnum("status", ["pending", "in_progress", "completed", "overdue"]).default("pending"),
  assignedAt: timestamp("assigned_at").defaultNow(),
  dueAt: timestamp("due_at"),
  completedAt: timestamp("completed_at"),
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
export const blindReviewTasks = mysqlTable("blind_review_tasks", {
  id: int("id").autoincrement().primaryKey().notNull(),
  listingId: int("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  promptIndex: int("prompt_index").notNull(),
  reviewerId: int("reviewer_id")
    .references(() => users.id, { onDelete: "cascade" }),
  status: mysqlEnum("status", ["pooled", "assigned", "completed", "expired"]).default("pooled"),
  assignedAt: timestamp("assigned_at"),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  listingPromptReviewerUniq: uniqueIndex("uq_blind_review_tasks_listing_prompt_reviewer")
    .on(table.listingId, table.promptIndex, table.reviewerId),
  poolIdx: index("idx_blind_review_tasks_pool").on(table.status, table.listingId),
}));

// ─── CREATOR DEPOSITS (review cost tracking) ──────────────────────
export const creatorDeposits = mysqlTable("creator_deposits", {
  id: int("id").autoincrement().primaryKey().notNull(),
  creatorId: int("creator_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  listingId: int("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  depositType: mysqlEnum("deposit_type", ["ai_test", "human_review"]).notNull(),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  tokensUsed: int("tokens_used"),
  status: mysqlEnum("status", ["pending", "completed", "refunded", "partial_refund"]).default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

// ─── REFUND LEDGER ─────────────────────────────────────────────────
export const refundLedger = mysqlTable("refund_ledger", {
  id: int("id").autoincrement().primaryKey().notNull(),
  creatorId: int("creator_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  listingId: int("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  depositId: int("deposit_id")
    .references(() => creatorDeposits.id, { onDelete: "cascade" })
    .notNull(),
  saleId: int("sale_id").notNull(),
  commissionEarned: decimal("commission_earned", { precision: 10, scale: 2 }).notNull(),
  amountRefunded: decimal("amount_refunded", { precision: 10, scale: 2 }).notNull(),
  isFullyRefunded: boolean("is_fully_refunded").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── MARKETPLACE PURCHASES ─────────────────────────────────────────
export const marketplacePurchases = mysqlTable("marketplace_purchases", {
  id: int("id").autoincrement().primaryKey().notNull(),
  buyerId: int("buyer_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  listingId: int("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  amountPaid: decimal("amount_paid", { precision: 10, scale: 2 }).notNull(),
  platformFee: decimal("platform_fee", { precision: 10, scale: 2 }).notNull(),
  creatorEarnings: decimal("creator_earnings", { precision: 10, scale: 2 }).notNull(),
  isSubscription: boolean("is_subscription").default(false),
  subscriptionEnd: timestamp("subscription_end"),
  status: mysqlEnum("status", ["active", "refunded", "cancelled"]).default("active"),
  // Stripe references (Phase 1): fulfillment + refund matching
  stripeSessionId: varchar("stripe_session_id", { length: 100 }),
  stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 100 }),
  workflowVersionId: int("workflow_version_id"),
  evidencePublicationId: int("evidence_publication_id"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  versionFk: foreignKey({ name: "fk_purchase_workflow_version", columns: [table.workflowVersionId], foreignColumns: [pipelineVersions.id] }).onDelete("restrict"),
  evidenceFk: foreignKey({ name: "fk_purchase_evidence_publication", columns: [table.evidencePublicationId], foreignColumns: [evidencePublications.id] }).onDelete("restrict"),
}));

// ─── TEST PROMPT INTERMEDIATE RESPONSES ──────────────────────────
// Stores every agent step's output for every test prompt run
export const testPromptIntermediate = mysqlTable("test_prompt_intermediate", {
  id: int("id").autoincrement().primaryKey().notNull(),
  testPromptId: int("test_prompt_id")
    .references(() => testPrompts.id, { onDelete: "cascade" })
    .notNull(),
  stepIndex: int("step_index").notNull(),         // which pipeline step (0, 1, 2...)
  stepName: varchar("step_name", { length: 100 }).notNull(),
  stepRole: varchar("step_role", { length: 50 }),
  inputText: text("input_text").notNull(),         // what this agent received
  outputText: text("output_text").notNull(),       // what this agent produced
  tokensUsed: int("tokens_used"),                  // token count if available
  latencyMs: int("latency_ms"),                    // response time
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── ENCRYPTED PROMPTS ─────────────────────────────────────────────
export const encryptedPrompts = mysqlTable("encrypted_prompts", {
  id: int("id").autoincrement().primaryKey().notNull(),
  listingId: int("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .notNull(),
  agentIndex: int("agent_index").notNull(),
  encryptedPrompt: text("encrypted_prompt").notNull(),
  iv: varchar("iv", { length: 64 }).notNull(),
  version: int("version").default(1),
  createdAt: timestamp("created_at").defaultNow(),
});

// ═══════════════════════════════════════════════════════════════════════
// TEAM & BETA TESTING SYSTEM
// ═══════════════════════════════════════════════════════════════════════

// ─── TEAMS ───────────────────────────────────────────────────────────
export const teams = mysqlTable("teams", {
  id: int("id").autoincrement().primaryKey().notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  ownerId: int("owner_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  inviteCode: varchar("invite_code", { length: 32 }).unique(),
  inviteQrUrl: text("invite_qr_url"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── TEAM MEMBERS ────────────────────────────────────────────────────
export const teamMembers = mysqlTable("team_members", {
  id: int("id").autoincrement().primaryKey().notNull(),
  teamId: int("team_id")
    .references(() => teams.id, { onDelete: "cascade" })
    .notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  role: mysqlEnum("role", ["owner", "admin", "tester", "viewer"])
    .default("tester")
    .notNull(),
  joinedAt: timestamp("joined_at").defaultNow(),
  lastActiveAt: timestamp("last_active_at").defaultNow(),
  engagementScore: int("engagement_score").default(0),
}, (table) => ({
  userIdIdx: index("idx_team_members_user_id").on(table.userId),
  teamIdIdx: index("idx_team_members_team_id").on(table.teamId),
  teamUserUniq: uniqueIndex("uq_team_members_team_user").on(table.teamId, table.userId),
}));

// ─── TEAM PROJECTS (shared projects) ─────────────────────────────────
export const teamProjects = mysqlTable("team_projects", {
  id: int("id").autoincrement().primaryKey().notNull(),
  teamId: int("team_id")
    .references(() => teams.id, { onDelete: "cascade" })
    .notNull(),
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  addedBy: int("added_by")
    .references(() => users.id)
    .notNull(),
  addedAt: timestamp("added_at").defaultNow(),
}, (table) => ({
  teamIdIdx: index("idx_team_projects_team_id").on(table.teamId),
  projectIdIdx: index("idx_team_projects_project_id").on(table.projectId),
  teamProjectUniq: uniqueIndex("uq_team_projects_team_project").on(table.teamId, table.projectId),
}));

// ─── TEST FIXTURES (reusable test project ZIPs for pipeline testing) ──
// Users/teams upload ZIPs here once; pipelines reference them during test runs.
export const testFixtures = mysqlTable("test_fixtures", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  teamId: int("team_id")
    .references(() => teams.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  // Complexity tag — helps match pipelines to appropriate test projects
  complexity: mysqlEnum("complexity", ["easy", "medium", "complex"]).default("medium"),
  // Where the ZIP is stored (disk path under data/test-fixtures/<id>.zip)
  storagePath: varchar("storage_path", { length: 500 }).notNull(),
  sizeBytes: int("size_bytes"),
  fileCount: int("file_count").default(0),
  // Optional Gitee mirror path for syncing with team
  giteePath: varchar("gitee_path", { length: 500 }),
  isPublic: boolean("is_public").default(false),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  userIdIdx: index("idx_test_fixtures_user_id").on(table.userId),
  teamIdIdx: index("idx_test_fixtures_team_id").on(table.teamId),
}));

// ─── USER PRIVACY CONSENT ────────────────────────────────────────────
export const userPrivacyConsent = mysqlTable("user_privacy_consent", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  allowPromptStorage: boolean("allow_prompt_storage").default(true),
  allowFeedbackStorage: boolean("allow_feedback_storage").default(true),
  allowScreenshots: boolean("allow_screenshots").default(true),
  allowConversationHistory: boolean("allow_conversation_history").default(false),
  consentedAt: timestamp("consented_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
});

// ─── FEEDBACK (messages + general UI feedback) ───────────────────────
export const feedback = mysqlTable("feedback", {
  id: int("id").autoincrement().primaryKey().notNull(),
  teamId: int("team_id")
    .references(() => teams.id, { onDelete: "cascade" }),
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" }),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  targetType: mysqlEnum("target_type", ["message", "ui", "general"])
    .default("general")
    .notNull(),
  targetMessageId: int("target_message_id"),
  feedbackType: mysqlEnum("feedback_type", ["bug", "suggestion", "praise", "confusion"])
    .notNull(),
  severity: mysqlEnum("severity", ["critical", "major", "minor", "cosmetic"])
    .default("minor"),
  content: text("content").notNull(),
  screenshotUrl: text("screenshot_url"),
  contextJson: json("context_json").$type<{
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
  tagsJson: json("tags_json").$type<string[] | null>(),
  status: mysqlEnum("status", ["new", "triaged", "in_progress", "resolved", "verified", "closed"])
    .default("new")
    .notNull(),
  assignedTo: int("assigned_to")
    .references(() => users.id),
  convertedToIssueId: int("converted_to_issue_id"),
  createdAt: timestamp("created_at").defaultNow(),
  resolvedAt: timestamp("resolved_at"),
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
export const feedbackAttachments = mysqlTable("feedback_attachments", {
  id: int("id").autoincrement().primaryKey().notNull(),
  // Cascade WITH the feedback item and only that way: an attachment is a
  // receipt attached to one feedback row, and deleting the feedback ends its
  // purpose. It never reaches back into the attached object — that object is
  // the user's pipeline/run/benchmark row and stays exactly where it is.
  feedbackId: int("feedback_id")
    .references(() => feedback.id, { onDelete: "cascade" })
    .notNull(),
  // The consenting author. Same account rules the read back: an attachment is
  // visible to the account that consented to it (and to support).
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  // The three objects this product actually has: a pipeline (a project and its
  // steps), a run of one, and a benchmark. No fourth kind, and nothing here
  // about teams, workspaces or orgs — those concepts are deleted.
  kind: mysqlEnum("kind", ["pipeline", "run", "benchmark"]).notNull(),
  // The object's own id: `projects.id`, `swarm_runs.id` or `benchmarks.id`.
  // Deliberately NOT a foreign key: the consent is to the SNAPSHOT, and the
  // receipt must still be readable after the user deletes the object it
  // describes. An FK here would either cascade into the feedback row or block
  // a legitimate delete, and neither is what a feedback receipt means.
  refId: int("ref_id").notNull(),
  consentVersion: varchar("consent_version", { length: 40 }).notNull(),
  // Canonical JSON snapshot (same storage choice as `pipeline_versions
  // .definition`: a frozen blob that can legitimately be large).
  snapshot: mediumtext("snapshot").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  feedbackIdx: index("idx_feedback_attachments_feedback_id").on(table.feedbackId),
  userIdIdx: index("idx_feedback_attachments_user_id").on(table.userId),
  // "which objects has this feedback been about?" — the support-side lookup.
  kindRefIdx: index("idx_feedback_attachments_kind_ref").on(table.kind, table.refId),
}));

export type FeedbackAttachment = typeof feedbackAttachments.$inferSelect;
export type InsertFeedbackAttachment = typeof feedbackAttachments.$inferInsert;

// ─── ISSUES (derived from feedback or created manually) ──────────────
export const issues = mysqlTable("issues", {
  id: int("id").autoincrement().primaryKey().notNull(),
  teamId: int("team_id")
    .references(() => teams.id, { onDelete: "cascade" }),
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  priority: mysqlEnum("priority", ["p0", "p1", "p2", "p3"])
    .default("p2")
    .notNull(),
  status: mysqlEnum("status", ["open", "in_progress", "resolved", "verified", "closed"])
    .default("open")
    .notNull(),
  assigneeId: int("assignee_id")
    .references(() => users.id),
  relatedFeedbackIdsJson: json("related_feedback_ids_json").$type<number[] | null>(),
  resolutionNotes: text("resolution_notes"),
  createdBy: int("created_by")
    .references(() => users.id)
    .notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  resolvedAt: timestamp("resolved_at"),
}, (table) => ({
  teamIdIdx: index("idx_issues_team_id").on(table.teamId),
  projectIdIdx: index("idx_issues_project_id").on(table.projectId),
  statusIdx: index("idx_issues_status").on(table.status),
}));

// ─── FIX VERIFICATIONS ───────────────────────────────────────────────
export const fixVerifications = mysqlTable("fix_verifications", {
  id: int("id").autoincrement().primaryKey().notNull(),
  issueId: int("issue_id")
    .references(() => issues.id, { onDelete: "cascade" })
    .notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  status: mysqlEnum("status", ["pending", "verified", "failed"])
    .default("pending")
    .notNull(),
  testerComment: text("tester_comment"),
  createdAt: timestamp("created_at").defaultNow(),
  verifiedAt: timestamp("verified_at"),
});

// ─── ACTIVITY LOG (for engagement scoring) ───────────────────────────
export const activityLog = mysqlTable("activity_log", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  teamId: int("team_id")
    .references(() => teams.id, { onDelete: "cascade" }),
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" }),
  action: mysqlEnum("action", [
    "sent_message",
    "gave_feedback",
    "ran_pipeline",
    "imported_project",
    "viewed_dashboard",
    "created_issue",
    "verified_fix",
  ]).notNull(),
  metadataJson: json("metadata_json").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  userIdIdx: index("idx_activity_log_user_id").on(table.userId),
  teamIdIdx: index("idx_activity_log_team_id").on(table.teamId),
}));

// ─── CHANGELOG ENTRIES ───────────────────────────────────────────────
export const changelogEntries = mysqlTable("changelog_entries", {
  id: int("id").autoincrement().primaryKey().notNull(),
  teamId: int("team_id")
    .references(() => teams.id, { onDelete: "cascade" })
    .notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  relatedIssueIdsJson: json("related_issue_ids_json").$type<number[] | null>(),
  releasedAt: timestamp("released_at").defaultNow(),
});

// ─── FEATURE FLAGS ───────────────────────────────────────────────────
// Enables modular architecture: features can be toggled per-deployment,
// per-user, or rolled out gradually. Used by the plugin system.
export const featureFlags = mysqlTable("feature_flags", {
  id: int("id").autoincrement().primaryKey().notNull(),
  key: varchar("key", { length: 50 }).notNull().unique(),   // e.g. "circuit_breaker"
  name: varchar("name", { length: 100 }).notNull(),         // human-readable
  description: text("description"),
  enabled: boolean("enabled").default(false).notNull(),     // master switch
  rolloutPercent: int("rollout_percent").default(0),        // 0=off, 100=all
  allowedUserIds: json("allowed_user_ids").$type<number[] | null>(), // beta testers
  pluginId: varchar("plugin_id", { length: 50 }),           // links to plugin
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
});

// ─── VOUCHERS (beta tester tier access) ─────────────────────────────
export const vouchers = mysqlTable("vouchers", {
  id: int("id").autoincrement().primaryKey().notNull(),
  code: varchar("code", { length: 32 }).notNull().unique(),
  tier: mysqlEnum("tier", ["pro_designer", "pro_auto"]).notNull(),
  durationDays: int("duration_days").notNull().default(30),
  maxUses: int("max_uses").notNull().default(1),
  usedCount: int("used_count").notNull().default(0),
  label: varchar("label", { length: 200 }),
  expiresAt: timestamp("expires_at"),
  createdBy: int("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── NOTIFICATIONS ──────────────────────────────────────────────────
export const notifications = mysqlTable("notifications", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  type: varchar("type", { length: 50 }).notNull(), // pipeline_complete, pipeline_error, team_invite, etc.
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message"),
  dataJson: json("data_json").$type<Record<string, unknown> | null>(),
  isRead: boolean("is_read").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  userIdIdx: index("idx_notifications_user_id").on(table.userId),
  unreadIdx: index("idx_notifications_unread").on(table.userId, table.isRead),
}));

export type FeatureFlag = typeof featureFlags.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════
// FOUNDATION SPRINT (F0) — billing, entitlements, usage, tokens
// ═══════════════════════════════════════════════════════════════════════

// ─── SUBSCRIPTIONS (Stripe-backed; user or team scope) ──────────────
export const subscriptions = mysqlTable("subscriptions", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id").references(() => users.id, { onDelete: "cascade" }),
  teamId: int("team_id").references(() => teams.id, { onDelete: "cascade" }),
  plan: varchar("plan", { length: 50 }).notNull(),
  status: varchar("status", { length: 30 }).notNull().default("active"),
  stripeCustomerId: varchar("stripe_customer_id", { length: 100 }),
  stripeSubscriptionId: varchar("stripe_subscription_id", { length: 100 }).unique(),
  seats: int("seats").default(1).notNull(),
  currentPeriodEnd: timestamp("current_period_end"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  userIdIdx: index("idx_subscriptions_user_id").on(table.userId),
  teamIdIdx: index("idx_subscriptions_team_id").on(table.teamId),
}));

// ─── ENTITLEMENTS (the single "can user X do Y" source) ─────────────
export const entitlements = mysqlTable("entitlements", {
  id: int("id").autoincrement().primaryKey().notNull(),
  subjectType: mysqlEnum("subject_type", ["user", "team"]).notNull(),
  subjectId: int("subject_id").notNull(),
  capability: varchar("capability", { length: 150 }).notNull(),
  source: mysqlEnum("source", ["tier", "subscription", "voucher", "purchase", "manual"]).notNull(),
  sourceRef: varchar("source_ref", { length: 100 }),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  subjectCapabilityIdx: index("idx_entitlements_subject_capability").on(table.subjectId, table.capability),
}));

// ─── USAGE COUNTERS (per-subject metering, monthly periods) ─────────
export const usageCounters = mysqlTable("usage_counters", {
  id: int("id").autoincrement().primaryKey().notNull(),
  subjectId: int("subject_id").notNull(),
  metric: varchar("metric", { length: 100 }).notNull(),
  period: varchar("period", { length: 6 }).notNull(), // yyyymm
  count: int("count").default(0).notNull(),
}, (table) => ({
  subjectMetricPeriodUniq: uniqueIndex("uq_usage_counters_subject_metric_period").on(table.subjectId, table.metric, table.period),
}));

// ─── IDEMPOTENCY KEYS (webhooks, checkout, external events) ─────────
export const idempotencyKeys = mysqlTable("idempotency_keys", {
  key: varchar("key", { length: 100 }).primaryKey().notNull(),
  scope: varchar("scope", { length: 100 }).notNull(),
  responseHash: varchar("response_hash", { length: 64 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  createdAtIdx: index("idx_idempotency_keys_created_at").on(table.createdAt),
}));

// ─── OAUTH REFRESH TOKENS (opaque, SHA-256 hashed at rest) ──────────
export const oauthRefreshTokens = mysqlTable("oauth_refresh_tokens", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  clientId: varchar("client_id", { length: 100 }).notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  scopes: json("scopes").$type<string[]>(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("idx_oauth_refresh_tokens_user_id").on(table.userId),
}));

// ─── VOUCHER REDEMPTIONS (per-user voucher usage + expiry) ──────────
export const voucherRedemptions = mysqlTable("voucher_redemptions", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  voucherId: int("voucher_id")
    .references(() => vouchers.id, { onDelete: "cascade" })
    .notNull(),
  tier: varchar("tier", { length: 50 }).notNull(),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("idx_voucher_redemptions_user_id").on(table.userId),
  voucherIdIdx: index("idx_voucher_redemptions_voucher_id").on(table.voucherId),
}));

// ═══════════════════════════════════════════════════════════════════════
// COMPANION MCP SERVER (F0) — OAuth 2.1 clients/codes + MCP audit log
// ═══════════════════════════════════════════════════════════════════════

// ─── OAUTH CLIENTS (RFC 7591 dynamic client registration) ───────────
export const oauthClients = mysqlTable("oauth_clients", {
  id: int("id").autoincrement().primaryKey().notNull(),
  clientId: varchar("client_id", { length: 100 }).notNull().unique(),
  clientName: varchar("client_name", { length: 200 }),
  redirectUris: json("redirect_uris").$type<string[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── OAUTH AUTHORIZATION CODES (auth code + PKCE, SHA-256 hashed) ───
export const oauthAuthCodes = mysqlTable("oauth_auth_codes", {
  id: int("id").autoincrement().primaryKey().notNull(),
  codeHash: varchar("code_hash", { length: 128 }).notNull().unique(),
  clientId: varchar("client_id", { length: 100 }).notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  redirectUri: text("redirect_uri"),
  codeChallenge: varchar("code_challenge", { length: 128 }),
  codeChallengeMethod: varchar("code_challenge_method", { length: 10 }),
  scopes: json("scopes").$type<string[]>(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  clientIdIdx: index("idx_oauth_auth_codes_client_id").on(table.clientId),
}));

// ─── MCP AUDIT LOG (one row per tool call: latency + status) ────────
export const mcpAuditLog = mysqlTable("mcp_audit_log", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  clientId: varchar("client_id", { length: 100 }).notNull(),
  toolName: varchar("tool_name", { length: 100 }).notNull(),
  latencyMs: int("latency_ms").notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("idx_mcp_audit_log_user_id").on(table.userId),
  createdAtIdx: index("idx_mcp_audit_log_created_at").on(table.createdAt),
}));

// ═══════════════════════════════════════════════════════════════════════
// TEAMSYNC (Phase 2) — seat billing, memory locking, approval handoffs
// ═══════════════════════════════════════════════════════════════════════

// ─── TEAM SEATS (seat billing state per team) ───────────────────────
export const teamSeats = mysqlTable("team_seats", {
  id: int("id").autoincrement().primaryKey().notNull(),
  teamId: int("team_id")
    .references(() => teams.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  seats: int("seats").default(1).notNull(),
  stripeSubscriptionId: varchar("stripe_subscription_id", { length: 100 }),
  stripeSubscriptionItemId: varchar("stripe_subscription_item_id", { length: 100 }),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

// ─── MEMORY LOCKS (optimistic concurrency for shared project state) ──
export const memoryLocks = mysqlTable("memory_locks", {
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .primaryKey()
    .notNull(),
  version: int("version").default(1).notNull(),
  lastWriterId: int("last_writer_id").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

// ─── APPROVAL ASSIGNMENTS (cross-app run handoffs) ──────────────────
export const approvalAssignments = mysqlTable("approval_assignments", {
  id: int("id").autoincrement().primaryKey().notNull(),
  swarmRunId: int("swarm_run_id")
    .references(() => swarmRuns.id, { onDelete: "cascade" })
    .notNull(),
  assigneeUserId: int("assignee_user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  assignedBy: int("assigned_by")
    .references(() => users.id)
    .notNull(),
  status: mysqlEnum("status", ["pending", "completed", "cancelled"])
    .default("pending")
    .notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  assigneeIdx: index("idx_approval_assign_assignee").on(table.assigneeUserId, table.status),
  runIdx: index("idx_approval_assign_run").on(table.swarmRunId),
}));

// ═══════════════════════════════════════════════════════════════════════
// ENTERPRISE (Phase 3) — SSO connections, on-prem relay
// ═══════════════════════════════════════════════════════════════════════

// ─── SSO CONNECTIONS (OIDC + SAML, one per email domain) ────────────
export const ssoConnections = mysqlTable("sso_connections", {
  id: int("id").autoincrement().primaryKey().notNull(),
  type: mysqlEnum("type", ["oidc", "saml"]).notNull(),
  domain: varchar("domain", { length: 255 }).notNull().unique(),
  displayName: varchar("display_name", { length: 255 }).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  oidcIssuer: varchar("oidc_issuer", { length: 512 }),
  oidcClientId: varchar("oidc_client_id", { length: 255 }),
  oidcClientSecretEnc: text("oidc_client_secret_enc"),
  oidcScopes: varchar("oidc_scopes", { length: 255 }).default("openid email profile").notNull(),
  samlEntryPoint: varchar("saml_entry_point", { length: 512 }),
  samlIssuer: varchar("saml_issuer", { length: 512 }),
  samlCert: text("saml_cert"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

// ─── RELAY REGISTRATIONS (on-prem connectors, token stored hashed) ──
export const relayRegistrations = mysqlTable("relay_registrations", {
  id: int("id").autoincrement().primaryKey().notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  ownerUserId: int("owner_user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  status: mysqlEnum("status", ["active", "revoked"]).default("active").notNull(),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── RELAY REQUESTS (cloud-side queue for outbound-only relays) ─────
export const relayRequests = mysqlTable("relay_requests", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey().notNull(),
  relayId: int("relay_id")
    .references(() => relayRegistrations.id, { onDelete: "cascade" })
    .notNull(),
  kind: varchar("kind", { length: 50 }).notNull(),
  payloadJson: json("payload_json").notNull(),
  status: mysqlEnum("status", ["pending", "claimed", "completed", "failed"])
    .default("pending")
    .notNull(),
  resultJson: json("result_json"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  claimedAt: timestamp("claimed_at"),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  relayStatusIdx: index("idx_relay_req_status").on(table.relayId, table.status),
}));

// ─── ADMIN AUDIT LOG (persistent trail for privileged mutations) ────
export const adminAuditLog = mysqlTable("admin_audit_log", {
  id: int("id").autoincrement().primaryKey().notNull(),
  adminUserId: int("admin_user_id")
    .references(() => users.id, { onDelete: "set null" }),
  action: varchar("action", { length: 64 }).notNull(),
  targetType: varchar("target_type", { length: 64 }),
  targetId: varchar("target_id", { length: 255 }),
  detail: json("detail").$type<Record<string, unknown>>(),
  ip: varchar("ip", { length: 64 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  createdIdx: index("idx_admin_audit_log_created").on(table.createdAt),
  adminIdx: index("idx_admin_audit_log_admin").on(table.adminUserId),
}));

// ─── WAITLIST (Pioneer 100, marketing site) ─────────────────────────
export const waitlistEntries = mysqlTable("waitlist_entries", {
  id: int("id").autoincrement().primaryKey().notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  role: mysqlEnum("role", ["creator", "user", "both"]).notNull(),
  ref: varchar("ref", { length: 64 }),
  referralCode: varchar("referral_code", { length: 32 }).notNull(),
  invitedAt: timestamp("invited_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
export const pipelineVersions = mysqlTable("pipeline_versions", {
  id: int("id").autoincrement().primaryKey().notNull(),
  ownerId: int("owner_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  // Source references are NOT cascade-deleted: a purchased/evidentiary
  // version must survive source project or template deletion (spec §6.1).
  sourceProjectId: int("source_project_id"),
  sourceTemplateId: int("source_template_id"),
  versionNumber: int("version_number").notNull(),
  definitionSchemaVersion: int("definition_schema_version").default(1).notNull(),
  // Canonical JSON snapshot: all prompts, graph/loop config, decoding and
  // tool/runtime configuration required for execution. No credentials.
  definition: mediumtext("definition").notNull(),
  definitionHash: varchar("definition_hash", { length: 64 }).notNull(),
  designerMethod: mysqlEnum("designer_method", ["manual", "auto"]).default("manual").notNull(),
  designerProviderId: int("designer_provider_id"),
  designerModel: varchar("designer_model", { length: 120 }),
  designerPromptVersion: varchar("designer_prompt_version", { length: 60 }),
  parentVersionId: int("parent_version_id"),
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
  originCreatorId: int("origin_creator_id"),
  // The earliest known version this one derives from, when different from the
  // version itself. Together with `origin_creator_id` this is the receipt that
  // says where the work came from.
  originVersionId: int("origin_version_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
export const pipelineShares = mysqlTable("pipeline_shares", {
  id: int("id").autoincrement().primaryKey().notNull(),
  // The shared object. `cascade` because the grant is meaningless without the
  // pipeline it names, and the pipeline's steps are already cascade-deleted
  // with the project; runs and versions the grant produced are separate rows
  // and are never touched by this.
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  // Denormalized grantor, so "what have I shared out" is one indexed lookup
  // and a re-share can be proven to come from the actual owner.
  ownerId: int("owner_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  granteeId: int("grantee_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  accessMode: mysqlEnum("access_mode", ["run_only", "full"]).default("run_only").notNull(),
  canModify: boolean("can_modify").default(false).notNull(),
  // Revocation flips this instead of deleting: the row is the record that the
  // access was ever granted, and an in-flight run re-reads it at dispatch.
  state: mysqlEnum("state", ["active", "revoked"]).default("active").notNull(),
  note: varchar("note", { length: 500 }),
  grantedAt: timestamp("granted_at").defaultNow().notNull(),
  revokedAt: timestamp("revoked_at"),
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
export const designJobs = mysqlTable("design_jobs", {
  id: int("id").autoincrement().primaryKey().notNull(),
  actorId: int("actor_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  // (Revision + step-content snapshot fields are grouped below `state`.)
  designerProviderId: int("designer_provider_id")
    .references(() => llmProviders.id, { onDelete: "set null" }),
  designerModel: varchar("designer_model", { length: 120 }),
  designerPromptVersion: varchar("designer_prompt_version", { length: 60 }),
  objective: text("objective").notNull(),
  spendApprovalId: int("spend_approval_id"),
  state: mysqlEnum("state", ["queued", "running", "succeeded", "failed", "cancelled", "paused"])
    .default("queued").notNull(),
  // Cancel intent while running: the worker finalizes as cancelled instead of
  // succeeded and stops dispatching further work (spec §5.3).
  cancelRequestedAt: timestamp("cancel_requested_at"),
  candidateVersionId: int("candidate_version_id"),
  // Candidate graph JSON snapshot produced by generation. Held on the job
  // until apply so a changed project revision can retain it for the owner
  // instead of dropping work already paid for.
  candidateDefinition: mediumtext("candidate_definition"),
  candidateDefinitionHash: varchar("candidate_definition_hash", { length: 64 }),
  applyState: mysqlEnum("apply_state", ["not_applied", "applied", "revision_conflict"])
    .default("not_applied").notNull(),
  // Revision counter AND canonical step-content snapshot at start: v2 apply
  // checks both, because legacy step writers do not bump the counter.
  expectedRevision: int("expected_revision").notNull(),
  baseStepHash: varchar("base_step_hash", { length: 64 }),
  // Durable provider-call attempt summaries (spec §5.3): this is the P2a
  // bridge until the full callAttempts ledger is wired in P2b.
  providerCallAttempts: json("provider_call_attempts").$type<Array<{
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
  leaseToken: varchar("lease_token", { length: 64 }),
  leaseExpiresAt: timestamp("lease_expires_at"),
  attemptCount: int("attempt_count").default(0).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 120 }),
  errorCode: varchar("error_code", { length: 60 }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
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
export const jobOutbox = mysqlTable("job_outbox", {
  id: int("id").autoincrement().primaryKey().notNull(),
  eventKey: varchar("event_key", { length: 160 }).notNull().unique(),
  resourceType: varchar("resource_type", { length: 60 }).notNull(),
  resourceId: int("resource_id").notNull(),
  operation: varchar("operation", { length: 60 }).notNull(),
  payload: json("payload").$type<Record<string, unknown>>(), // IDs only — never keys/prompts
  deliveryState: mysqlEnum("delivery_state", ["pending", "delivered", "failed", "dead"])
    .default("pending").notNull(),
  attemptCount: int("attempt_count").default(0).notNull(),
  nextRetryAt: timestamp("next_retry_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deliveredAt: timestamp("delivered_at"),
}, (table) => ({
  pendingIdx: index("idx_job_outbox_pending").on(table.deliveryState, table.nextRetryAt),
}));

export type JobOutbox = typeof jobOutbox.$inferSelect;
export type InsertJobOutbox = typeof jobOutbox.$inferInsert;

// ─── PROJECT REVISION COUNTER (optimistic concurrency for design apply) ─
// Separate table so `projects` rows are untouched by v2 writers. Incremented
// transactionally whenever pipeline steps change.
export const projectRevisions = mysqlTable("project_revisions", {
  projectId: int("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .primaryKey().notNull(),
  revision: int("revision").default(0).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().onUpdateNow(),
});

export type ProjectRevision = typeof projectRevisions.$inferSelect;
export type InsertProjectRevision = typeof projectRevisions.$inferInsert;

// ─── SPEND APPROVALS (frozen call-plan consent, spec §6.1/§9) ────────
export const spendApprovals = mysqlTable("spend_approvals", {
  id: int("id").autoincrement().primaryKey().notNull(),
  actorId: int("actor_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  payerId: int("payer_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  purpose: mysqlEnum("purpose", [
    "private_design", "private_evaluation", "seller_evidence", "buyer_execution", "trial", "community_evaluation",
  ]).notNull(),
  planHash: varchar("plan_hash", { length: 64 }).notNull(),
  planSnapshot: mediumtext("plan_snapshot").notNull(), // exact frozen call plan
  bindings: json("bindings").$type<Array<{ providerId: number; model: string }>>().notNull(),
  limits: json("limits").$type<{
    maxCalls?: number;
    maxTokens?: number;
    maxRuntimeSeconds?: number;
  }>(),
  spendCeilingUsd: decimal("spend_ceiling_usd", { precision: 10, scale: 2 }), // optional user-approved ceiling
  status: mysqlEnum("status", ["active", "consumed", "expired", "revoked"])
    .default("active").notNull(),
  policyVersion: varchar("policy_version", { length: 40 }).notNull(),
  approvedAt: timestamp("approved_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({
  actorStatusIdx: index("idx_spend_approvals_actor_status").on(table.actorId, table.status),
}));

export type SpendApproval = typeof spendApprovals.$inferSelect;
export type InsertSpendApproval = typeof spendApprovals.$inferInsert;

// ─── BENCHMARKS (evaluation runs, spec §6.1) ─────────────────────────
// listingId is NULLABLE: private grade-only evaluation needs no listing (D1).
// plan/planHash are frozen at start; later edits create a new benchmark.
export const benchmarks = mysqlTable("benchmarks", {
  id: int("id").autoincrement().primaryKey().notNull(),
  ownerId: int("owner_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  listingId: int("listing_id").references(() => marketplaceListings.id, { onDelete: "set null" }),
  // NULL while the benchmark is a draft: the immutable snapshot is only
  // frozen at start (migration 026). Authoritative afterwards.
  pipelineVersionId: int("pipeline_version_id")
    .references(() => pipelineVersions.id, { onDelete: "restrict" }),
  executionMode: mysqlEnum("execution_mode", ["grade_only", "compare_models", "compare_frontier_solo"])
    .notNull(),
  schemaVersion: int("schema_version").default(1).notNull(),
  plan: mediumtext("plan"), // immutable frozen plan JSON after start
  planHash: varchar("plan_hash", { length: 64 }),
  rubricRef: varchar("rubric_ref", { length: 120 }),
  judgeConfigRef: varchar("judge_config_ref", { length: 120 }),
  spendApprovalId: int("spend_approval_id").references(() => spendApprovals.id, { onDelete: "restrict" }),
  state: mysqlEnum("state", ["draft", "queued", "running", "paused", "completed", "partial", "failed", "cancelled"])
    .default("draft").notNull(),
  aggregateAvailability: mysqlEnum("aggregate_availability", ["none", "complete", "incomplete"])
    .default("none").notNull(), // missing coverage → incomplete, never silently reweighted (§6.3)
  leaseToken: varchar("lease_token", { length: 64 }),
  leaseExpiresAt: timestamp("lease_expires_at"),
  cancelRequestedAt: timestamp("cancel_requested_at"),
  // Draft-stage source pointer (projects.id). Frozen pipelineVersionId is
  // authoritative after start; this only lets quote/validate re-snapshot.
  sourceProjectId: int("source_project_id"),
  idempotencyKey: varchar("idempotency_key", { length: 120 }),
  costCurrency: varchar("cost_currency", { length: 4 }).default("USD"),
  totalEstimatedCost: decimal("total_estimated_cost", { precision: 18, scale: 8 }),
  totalObservedCost: decimal("total_observed_cost", { precision: 18, scale: 8 }),
  costCompleteness: mysqlEnum("cost_completeness", ["complete", "partial", "unknown"]).default("unknown"),
  // Descriptive-only evaluation summary (spec §7.2): counts, spread,
  // agreement, failures, observed cost. NEVER a place for inferred
  // statistics or quality certification.
  summary: mediumtext("summary"),
  summaryComputedAt: timestamp("summary_computed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
}, (table) => ({
  ownerStateIdx: index("idx_benchmarks_owner_state").on(table.ownerId, table.state),
  versionIdx: index("idx_benchmarks_pipeline_version").on(table.pipelineVersionId),
  actorIdempotencyUniq: uniqueIndex("uq_benchmarks_owner_idempotency").on(table.ownerId, table.idempotencyKey),
}));

export type Benchmark = typeof benchmarks.$inferSelect;
export type InsertBenchmark = typeof benchmarks.$inferInsert;

// ─── BENCHMARK CASES (task inputs, spec §6.1) ────────────────────────
export const benchmarkCases = mysqlTable("benchmark_cases", {
  id: int("id").autoincrement().primaryKey().notNull(),
  benchmarkId: int("benchmark_id")
    .references(() => benchmarks.id, { onDelete: "cascade" })
    .notNull(),
  stableCaseId: varchar("stable_case_id", { length: 60 }).notNull(),
  caseOrder: int("case_order").notNull(),
  inputText: mediumtext("input_text"),
  inputArtifactRef: varchar("input_artifact_ref", { length: 255 }), // large inputs: private object storage
  origin: mysqlEnum("origin", ["user", "generated", "paraphrase"]).default("user").notNull(),
  baseCaseId: varchar("base_case_id", { length: 60 }), // paraphrase grouping
  expectedOutput: mediumtext("expected_output"), // reference when provided
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  provenanceNotes: text("provenance_notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  benchmarkCaseUniq: uniqueIndex("uq_benchmark_cases_benchmark_case").on(table.benchmarkId, table.stableCaseId),
}));

export type BenchmarkCase = typeof benchmarkCases.$inferSelect;
export type InsertBenchmarkCase = typeof benchmarkCases.$inferInsert;

// ─── BENCHMARK CANDIDATES (execution strategies under test, §6.1) ────
export const benchmarkCandidates = mysqlTable("benchmark_candidates", {
  id: int("id").autoincrement().primaryKey().notNull(),
  benchmarkId: int("benchmark_id")
    .references(() => benchmarks.id, { onDelete: "cascade" })
    .notNull(),
  stableCandidateId: varchar("stable_candidate_id", { length: 60 }).notNull(),
  // `imported_output` = grade an output the owner already has, without
  // regenerating it (spec §4.1/A01, migration 027).
  strategy: mysqlEnum("strategy", ["pipeline", "solo_baseline", "imported_output"]).notNull(),
  workflowVersionId: int("workflow_version_id").references(() => pipelineVersions.id, { onDelete: "restrict" }),
  // The owner's existing response being graded. SET NULL: the graded text and
  // hash are copied onto benchmark_runs, so the evidence stands on its own.
  importedResponseId: int("imported_response_id").references(() => agentResponsesTable.id, { onDelete: "set null" }),
  baselinePrompt: mediumtext("baseline_prompt"), // solo_baseline only
  baselinePromptVersion: varchar("baseline_prompt_version", { length: 60 }),
  requestedProviderId: int("requested_provider_id"), // payer-owned, resolved server-side
  requestedModel: varchar("requested_model", { length: 120 }),
  stepResolutionPolicy: json("step_resolution_policy").$type<{
    mode: "as_configured" | "override_all";
    overrideModel?: string;
    overrideProviderId?: number;
  }>(),
  decodingSnapshot: json("decoding_snapshot").$type<{
    temperature?: number;
    maxTokens?: number;
    topP?: number;
  }>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  benchmarkCandidateUniq: uniqueIndex("uq_benchmark_candidates_benchmark_candidate").on(table.benchmarkId, table.stableCandidateId),
}));

export type BenchmarkCandidate = typeof benchmarkCandidates.$inferSelect;
export type InsertBenchmarkCandidate = typeof benchmarkCandidates.$inferInsert;

// ─── BENCHMARK RUNS (one execution per case×candidate×replication) ───
export const benchmarkRuns = mysqlTable("benchmark_runs", {
  id: int("id").autoincrement().primaryKey().notNull(),
  benchmarkId: int("benchmark_id")
    .references(() => benchmarks.id, { onDelete: "cascade" })
    .notNull(),
  caseId: int("case_id")
    .references(() => benchmarkCases.id, { onDelete: "cascade" })
    .notNull(),
  candidateId: int("candidate_id")
    .references(() => benchmarkCandidates.id, { onDelete: "cascade" })
    .notNull(),
  replicationIndex: int("replication_index").default(1).notNull(),
  logicalExecutionId: varchar("logical_execution_id", { length: 60 }).notNull(),
  linkedSwarmRunId: int("linked_swarm_run_id").references(() => swarmRuns.id, { onDelete: "set null" }),
  // For grading existing outputs: user-reported origin is NOT attested
  // platform execution evidence (spec §4.1). `owned_run` means the text came
  // from a response row this platform recorded for the same owner, so its
  // model/timestamp are known — still not execution performed by THIS plan.
  importedProvenance: json("imported_provenance").$type<{
    kind: "user_reported" | "owned_run";
    reportedModel?: string;
    reportedAt?: string;
    sourceResponseId?: number;
    sourceSwarmRunId?: number;
  }>(),
  status: mysqlEnum("status", ["pending", "running", "completed", "failed", "cancelled", "uncertain"])
    .default("pending").notNull(),
  outputText: mediumtext("output_text"),
  outputHash: varchar("output_hash", { length: 64 }),
  executorMetadata: json("executor_metadata").$type<{
    stepModels?: Array<{ stepOrder: number; requestedModel: string; returnedModel?: string | null }>;
    providerRoute?: string;
    revisionExposed?: string | null; // null → "not exposed by provider"
  }>(),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  usageSummary: json("usage_summary").$type<{ promptTokens?: number; completionTokens?: number; complete?: boolean }>(),
  errorSummary: text("error_summary"), // sanitized
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
export const benchmarkJudgments = mysqlTable("benchmark_judgments", {
  id: int("id").autoincrement().primaryKey().notNull(),
  benchmarkId: int("benchmark_id")
    .references(() => benchmarks.id, { onDelete: "cascade" })
    .notNull(),
  runId: int("run_id").references(() => benchmarkRuns.id, { onDelete: "cascade" }),
  runAId: int("run_a_id"),
  runBId: int("run_b_id"),
  judgeSlot: int("judge_slot").notNull(), // discloses panel size (spec §7.1)
  rubricVersionRef: varchar("rubric_version_ref", { length: 120 }).notNull(),
  judgePromptVersion: varchar("judge_prompt_version", { length: 60 }).notNull(),
  judgeModel: varchar("judge_model", { length: 120 }).notNull(),
  judgeProviderRoute: varchar("judge_provider_route", { length: 120 }),
  judgeRevision: varchar("judge_revision", { length: 120 }), // nullable → not exposed
  orientation: mysqlEnum("orientation", ["none", "ab", "ba"]), // paired only, recorded/randomized
  kind: mysqlEnum("kind", ["rubric", "pairwise"]).default("rubric").notNull(),
  dimensionScores: json("dimension_scores").$type<Array<{
    dimension: string;
    rawScore: string;      // decimal string, range-validated at write
    lowerBound: string;
    upperBound: string;
    weight: string;        // finite, nonnegative; sums to 1 after normalization
  }>>(),
  rawAggregate: decimal("raw_aggregate", { precision: 8, scale: 4 }), // e.g. 0–10 scale
  normalizedAggregate: decimal("normalized_aggregate", { precision: 7, scale: 6 }), // [0,1]
  pairPreference: mysqlEnum("pair_preference", ["a", "b", "tie"]),
  rationale: mediumtext("rationale"),
  rawResponseRef: varchar("raw_response_ref", { length: 255 }),
  status: mysqlEnum("status", ["pending", "completed", "parse_failed", "validation_failed", "failed"])
    .default("pending").notNull(),
  validationNotes: json("validation_notes").$type<{ outOfRange?: string[]; missingDimensions?: string[] }>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
export const callAttempts = mysqlTable("call_attempts", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey().notNull(),
  operationKind: mysqlEnum("operation_kind", ["generation", "judgment", "design", "narrative", "preparation"]).notNull(),
  operationId: int("operation_id").notNull(), // row ID within kind (run/judgment/job)
  benchmarkId: int("benchmark_id").references(() => benchmarks.id, { onDelete: "cascade" }),
  purpose: mysqlEnum("purpose", [
    "private_design", "private_evaluation", "seller_evidence", "buyer_execution", "trial", "community_evaluation",
  ]).notNull(),
  actorId: int("actor_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  payerId: int("payer_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  providerRefId: int("provider_ref_id"), // private; never exposed cross-tenant
  requestedModel: varchar("requested_model", { length: 120 }).notNull(),
  returnedModel: varchar("returned_model", { length: 120 }),
  providerRequestId: varchar("provider_request_id", { length: 120 }),
  attemptIndex: int("attempt_index").notNull(),
  outcome: mysqlEnum("outcome", ["success", "failed", "uncertain"]).notNull(),
  promptTokens: int("prompt_tokens"),
  completionTokens: int("completion_tokens"),
  cachedTokens: int("cached_tokens"),
  priceVectorVersion: varchar("price_vector_version", { length: 40 }),
  // Where a priced row's rate came from. NULL = "this row is not priceable",
  // which is NOT the same as zero (spec §9).
  costBasis: varchar("cost_basis", { length: 16 }),
  costPricingAsOf: timestamp("cost_pricing_as_of"),
  estimatedCostUsd: decimal("estimated_cost_usd", { precision: 18, scale: 8 }),
  costCompleteness: mysqlEnum("cost_completeness", ["complete", "partial", "unknown"]).default("unknown").notNull(),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  latencyMs: int("latency_ms"),
  errorMessage: text("error_message"), // redacted
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
export const evidencePublications = mysqlTable("evidence_publications", {
  id: int("id").autoincrement().primaryKey().notNull(),
  authorId: int("author_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  benchmarkId: int("benchmark_id").references(() => benchmarks.id, { onDelete: "restrict" }),
  externalReportId: int("external_report_id"), // set for user-reported evidence
  listingId: int("listing_id").references(() => marketplaceListings.id, { onDelete: "restrict" }),
  listingWorkflowVersionId: int("listing_workflow_version_id"),
  publicationKind: mysqlEnum("publication_kind", ["seller", "community"]).notNull(),
  provenance: mysqlEnum("provenance", ["platform_recorded", "user_reported", "legacy_import"]).notNull(),
  publicManifest: mediumtext("public_manifest").notNull(),
  manifestHash: varchar("manifest_hash", { length: 64 }).notNull(),
  // ATTESTATION (v3): who issued this record, not merely that it is unedited.
  // Nullable on purpose — a pre-signature row and a row published while the
  // platform has no signing key configured are both real, published evidence, and
  // NULL says so out loud instead of pretending. The signature itself also lives
  // inside `publicManifest`; these columns exist so a query can ask "is there any
  // published evidence NOT signed by the platform key we trust?" without parsing
  // JSON, which is what a revocation or re-issue sweep needs.
  signature: text("signature"),
  signingKeyId: varchar("signing_key_id", { length: 64 }),
  signedAt: timestamp("signed_at"),
  schemaVersion: int("schema_version").default(1).notNull(),
  consentVersion: varchar("consent_version", { length: 40 }).notNull(),
  state: mysqlEnum("state", ["draft_preview", "published", "withdrawn"]).default("draft_preview").notNull(),
  supersedesPublicationId: int("supersedes_publication_id"),
  // Original test completion time is SEPARATE from publication time —
  // re-publishing must not reset "tested on" (§6.2).
  testedAt: timestamp("tested_at").notNull(),
  publishedAt: timestamp("published_at"),
  withdrawnAt: timestamp("withdrawn_at"),
  withdrawalReason: text("withdrawal_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  listingPublicIdx: index("idx_evidence_publications_listing_state").on(table.listingId, table.state),
  authorIdx: index("idx_evidence_publications_author").on(table.authorId),
  fkWorkflowVersion: foreignKey({ name: "fk_evidence_pub_workflow_version", columns: [table.listingWorkflowVersionId], foreignColumns: [pipelineVersions.id] }).onDelete("restrict"),
}));

export type EvidencePublication = typeof evidencePublications.$inferSelect;
export type InsertEvidencePublication = typeof evidencePublications.$inferInsert;

// ─── EXTERNAL EVIDENCE REPORTS (user-declared, never attested, §6.2) ──
export const externalEvidenceReports = mysqlTable("external_evidence_reports", {
  id: int("id").autoincrement().primaryKey().notNull(),
  authorId: int("author_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  listingId: int("listing_id").references(() => marketplaceListings.id, { onDelete: "restrict" }).notNull(),
  workflowVersionId: int("workflow_version_id"),
  declaredInputs: mediumtext("declared_inputs").notNull(),
  declaredOutputs: mediumtext("declared_outputs").notNull(),
  declaredModel: varchar("declared_model", { length: 200 }),
  declaredDate: varchar("declared_date", { length: 40 }), // user-reported, not trusted as timestamp
  declaredRubric: text("declared_rubric"),
  attachments: json("attachments").$type<Array<{ ref: string; name: string; mime: string; sizeBytes: number; safetyScan: string }>>(),
  notes: text("notes"),
  publicationState: mysqlEnum("publication_state", ["draft", "published", "withdrawn"]).default("draft").notNull(),
  consentVersion: varchar("consent_version", { length: 40 }),
  previewHash: varchar("preview_hash", { length: 64 }),
  publishedAt: timestamp("published_at"),
  withdrawnAt: timestamp("withdrawn_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  listingIdx: index("idx_external_evidence_reports_listing").on(table.listingId),
  fkWorkflowVersion: foreignKey({ name: "fk_external_reports_workflow_version", columns: [table.workflowVersionId], foreignColumns: [pipelineVersions.id] }).onDelete("set null"),
}));

export type ExternalEvidenceReport = typeof externalEvidenceReports.$inferSelect;
export type InsertExternalEvidenceReport = typeof externalEvidenceReports.$inferInsert;

// ─── EVIDENCE REPORTS (community contradiction flags, spec §4.4) ──────
// A score DIFFERENCE never auto-verifies, auto-refunds, or auto-delists.
export const evidenceReports = mysqlTable("evidence_reports", {
  id: int("id").autoincrement().primaryKey().notNull(),
  reporterId: int("reporter_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  targetPublicationId: int("target_publication_id"),
  targetListingId: int("target_listing_id").references(() => marketplaceListings.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  supportingRef: varchar("supporting_ref", { length: 255 }),
  assessmentStatus: mysqlEnum("assessment_status", ["open", "reviewing", "upheld", "dismissed"])
    .default("open").notNull(),
  sellerReply: text("seller_reply"),
  sellerRepliedAt: timestamp("seller_replied_at"),
  assessedBy: int("assessed_by").references(() => users.id, { onDelete: "set null" }),
  assessedAt: timestamp("assessed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  targetIdx: index("idx_evidence_reports_target").on(table.targetPublicationId, table.assessmentStatus),
  fkTargetPub: foreignKey({ name: "fk_evidence_reports_target_pub", columns: [table.targetPublicationId], foreignColumns: [evidencePublications.id] }).onDelete("restrict"),
}));

export type EvidenceReport = typeof evidenceReports.$inferSelect;
export type InsertEvidenceReport = typeof evidenceReports.$inferInsert;

// ─── EXECUTION GRANTS (execute ≠ read, spec §6.4) ─────────────────────
// pipeline:run:<listingId> entitlements stay as-is for compatibility, but
// only these grants authorize loading a protected version server-side.
export const executionGrants = mysqlTable("execution_grants", {
  id: int("id").autoincrement().primaryKey().notNull(),
  subjectType: mysqlEnum("subject_type", ["user", "team"]).notNull(),
  subjectId: int("subject_id").notNull(),
  listingId: int("listing_id").references(() => marketplaceListings.id, { onDelete: "restrict" }).notNull(),
  workflowVersionId: int("workflow_version_id").references(() => pipelineVersions.id, { onDelete: "restrict" }),
  source: mysqlEnum("source", ["purchase", "trial", "manual"]),
  sourceRef: varchar("source_ref", { length: 120 }),
  state: mysqlEnum("state", ["active", "revoked", "expired"]).default("active").notNull(),
  policyVersion: varchar("policy_version", { length: 40 }),
  grantedAt: timestamp("granted_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({
  subjectListingIdx: index("idx_execution_grants_subject_listing").on(table.subjectId, table.listingId, table.state),
}));

export type ExecutionGrant = typeof executionGrants.$inferSelect;
export type InsertExecutionGrant = typeof executionGrants.$inferInsert;

// ─── TRIAL GRANTS / RESERVATIONS (atomic quota, spec §6.4/§8.3) ───────
// Feature-flagged off until policy P4 resolves. No fabricated purchase rows.
export const trialGrants = mysqlTable("trial_grants", {
  id: int("id").autoincrement().primaryKey().notNull(),
  subjectId: int("subject_id").notNull(),
  listingId: int("listing_id").references(() => marketplaceListings.id, { onDelete: "restrict" }).notNull(),
  policyWindow: varchar("policy_window", { length: 40 }).notNull(), // e.g. "all-time" or "2026-09"
  policyVersion: varchar("policy_version", { length: 40 }).notNull(),
  allowedQuota: int("allowed_quota").notNull(),
  reservedCount: int("reserved_count").default(0).notNull(),
  consumedCount: int("consumed_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  grantUniq: uniqueIndex("uq_trial_grants_subject_listing_window_policy").on(
    table.subjectId, table.listingId, table.policyWindow, table.policyVersion,
  ),
}));

export type TrialGrant = typeof trialGrants.$inferSelect;
export type InsertTrialGrant = typeof trialGrants.$inferInsert;

export const trialReservations = mysqlTable("trial_reservations", {
  id: int("id").autoincrement().primaryKey().notNull(),
  trialGrantId: int("trial_grant_id")
    .references(() => trialGrants.id, { onDelete: "restrict" })
    .notNull(),
  operationKey: varchar("operation_key", { length: 160 }).notNull(), // idempotent execution ID
  state: mysqlEnum("state", ["reserved", "consumed", "released", "uncertain"]).default("reserved").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
}, (table) => ({
  operationKeyUniq: uniqueIndex("uq_trial_reservations_operation_key").on(table.operationKey),
  grantStateIdx: index("idx_trial_reservations_grant_state").on(table.trialGrantId, table.state),
}));

export type TrialReservation = typeof trialReservations.$inferSelect;
export type InsertTrialReservation = typeof trialReservations.$inferInsert;

// ─── SETTLEMENT ENTRIES (seller earnings ledger, spec §6.4/§11) ───────
// A recorded earning is NOT a bank payout. Minor-unit decimal(10,2); the
// commission basis/rate is snapshotted per sale so history is immutable.
export const settlementEntries = mysqlTable("settlement_entries", {
  id: int("id").autoincrement().primaryKey().notNull(),
  purchaseId: int("purchase_id").references(() => marketplacePurchases.id, { onDelete: "restrict" }),
  adjustmentSource: mysqlEnum("adjustment_source", ["purchase", "refund", "chargeback", "manual_adjustment"]).notNull(),
  sellerId: int("seller_id")
    .references(() => users.id, { onDelete: "restrict" })
    .notNull(),
  currency: varchar("currency", { length: 4 }).default("USD").notNull(),
  grossAmount: decimal("gross_amount", { precision: 10, scale: 2 }).notNull(),
  commissionBasis: decimal("commission_basis", { precision: 10, scale: 2 }).notNull(),
  commissionRate: decimal("commission_rate", { precision: 4, scale: 2 }).notNull(), // e.g. 0.30
  feesTaxRef: varchar("fees_tax_ref", { length: 120 }),
  netPayable: decimal("net_payable", { precision: 10, scale: 2 }).notNull(),
  state: mysqlEnum("state", ["held", "eligible", "processing", "paid", "failed", "unknown", "reversed", "adjusted"])
    .default("held").notNull(),
  holdPolicyVersion: varchar("hold_policy_version", { length: 40 }),
  holdUntil: timestamp("hold_until"),
  disputeState: mysqlEnum("dispute_state", ["none", "open", "resolved"]).default("none").notNull(),
  policySnapshot: json("policy_snapshot").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow(),
}, (table) => ({
  sellerStateIdx: index("idx_settlement_entries_seller_state").on(table.sellerId, table.state),
  holdIdx: index("idx_settlement_entries_hold").on(table.state, table.holdUntil),
}));

export type SettlementEntry = typeof settlementEntries.$inferSelect;
export type InsertSettlementEntry = typeof settlementEntries.$inferInsert;

// ─── PAYOUT ATTEMPTS (external-confirmed transfers, spec §6.4/§11.3) ──
// Only provider-confirmed success marks a payout paid. Timeouts record
// `unknown` and reconcile by reference — never a new-key resend.
export const payoutAttempts = mysqlTable("payout_attempts", {
  id: int("id").autoincrement().primaryKey().notNull(),
  settlementEntryId: int("settlement_entry_id")
    .references(() => settlementEntries.id, { onDelete: "restrict" })
    .notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull().unique(),
  provider: varchar("provider", { length: 60 }).notNull(), // e.g. "stripe_connect" once approved (P3)
  providerTransferRef: varchar("provider_transfer_ref", { length: 160 }),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 4 }).notNull(),
  state: mysqlEnum("state", ["pending", "processing", "succeeded", "failed", "unknown"]).default("pending").notNull(),
  providerConfirmedAt: timestamp("provider_confirmed_at"),
  failureReason: text("failure_reason"), // redacted
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow(),
}, (table) => ({
  settlementIdx: index("idx_payout_attempts_settlement").on(table.settlementEntryId, table.state),
  pendingIdx: index("idx_payout_attempts_unreconciled").on(table.state, table.createdAt),
}));

export type PayoutAttempt = typeof payoutAttempts.$inferSelect;
export type InsertPayoutAttempt = typeof payoutAttempts.$inferInsert;

// ─── MODEL CATALOG (versioned, admin-reviewed release events, §12.1) ──
// NOT inferred from user llmProviders.models caches or name substrings.
export const modelCatalog = mysqlTable("model_catalog", {
  id: int("id").autoincrement().primaryKey().notNull(),
  provider: varchar("provider", { length: 80 }).notNull(),
  modelId: varchar("model_id", { length: 120 }).notNull(),
  family: varchar("family", { length: 80 }),
  /** D12: the model's DEVELOPER (e.g. "deepseek", "meta", "zhipu"), NOT the
   *  hosting provider whose key served the call — one host serves many
   *  vendors' models. Admin-reviewed like every other catalog field. NULL =
   *  vendor unknown: an unknown vendor counts as disjoint from nothing, so it
   *  can never satisfy the evidence-panel gate (and never collides with
   *  another model either). Migration 031. */
  vendor: varchar("vendor", { length: 80 }),
  successorOfModelId: varchar("successor_of_model_id", { length: 120 }), // explicit lineage
  availabilitySource: mysqlEnum("availability_source", ["admin_reviewed", "feed_import"]).default("admin_reviewed").notNull(),
  sourceUrl: varchar("source_url", { length: 512 }),
  verifiedAt: timestamp("verified_at"),
  availableAt: timestamp("available_at"),
  deprecatedAt: timestamp("deprecated_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  providerModelUniq: uniqueIndex("uq_model_catalog_provider_model").on(table.provider, table.modelId),
}));

export type ModelCatalogEntry = typeof modelCatalog.$inferSelect;
export type InsertModelCatalogEntry = typeof modelCatalog.$inferInsert;

export const modelReleaseEvents = mysqlTable("model_release_events", {
  id: int("id").autoincrement().primaryKey().notNull(),
  modelCatalogId: int("model_catalog_id")
    .references(() => modelCatalog.id, { onDelete: "cascade" })
    .notNull(),
  eventKey: varchar("event_key", { length: 160 }).notNull().unique(), // dedupe source event
  recordedBy: int("recorded_by").references(() => users.id, { onDelete: "set null" }),
  relevanceRule: varchar("relevance_rule", { length: 60 }), // e.g. same_family
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ModelReleaseEvent = typeof modelReleaseEvents.$inferSelect;
export type InsertModelReleaseEvent = typeof modelReleaseEvents.$inferInsert;

// Deduplicated retest SUGGESTIONS — a suggestion never starts paid work (D5).
export const retestSuggestions = mysqlTable("retest_suggestions", {
  id: int("id").autoincrement().primaryKey().notNull(),
  sellerId: int("seller_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  listingId: int("listing_id").references(() => marketplaceListings.id, { onDelete: "cascade" }).notNull(),
  workflowVersionId: int("workflow_version_id").references(() => pipelineVersions.id, { onDelete: "cascade" }),
  releaseEventId: int("release_event_id")
    .references(() => modelReleaseEvents.id, { onDelete: "cascade" })
    .notNull(),
  channel: mysqlEnum("channel", ["in_app", "email"]).default("in_app").notNull(),
  state: mysqlEnum("state", ["pending", "dismissed", "snoozed", "retest_started"]).default("pending").notNull(),
  snoozedUntil: timestamp("snoozed_until"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
export const marketplaceListingV2 = mysqlTable("marketplace_listing_v2", {
  listingId: int("listing_id")
    .references(() => marketplaceListings.id, { onDelete: "cascade" })
    .primaryKey().notNull(),
  publicationMode: mysqlEnum("publication_mode", ["legacy", "v2"]).default("legacy").notNull(),
  currentWorkflowVersionId: int("current_workflow_version_id"),
  currentEvidencePublicationId: int("current_evidence_publication_id"),
  evidenceSummaryRevision: int("evidence_summary_revision").default(0).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow(),
}, (table) => ({
  fkWorkflowVersion: foreignKey({ name: "fk_listing_v2_workflow_version", columns: [table.currentWorkflowVersionId], foreignColumns: [pipelineVersions.id] }).onDelete("set null"),
  fkEvidencePublication: foreignKey({ name: "fk_listing_v2_evidence_publication", columns: [table.currentEvidencePublicationId], foreignColumns: [evidencePublications.id] }).onDelete("set null"),
}));

export type MarketplaceListingV2 = typeof marketplaceListingV2.$inferSelect;
export type InsertMarketplaceListingV2 = typeof marketplaceListingV2.$inferInsert;

// marketplacePurchases + quotes: immutable checkout quote per sale (spec
// §6.4/§11.2). Separate table keeps the purchase row untouched; linked by
// unique purchaseId once fulfillment occurs.
export const marketplaceCheckoutQuotes = mysqlTable("marketplace_checkout_quotes", {
  id: int("id").autoincrement().primaryKey().notNull(),
  buyerId: int("buyer_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  listingId: int("listing_id").notNull(),
  workflowVersionId: int("workflow_version_id"),
  currency: varchar("currency", { length: 4 }).default("USD").notNull(),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  commissionBasis: decimal("commission_basis", { precision: 10, scale: 2 }).notNull(),
  commissionRate: decimal("commission_rate", { precision: 4, scale: 2 }).notNull(),
  refundPolicyVersion: varchar("refund_policy_version", { length: 40 }),
  holdPolicyVersion: varchar("hold_policy_version", { length: 40 }),
  stripeSessionId: varchar("stripe_session_id", { length: 100 }).unique(),
  status: mysqlEnum("status", ["created", "confirmed", "paid", "fulfilled", "expired", "unfulfillable"])
    .default("created").notNull(),
  purchaseId: int("purchase_id"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
export const trustedProviderEndpoints = mysqlTable("trusted_provider_endpoints", {
  id: int("id").autoincrement().primaryKey().notNull(),
  provider: varchar("provider", { length: 80 }).notNull(),
  baseUrl: varchar("base_url", { length: 512 }).notNull(),
  adapterKind: varchar("adapter_kind", { length: 60 }).notNull(),
  endpointClass: mysqlEnum("endpoint_class", ["first_party", "approved_proxy"]).default("first_party").notNull(),
  loggingDisclosure: text("logging_disclosure").notNull(), // provider-side logging exposure, reviewed
  protectionClass: mysqlEnum("protection_class", ["standard", "reduced"]).default("standard").notNull(),
  approvedBy: int("approved_by").references(() => users.id, { onDelete: "set null" }),
  policyVersion: varchar("policy_version", { length: 40 }).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
export const promotions = mysqlTable("promotions", {
  id: int("id").autoincrement().primaryKey().notNull(),
  name: varchar("name", { length: 80 }).notNull(),
  days: int("days").notNull(),
  // 'new_signups' is granted automatically to accounts that sign up inside the
  // window and have never subscribed; 'code' is only given on redemption.
  audience: mysqlEnum("audience", ["new_signups", "code"]).notNull(),
  // Required for 'code', NULL for 'new_signups'. MySQL treats NULLs as distinct
  // in a UNIQUE index, so several automatic promotions coexist while codes stay
  // one-per-promotion.
  code: varchar("code", { length: 32 }),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),
  // NULL = unlimited. Counted from redemption rows rather than a mutable
  // counter column, so a redemption cannot be lost or double-counted.
  maxRedemptions: int("max_redemptions"),
  active: boolean("active").default(true).notNull(),
  note: varchar("note", { length: 200 }),
  createdBy: int("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  codeUq: uniqueIndex("uq_promotions_code").on(table.code),
  audienceActiveIdx: index("idx_promotions_audience_active").on(table.audience, table.active),
}));

// The grant as it was given. `days` is copied from the promotion so editing or
// deactivating one cannot rewrite what people already received, and
// (user_id, promotion_id) is unique so the same grant cannot be claimed twice.
export const promotionRedemptions = mysqlTable("promotion_redemptions", {
  id: int("id").autoincrement().primaryKey().notNull(),
  userId: int("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  promotionId: int("promotion_id").references(() => promotions.id, { onDelete: "cascade" }).notNull(),
  days: int("days").notNull(),
  source: mysqlEnum("source", ["signup", "code"]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
export const deviceCodes = mysqlTable("device_codes", {
  id: int("id").autoincrement().primaryKey().notNull(),
  deviceCode: varchar("device_code", { length: 64 }).notNull(),
  userCode: varchar("user_code", { length: 12 }).notNull(),
  userId: int("user_id").references(() => users.id, { onDelete: "cascade" }),
  status: mysqlEnum("status", ["pending", "approved", "denied"]).default("pending").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  deviceCodeUq: uniqueIndex("uq_device_codes_device_code").on(table.deviceCode),
  userCodeUq: uniqueIndex("uq_device_codes_user_code").on(table.userCode),
}));

export type DeviceCode = typeof deviceCodes.$inferSelect;
