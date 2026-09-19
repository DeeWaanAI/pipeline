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
    tokensUsed: { prompt: number; completion: number; total: number };
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
  createdAt: timestamp("created_at").defaultNow(),
});

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
