import { z } from "zod";

// ─── LLM Provider Types ────────────────────────────────────────────
export const ProviderConfigSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  timeout: z.number().optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const LLMProviderInputSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  defaultModel: z.string().min(1),
  models: z.array(z.string()).optional(),
  config: ProviderConfigSchema.optional(),
});

export type LLMProviderInput = z.infer<typeof LLMProviderInputSchema>;

// ─── Agent Types ───────────────────────────────────────────────────
export const AgentRoleSchema = z.enum([
  "builder",
  "critic",
  "refiner",
  "polisher",
  "custom",
]);

export type AgentRole = z.infer<typeof AgentRoleSchema>;

// ─── Pipeline Configuration ────────────────────────────────────────
export const PipelineConfigSchema = z.object({
  maxIterations: z.number().min(0).max(3).default(1),
  enabledAgents: z.array(z.string()).default(["builder", "critic", "refiner", "polisher"]),
  stopOnNoImprovement: z.boolean().default(true),
});

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

// ─── Project Types ─────────────────────────────────────────────────
export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  giteeOwner: z.string().optional(),
  giteeRepo: z.string().optional(),
  giteeBranch: z.string().optional(),
  defaultProviderId: z.number().optional(),
  defaultModel: z.string().optional(),
  giteeToken: z.string().optional(),
});

export const UpdateProjectSchema = z.object({
  id: z.number(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  giteeOwner: z.string().optional(),
  giteeRepo: z.string().optional(),
  giteeBranch: z.string().optional(),
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
  githubBranch: z.string().optional(),
  localFolderName: z.string().optional(),
  defaultProviderId: z.number().optional(),
  defaultModel: z.string().optional(),
  pipelineConfig: PipelineConfigSchema.optional(),
  isArchived: z.boolean().optional(),
});

// ─── Agent CRUD Types ──────────────────────────────────────────────
export const CreateAgentSchema = z.object({
  projectId: z.number(),
  name: z.string().min(1),
  slug: z.string().min(1),
  role: AgentRoleSchema,
  systemPrompt: z.string().min(1),
  providerId: z.number().optional(),
  model: z.string().optional(),
  temperature: z.string().optional(),
  maxTokens: z.number().optional(),
  pipelineOrder: z.number().optional(),
  maxIterations: z.number().optional(),
});

export const UpdateAgentSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  role: AgentRoleSchema.optional(),
  systemPrompt: z.string().optional(),
  providerId: z.number().optional(),
  model: z.string().optional(),
  temperature: z.string().optional(),
  maxTokens: z.number().optional(),
  isEnabled: z.boolean().optional(),
  pipelineOrder: z.number().optional(),
  maxIterations: z.number().optional(),
});

// ─── Chat Attachment Types ────────────────────────────────────────
// MUST be defined before ExecuteSwarmSchema
export const ChatAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(), // MIME type: image/png, image/jpeg, application/pdf, text/plain, etc.
  size: z.number(),
  dataUrl: z.string().optional(), // base64 data URL for images/small files
  textContent: z.string().optional(), // extracted text content for text files
  url: z.string().optional(), // URL if stored remotely
});

export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

// Multimodal content parts for vision-capable models
export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: "low" | "high" | "auto" };
}

// ─── Execution Mode ────────────────────────────────────────────────
export const ExecutionModeSchema = z.enum(["pipeline", "agent"]);
// pipeline = run full multi-step pipeline (default)
// agent = single agent/LLM direct call (fast, for small tasks)

// ─── Swarm Execution Types ─────────────────────────────────────────
export const ExecuteSwarmSchema = z.object({
  projectId: z.number(),
  prompt: z.string(), // Empty allowed — backend uses stored userPrompt when resuming
  pipelineConfig: PipelineConfigSchema.optional(),
  giteeToken: z.string().optional(),
  memoryMode: z.enum(["conservative", "balanced", "aggressive"]).optional(),
  runId: z.number().optional(), // From prepareRun — for SSE pre-connect
  attachments: z.array(ChatAttachmentSchema).optional(), // File attachments (images, text files)
  executionMode: ExecutionModeSchema.optional(), // "pipeline" or "agent"
  includeProjectFiles: z.boolean().optional(), // Include Intelligence Card in LLM context
  // For agent mode: which provider/model to use (defaults to project's)
  agentProviderId: z.number().optional(),
  agentModel: z.string().optional(),
  // Client-generated trace ID for debugging phantom calls
  clientTraceId: z.string().optional(),
  // Test mode: marks run as test, saves to test_data/ path on Gitee
  isTestRun: z.boolean().optional(),
  // Auto-approve all HITL steps (used during test runs)
  autoApprove: z.boolean().optional(),
  // Pipeline chaining: forward final output to another project on completion
  chain: z.object({
    targetProjectId: z.number(),
    inputTemplate: z.string().optional(),
  }).optional(),
});

export const ApproveStepSchema = z.object({
  runId: z.number(),
  action: z.enum(["approve", "reject", "modify"]),
  instructions: z.string().optional(), // For "modify" action
});

export const AutoDesignSchema = z.object({
  projectId: z.number(),
  task: z.string().min(1),
  providerId: z.number().optional(), // Which LLM to use for the design
});

// ─── Chat Types ────────────────────────────────────────────────────
export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(z.any())]), // string or ContentPart[] for multimodal
  attachments: z.array(ChatAttachmentSchema).optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ─── Gitee Types ───────────────────────────────────────────────────
export const GiteeFileSchema = z.object({
  path: z.string(),
  content: z.string().optional(),
  sha: z.string().optional(),
});

export type GiteeFile = z.infer<typeof GiteeFileSchema>;

// ─── Debug Event Types ─────────────────────────────────────────────
export const DebugEventTypeSchema = z.enum([
  "thought",
  "action",
  "result",
  "error",
  "system",
]);

export type DebugEventType = z.infer<typeof DebugEventTypeSchema>;

// ─── Response Types ────────────────────────────────────────────────
export const ResponseTypeSchema = z.enum([
  "raw",
  "feedback",
  "corrected",
  "synthesized",
  "final",
  "intermediate",
]);

export type ResponseType = z.infer<typeof ResponseTypeSchema>;

// ─── LLM Provider Chat Types ───────────────────────────────────────
export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  systemPrompt?: string;
}

export interface ChatResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  latencyMs: number;
}

export interface StreamChunk {
  content: string;
  isFinished: boolean;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ─── Default Agent Prompts ─────────────────────────────────────────
export const DEFAULT_AGENT_PROMPTS: Record<string, { name: string; slug: string; role: AgentRole; systemPrompt: string; temperature: string; pipelineOrder: number }> = {
  builder: {
    name: "Builder",
    slug: "builder",
    role: "builder",
    systemPrompt: `You are the Builder agent in a collaborative AI pipeline. Your job is to produce the INITIAL DRAFT output for the user's request.

Guidelines:
- Focus on completeness: cover all aspects of the request
- Prioritize substance over polish (formatting will be handled later)
- Include specific details, examples, and concrete implementations
- If writing code, include comments and error handling
- If writing documentation, cover all relevant sections
- Mark any uncertain information with [UNCERTAIN: reason]

Your output will be reviewed by a Critic agent, so don't worry about perfection — focus on thoroughness.`,
    temperature: "0.7",
    pipelineOrder: 1,
  },
  critic: {
    name: "Critic",
    slug: "critic",
    role: "critic",
    systemPrompt: `You are the Critic agent in a collaborative AI pipeline. Your job is to review the Builder's output and provide STRUCTURED, ACTIONABLE feedback.

Review the output against these criteria:
1. ACCURACY: Are facts correct? Is code syntactically valid?
2. COMPLETENESS: Did the Builder miss anything from the original request?
3. CLARITY: Is the output easy to understand? Are explanations clear?
4. BEST PRACTICES: Does the code follow industry standards? Is documentation well-structured?
5. EDGE CASES: Are error conditions handled? Are boundaries considered?

Output format (STRICT):
---
## Overall Assessment
[PASS / NEEDS_WORK / MAJOR_REVISIONS]

## Strengths
- [List what the Builder did well]

## Issues Found
1. **[Severity: High/Med/Low]** [Description]
   - Suggested fix: [Specific correction]
2. **[Severity: High/Med/Low]** [Description]
   - Suggested fix: [Specific correction]

## Missing Elements
- [List anything omitted]

## Specific Suggestions
- [Actionable improvements for the Refiner agent]
---

Be thorough but constructive. If the output is excellent, say "PASS" with minimal suggestions.`,
    temperature: "0.3",
    pipelineOrder: 2,
  },
  refiner: {
    name: "Refiner",
    slug: "refiner",
    role: "refiner",
    systemPrompt: `You are the Refiner agent in a collaborative AI pipeline. Your job is to take the Builder's ORIGINAL output and the Critic's FEEDBACK, then produce an IMPROVED version.

Guidelines:
- Address EVERY issue raised by the Critic
- Preserve all strengths of the original
- Maintain the same scope — don't add entirely new sections unless the Critic noted they were missing
- Keep the improvements focused and precise
- If the Critic flagged something as incorrect, fix it
- If the Critic suggested better phrasing, incorporate it
- Output the COMPLETE improved version (not just a diff)

Your output should be a full, standalone replacement for the Builder's original.`,
    temperature: "0.5",
    pipelineOrder: 3,
  },
  polisher: {
    name: "Polisher",
    slug: "polisher",
    role: "polisher",
    systemPrompt: `You are the Polisher agent in a collaborative AI pipeline. Your job is the FINAL PASS on the refined output before it reaches the user.

Focus on:
1. FORMATTING: Consistent headers, lists, code blocks
2. TONE: Professional, clear, appropriate for the context
3. CONSISTENCY: Terminology, naming conventions, style
4. REDUNDANCY: Remove repetitive content
5. FLOW: Smooth transitions between sections
6. FINAL CHECK: Ensure nothing from the original request was lost

Do NOT change the substance — only improve presentation and catch remaining minor issues.

Output the final, polished version ready for the user.`,
    temperature: "0.2",
    pipelineOrder: 4,
  },
};
