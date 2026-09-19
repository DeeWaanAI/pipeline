import sys

def patch_file(path, replacements):
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    for old, new in replacements:
        if old not in content:
            print(f"WARNING: pattern not found in {path}")
            continue
        content = content.replace(old, new, 1)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Patched {path}")

# 1. db/schema.ts
patch_file('db/schema.ts', [
    # Add declaredRpm to llm_providers.config
    (
        '    timeout?: number;\n  }>()',
        '    timeout?: number;\n    declaredRpm?: number; // user-declared provider tier RPM (Research Mode)\n  }>()'
    ),
    # Add batchId to swarm_runs and index
    (
        '  statusIdx: index("idx_swarm_runs_status").on(table.status),\n}))',
        '  statusIdx: index("idx_swarm_runs_status").on(table.status),\n  batchIdIdx: index("idx_swarm_runs_batch_id").on(table.batchId),\n}))'
    ),
    # Add batchId column inside swarmRuns (after completedAt)
    (
        '  completedAt: timestamp("completed_at"),\n}, (table) => ({',
        '  completedAt: timestamp("completed_at"),\n  // Batch membership (Research Mode): NULL = standalone run\n  batchId: int("batch_id"),\n}, (table) => ({'
    ),
    # Add swarm_batches table after swarmRuns
    (
        '}));\n\n// ─── AGENT RUNS ────────────────────────────────────────────────────',
        '}\n\n// ─── SWARM BATCHES (Research Mode: batch run groups) ───────────────\nexport const swarmBatches = mysqlTable("swarm_batches", {\n  id: int("id").autoincrement().primaryKey().notNull(),\n  userId: int("user_id")\n    .references(() => users.id, { onDelete: "cascade" })\n    .notNull(),\n  projectId: int("project_id")\n    .references(() => projects.id, { onDelete: "cascade" })\n    .notNull(),\n  name: varchar("name", { length: 200 }),\n  status: varchar("status", { length: 30 }).notNull().default("running"),\n  totalRuns: int("total_runs").notNull(),\n  completedRuns: int("completed_runs").notNull().default(0),\n  failedRuns: int("failed_runs").notNull().default(0),\n  totalTokensUsed: int("total_tokens_used").notNull().default(0),\n  createdAt: timestamp("created_at").defaultNow().notNull(),\n  completedAt: timestamp("completed_at"),\n}, (table) => ({\n  userIdIdx: index("idx_swarm_batches_user_id").on(table.userId),\n  projectIdIdx: index("idx_swarm_batches_project_id").on(table.projectId),\n  statusIdx: index("idx_swarm_batches_status").on(table.status),\n}));\n\n// ─── AGENT RUNS ────────────────────────────────────────────────────'
    ),
])

# 2. api/lib/env.ts
patch_file('api/lib/env.ts', [
    (
        '  publicAppUrl: process.env.PUBLIC_APP_URL ?? "https://app.deewaanai.com",\n  // ─── Waitlist CORS',
        '  publicAppUrl: process.env.PUBLIC_APP_URL ?? "https://app.deewaanai.com",\n  // ─── Research Mode (batch runs + pipeline chaining) ───────────────\n  swarmWorkerConcurrency: parseInt(process.env.SWARM_WORKER_CONCURRENCY ?? "2", 10) || 2,\n  providerThrottle: process.env.PROVIDER_THROTTLE ?? "",\n  // ─── Waitlist CORS'
    ),
])

# 3. api/lib/rateLimiter.ts
patch_file('api/lib/rateLimiter.ts', [
    (
        '  execute: { maxTokens: 10, refillRate: 10 / 60, windowMs: 60_000 } as RateLimitConfig,  // 10/min\n  read:',
        '  execute: { maxTokens: 10, refillRate: 10 / 60, windowMs: 60_000 } as RateLimitConfig,  // 10/min\n  batch: { maxTokens: 2, refillRate: 2 / 60, windowMs: 60_000 } as RateLimitConfig,      // 2 batch submissions/min\n  read:'
    ),
])

# 4. api/workers/swarmWorker.ts
patch_file('api/workers/swarmWorker.ts', [
    (
        '  return swarmQueue.enqueue(SWARM_JOB_EXECUTE, payload);',
        '  return swarmQueue.enqueue(SWARM_JOB_EXECUTE, payload, { idempotencyKey: `run-${swarmRunId}` });'
    ),
])

# 5. api/infra/queue.ts
patch_file('api/infra/queue.ts', [
    (
        '      { connection: connection as unknown as ConnectionOptions, concurrency: 2 },',
        '      { connection: connection as unknown as ConnectionOptions, concurrency: env.swarmWorkerConcurrency },'
    ),
])

# 6. api/plugins/featureFlags.ts
patch_file('api/plugins/featureFlags.ts', [
    (
        '    { key: "marketplace_ai_triage", name: "Marketplace AI Triage", description: "Platform-model AI triage for marketplace submissions (non-gating; off = straight to certifying)", enabled: true, rolloutPercent: 100 },\n  ];',
        '    { key: "marketplace_ai_triage", name: "Marketplace AI Triage", description: "Platform-model AI triage for marketplace submissions (non-gating; off = straight to certifying)", enabled: true, rolloutPercent: 100 },\n    // Research Mode (Phase 0): batch runs + pipeline chaining. Default OFF.\n    { key: "batch_mode", name: "Research Mode — Batch Runs", description: "Run up to 100 pipeline inputs in parallel", enabled: false, rolloutPercent: 0 },\n    { key: "pipeline_chaining", name: "Research Mode — Pipeline Chaining", description: "Chain pipeline outputs into evaluation pipelines", enabled: false, rolloutPercent: 0 },\n  ];'
    ),
])

# 7. api/services/swarmService.ts - extend SwarmRunParams
patch_file('api/services/swarmService.ts', [
    (
        '  autoApprove?: boolean;\n  clientTraceId?: string;\n}',
        '  autoApprove?: boolean;\n  clientTraceId?: string;\n  // Research Mode (batch + chaining)\n  batchId?: number;\n  chain?: {\n    targetProjectId: number;\n    inputTemplate?: string;\n    depth: number;\n    lineage: number[];\n  };\n}'
    ),
])

print("All Phase 0 plumbing patches applied.")
