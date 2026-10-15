import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "../middleware";
import { eq, and, desc, sql, count, inArray } from "drizzle-orm";
import { getDb, getReadDb } from "../queries/connection";
import {
  marketplaceListings,
  marketplaceListingV2,
  testPrompts,
  testPromptIntermediate,
  marketplacePurchases,
  encryptedPrompts,
  pipelineTemplates,
} from "../../db/schema";
import { encryptPipelineSteps } from "../lib/marketplaceCrypto";
import { createProviderAdapter } from "../lib/providers";
import { getMasterKey, decrypt } from "../services/cryptoService";
import { llmProviders } from "../../db/schema";
import { createOrUpdateFile } from "../services/giteeService";
import { extractJson } from "../lib/extractJson";
import { withTimeout } from "../lib/withTimeout";
import { isFeatureEnabled } from "../plugins/featureFlags";
import { assertLegacyFlowAllowed, setLegacyListingStatus, V2PublicationLockedError } from "../services/marketplacePublication";
import { assertOriginalCreatorMayList } from "../services/workflowLineage";
import { deliverPurchasedCopy, deliverPurchasedCopyInputSchema, forkPublicListing, forkPublicListingInputSchema } from "../services/pipelineDelivery";
import {
  getPublishedManifestByHash, getPublicEvidenceForListing, listPublicEvidenceForListing, publishVersion,
  getEvidenceForViewer, getPurchasedEvidenceForListing,
} from "../services/evidenceService";
import { logger } from "../lib/logger";
import { can as entitlementCan } from "../services/entitlements";
import { purchaseCapability } from "../services/entitlementSync";
import {
  createMarketplaceCheckoutSession,
  isBillingConfigured,
  BillingNotConfiguredError,
} from "../services/billingService";
import { scanListingSecurity } from "../services/promptSecurityScan";

// Public, non-personalized browse payloads — safe for shared/CDN caches.
// Short browser TTL (60s), longer edge TTL (300s) since listings change rarely.
const MARKETPLACE_CACHE_CONTROL = "public, max-age=60, s-maxage=300";

// Derive the public app origin from the incoming request so Stripe can
// redirect back to the frontend the user is actually on (dev vs prod).
function requestOrigin(req: Request): string {
  const origin = req.headers.get("origin");
  if (origin) return origin.replace(/\/+$/, "");
  try {
    return new URL(req.url).origin;
  } catch {
    const proto = req.headers.get("x-forwarded-proto") ?? "http";
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost";
    return `${proto}://${host}`;
  }
}

// ─── Test Prompt Generator (description-driven, 10 prompts) ──────
// Generates test prompts tailored to the pipeline's actual purpose using LLM.
// Creator describes what their pipeline does → LLM generates 10 appropriate test inputs.
async function generateTestPrompts(
  listingId: number,
  pipelineDescription: string,
  pipelineTitle: string,
  adapter: ReturnType<typeof createProviderAdapter>,
): Promise<Array<typeof testPrompts.$inferInsert>> {
  // Build a prompt for the LLM to generate 10 test inputs
  const systemPrompt = `You are a test data generator for AI agent pipelines. Your job is to create 10 diverse test prompts that accurately test a specific pipeline's capabilities.

Respond ONLY with a JSON array of 10 objects. Each object must have:
- "category": one of "simple", "medium", "complex", "edge" (distributed: 3 simple, 4 medium, 2 complex, 1 edge)
- "input": the actual test input text

Do NOT wrap in markdown code blocks. Output raw JSON only.`;

  const userPrompt = `Pipeline: "${pipelineTitle}"
Description: "${pipelineDescription || "No description provided"}"

Generate 10 test prompts that would accurately test this pipeline. Each prompt should be a realistic input that this pipeline is designed to handle. Make them varied and challenging.

Example: If the pipeline translates English to Arabic, generate inputs like:
- "Hello, how are you today?" (simple)
- "The quarterly report shows a 15% increase in revenue across all sectors." (medium)
- "Please review the attached contract and provide your feedback by EOD." (medium)

Output format: raw JSON array only.`;

  let promptTexts: Array<{ category: string; input: string }> = [];

  try {
    const result = await adapter.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { model: undefined, temperature: 0.7, maxTokens: 4000 },
    );

    // Robust JSON extraction (handles markdown, extra text)
    const extracted = extractJson<unknown[]>(result.content);
    if (Array.isArray(extracted)) {
      promptTexts = extracted as { category: string; input: string }[];
    } else {
      throw new Error("No JSON array found in response");
    }

    // Validate and cap at 10
    promptTexts = promptTexts.slice(0, 10).filter((p) => p.input);
  } catch (err) {
    logger.warn("TestGen LLM prompt generation failed, using fallback", { error: (err as Error).message });
    // Fallback: 10 generic prompts based on title
    promptTexts = Array.from({ length: 10 }, (_, i) => ({
      category: i < 3 ? "simple" : i < 7 ? "medium" : i < 9 ? "complex" : "edge",
      input: `Test input ${i + 1} for: ${pipelineTitle}`,
    }));
  }

  return promptTexts.map((p, index) => ({
    listingId,
    promptIndex: index,
    category: p.category as "simple" | "medium" | "complex" | "edge",
    inputText: p.input,
    actualOutput: "[Generating...]",
  }));
}

// ─── Decrypt API key (same as swarm.ts) ──────────────────────────
function decryptApiKey(encryptedRef: string): string {
  return decrypt(encryptedRef, getMasterKey());
}

// ─── Credit-exhausted error (special handling: pause, don't retry) ─
class CreditExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditExhaustedError";
  }
}

// Common error patterns that indicate API credit/quota issues
const CREDIT_ERROR_PATTERNS = [
  /insufficient_quota/i,
  /quota_exceeded/i,
  /billing.*has.*been.*disabled/i,
  /payment.*required/i,
  /402/i,
  /429.*rate.*limit/i,
  /credit/i,
  /balance/i,
  /account.*deactivated/i,
  /exceeded.*current.*quota/i,
  /limit.*exceeded/i,
  /too.*many.*requests/i,
];

function isCreditError(errorMessage: string): boolean {
  return CREDIT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

// Hard deadline per LLM attempt during test generation. Generous enough for
// slow user-configured models, tight enough that a stalled stream is retried
// instead of hanging the whole submission forever.
const TEST_GEN_STEP_TIMEOUT_MS = 180_000;

// ─── Retry wrapper for LLM API calls ──────────────────────────────
// Retries up to maxRetries with exponential backoff.
// Credit errors: throw immediately (no retry — user must add credit).
// Other errors: retry with delay 1s, 2s, 4s...
async function callWithRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; label?: string } = {},
): Promise<T> {
  const { maxRetries = 3, label = "API call" } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      const msg = lastError.message;

      // Credit error → never retry, inform user immediately
      if (isCreditError(msg)) {
        logger.error("Credit/quota error (no retry)", { label, msg });
        throw new CreditExhaustedError(
          `API credit exhausted: ${msg}. Please add credit to your provider account, then retry.`,
        );
      }

      // Last attempt failed → throw
      if (attempt === maxRetries) break;

      // Exponential backoff: 1s, 2s, 4s
      const delayMs = 1000 * Math.pow(2, attempt);
      logger.warn("Retry attempt failed, backing off", { label, attempt: attempt + 1, maxAttempts: maxRetries + 1, msg, delayMs });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastError ?? new Error(`${label} failed after ${maxRetries + 1} attempts`);
}

// ─── Run a single test prompt through the pipeline ────────────────
// Executes each agent step sequentially, passing output to next step.
// Stores ALL intermediate responses in testPromptIntermediate table.
// Returns the final step's output text.
async function runTestPipeline(
  listingId: number,
  creatorId: number,
  templateId: number,
  inputText: string,
  testPromptId: number, // DB id for storing intermediates
): Promise<string> {
  // Get pipeline template steps
  const [template] = await getDb()
    .select()
    .from(pipelineTemplates)
    .where(eq(pipelineTemplates.id, templateId));

  if (!template) throw new Error("Pipeline template not found");

  const steps = template.steps;
  if (!steps || steps.length === 0) throw new Error("Pipeline has no steps");

  // Get creator's first available provider
  const providers = await getDb()
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.userId, creatorId))
    .limit(1);

  if (providers.length === 0) throw new Error("Creator has no LLM provider configured");
  const provider = providers[0];
  const apiKey = decryptApiKey(provider.apiKeyRef);
  const adapter = createProviderAdapter(provider.slug, apiKey, provider.baseUrl, provider.defaultModel);

  // Run through each step sequentially
  let currentContext = inputText;
  let finalOutput = "";

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Skip non-agent steps (IF, WHILE, approval) in test generation
    if (step.stepType && step.stepType !== "agent") continue;

    const model = step.model ?? provider.defaultModel;
    const temperature = step.temperature ?? "0.7";
    const maxTokens = step.maxTokens ?? 4096;

    // Get the system prompt (decrypt if from marketplace listing)
    let systemPrompt = step.systemPrompt;
    if (!systemPrompt) {
      const [encPrompt] = await getDb()
        .select()
        .from(encryptedPrompts)
        .where(and(
          eq(encryptedPrompts.listingId, listingId),
          eq(encryptedPrompts.agentIndex, i),
        ))
        .limit(1);

      if (encPrompt) {
        const { decryptPrompt } = await import("../lib/marketplaceCrypto");
        systemPrompt = decryptPrompt(encPrompt.encryptedPrompt, listingId);
      } else {
        systemPrompt = `You are a ${step.role || step.name}. Process the input and produce a high-quality output.`;
      }
    }

    // Build messages
    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: currentContext },
    ];

    const stepInput = currentContext; // save before we overwrite
    const startTime = Date.now();

    try {
      // Retry API call up to 3 times (credit errors fail immediately).
      // Hard per-attempt timeout: a stalled provider stream otherwise hangs
      // forever and orphans the listing in `generating` (beta re-run 2026-07-28:
      // one prompt blocked the whole listing for ~25 min).
      const result = await callWithRetry(
        () => withTimeout(
          adapter.chat(messages, {
            model,
            temperature: parseFloat(temperature),
            maxTokens,
          }),
          TEST_GEN_STEP_TIMEOUT_MS,
          `TestGen[${testPromptId}] step ${i}`,
        ),
        { maxRetries: 3, label: `TestGen[${testPromptId}] step ${i}` },
      );

      const latencyMs = Date.now() - startTime;
      currentContext = result.content;
      finalOutput = result.content;

      // Best-effort: store intermediate response (don't fail pipeline if DB insert fails)
      try {
        await getDb().insert(testPromptIntermediate).values({
          testPromptId,
          stepIndex: i,
          stepName: step.name || `Step ${i}`,
          stepRole: step.role || null,
          inputText: stepInput,
          outputText: result.content,
          tokensUsed: result.usage?.totalTokens ?? null,
          latencyMs,
        });
      } catch (dbErr) {
        logger.warn("TestGen intermediate storage failed", { testPromptId, step: i, error: (dbErr as Error).message });
      }
    } catch (err) {
      const errorMsg = (err as Error).message;
      // Credit exhausted → special marker so caller can inform user
      if (err instanceof CreditExhaustedError) {
        finalOutput = `[CREDIT_EXHAUSTED: ${errorMsg}]`;
      } else {
        finalOutput = `[Pipeline Error at step "${step.name}" (after 3 retries): ${errorMsg}]`;
      }
      break;
    }
  }

  return finalOutput;
}

// ─── Save test data to Gitee under test_data/{pipeline_name}/ ────
async function saveTestDataToGitee(
  giteeToken: string,
  pipelineName: string,
  listingId: number,
  listingTitle: string,
  prompts: Array<{ id: number; promptIndex: number; category: string | null; inputText: string }>,
  results: Array<{ id: number; output: string; error: string | null }>,
) {
  // List user's repos to find the swarm-studio one
  const reposRes = await fetch(
    `https://gitee.com/api/v5/user/repos?access_token=${giteeToken}&type=owner&page=1&per_page=20`,
  );
  if (!reposRes.ok) throw new Error("Failed to list Gitee repos");
  const repos = (await reposRes.json()) as Array<{ owner: { login: string }; name: string; path?: string }>;

  const targetRepo = repos.find((r) => r.name === "swarm-studio" || (r.path && r.path === "swarm-studio"));
  if (!targetRepo) throw new Error("No 'swarm-studio' repo found. Create one on Gitee first.");

  const owner = targetRepo.owner.login;
  const repo = targetRepo.name;
  const basePath = `test_data/${pipelineName}`;

  // Save each prompt + output as files
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const r = results[i];
    const idx = String(i + 1).padStart(3, "0");

    // Input file
    await createOrUpdateFile(
      giteeToken, owner, repo,
      `${basePath}/prompt_${idx}_input.txt`,
      `[Category: ${p.category ?? "unknown"}]\n\n${p.inputText}`,
      `Test data for "${listingTitle}" — Prompt ${idx} Input`,
    );

    // Output file
    await createOrUpdateFile(
      giteeToken, owner, repo,
      `${basePath}/prompt_${idx}_output.txt`,
      r.error ? `[ERROR] ${r.error}` : r.output,
      `Test data for "${listingTitle}" — Prompt ${idx} Pipeline Output`,
    );
  }

  // Summary report JSON
  const report = {
    listingId,
    pipelineName,
    generatedAt: new Date().toISOString(),
    totalPrompts: prompts.length,
    successCount: results.filter((r) => !r.error).length,
    failCount: results.filter((r) => r.error).length,
    prompts: prompts.map((p, i) => ({
      index: p.promptIndex,
      category: p.category,
      input: p.inputText.substring(0, 200),
      outputPreview: results[i].output.substring(0, 200),
      status: results[i].error ? "failed" : "success",
    })),
  };

  await createOrUpdateFile(
    giteeToken, owner, repo,
    `${basePath}/report.json`,
    JSON.stringify(report, null, 2),
    `Test data report for "${listingTitle}"`,
  );

  logger.info("Marketplace test data saved to Gitee", { basePath });
}

// ─── Router ────────────────────────────────────────────────────────
export const marketplaceRouter = createRouter({
  // ── Public: Browse listings ────────────────────────────────────
  list: publicQuery
    .input(
      z.object({
        category: z.string().optional(),
        sortBy: z.enum(["newest", "price_asc", "price_desc", "grade", "popular"]).default("newest"),
        status: z.enum(["published", "all"]).default("published"),
      }).optional(),
    )
    .query(async ({ input, ctx }) => {
      const filters = [];
      if (input?.category && input.category !== "all") {
        filters.push(eq(marketplaceListings.category, input.category as "translation" | "writing" | "code" | "analysis" | "creative" | "other"));
      }
      if (input?.status === "published" || !input?.status) {
        // Public browse shows buyable (`published`) AND in-certification
        // (`certifying`) listings (spec 0.4). `status` is exposed in the
        // payload so the UI can badge certifying listings and gate purchase.
        filters.push(inArray(marketplaceListings.status, ["published", "certifying"]));
      }

      const orderBy = (() => {
        switch (input?.sortBy) {
          case "price_asc": return marketplaceListings.price;
          case "price_desc": return desc(marketplaceListings.price);
          case "grade": return desc(marketplaceListings.grade);
          case "popular": return desc(marketplaceListings.salesCount);
          default: return desc(marketplaceListings.createdAt);
        }
      })();

      const whereClause = filters.length > 0 ? and(...filters) : undefined;

      ctx.resHeaders.set("Cache-Control", MARKETPLACE_CACHE_CONTROL);
      const listings = await getReadDb()
        .select({
          id: marketplaceListings.id,
          title: marketplaceListings.title,
          description: marketplaceListings.description,
          category: marketplaceListings.category,
          price: marketplaceListings.price,
          isSubscription: marketplaceListings.isSubscription,
          subscriptionPrice: marketplaceListings.subscriptionPrice,
          status: marketplaceListings.status,
          grade: marketplaceListings.grade,
          reviewCount: marketplaceListings.reviewCount,
          kappaScore: marketplaceListings.kappaScore,
          salesCount: marketplaceListings.salesCount,
          createdAt: marketplaceListings.createdAt,
          creatorName: sql<string>`(SELECT name FROM users WHERE users.id = ${marketplaceListings.creatorId})`,
        })
        .from(marketplaceListings)
        .where(whereClause)
        .orderBy(orderBy)
        .limit(100);

      return listings;
    }),

  // ── Public: Get listing detail ─────────────────────────────────
  getById: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const [listing] = await getReadDb()
        .select({
          id: marketplaceListings.id,
          creatorId: marketplaceListings.creatorId,
          title: marketplaceListings.title,
          description: marketplaceListings.description,
          category: marketplaceListings.category,
          price: marketplaceListings.price,
          isSubscription: marketplaceListings.isSubscription,
          subscriptionPrice: marketplaceListings.subscriptionPrice,
          status: marketplaceListings.status,
          grade: marketplaceListings.grade,
          reviewCount: marketplaceListings.reviewCount,
          kappaScore: marketplaceListings.kappaScore,
          aiCorrelation: marketplaceListings.aiCorrelation,
          salesCount: marketplaceListings.salesCount,
          createdAt: marketplaceListings.createdAt,
          creatorName: sql<string>`(SELECT name FROM users WHERE users.id = ${marketplaceListings.creatorId})`,
        })
        .from(marketplaceListings)
        .where(eq(marketplaceListings.id, input.id));

      if (!listing) throw new Error("Listing not found");

      // Get 10 random sample test prompts for public display
      const samples = await getReadDb()
        .select({
          promptIndex: testPrompts.promptIndex,
          category: testPrompts.category,
          inputText: testPrompts.inputText,
        })
        .from(testPrompts)
        .where(eq(testPrompts.listingId, input.id))
        .orderBy(sql`RAND()`)
        .limit(10);

      ctx.resHeaders.set("Cache-Control", MARKETPLACE_CACHE_CONTROL);
      return { ...listing, samplePrompts: samples };
    }),

  // ── Creator: Create listing from pipeline template ─────────────
  create: authedQuery
    .input(
      z.object({
        templateId: z.number(),
        title: z.string().min(3).max(200),
        description: z.string().optional(),
        objectives: z.string().optional(),
        inputFormat: z.string().optional(),
        outputFormat: z.string().optional(),
        remarks: z.string().optional(),
        category: z.enum(["translation", "writing", "code", "analysis", "creative", "other"]),
        price: z.number().min(0).max(9999),
        isSubscription: z.boolean().optional(),
        subscriptionPrice: z.number().min(0).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user.id;

      // Verify the template belongs to this user
      const [template] = await getDb()
        .select()
        .from(pipelineTemplates)
        .where(and(
          eq(pipelineTemplates.id, input.templateId),
          eq(pipelineTemplates.userId, userId),
        ));

      if (!template) throw new Error("Pipeline template not found or not owned by you");

      // ONLY THE ORIGINAL CREATOR MAY PUBLISH (owner decision 2026-09-22), and
      // the web boundary must apply the identical rule the MCP tool applies —
      // see `assertOriginalCreatorMayList`, which resolves the template's
      // source project and that project's recorded `origin_creator_id`. A
      // share recipient's or a cloner's template therefore cannot be listed,
      // while every pre-lineage template keeps resolving to its own creator.
      await assertOriginalCreatorMayList({ userId, templateId: input.templateId });

      // Create the listing
      const [listing] = await getDb().insert(marketplaceListings).values({
        creatorId: userId,
        templateId: input.templateId,
        title: input.title,
        description: input.description ?? template.description,
        objectives: input.objectives ?? null,
        inputFormat: input.inputFormat ?? null,
        outputFormat: input.outputFormat ?? null,
        remarks: input.remarks ?? null,
        category: input.category,
        price: String(input.price),
        isSubscription: input.isSubscription ?? false,
        subscriptionPrice: input.subscriptionPrice ? String(input.subscriptionPrice) : null,
        status: "draft",
      });

      const listingId = listing.insertId;

      // Encrypt all system prompts from the template steps
      const encrypted = encryptPipelineSteps(template.steps, Number(listingId));
      for (const ep of encrypted) {
        await getDb().insert(encryptedPrompts).values({
          listingId: Number(listingId),
          agentIndex: ep.agentIndex,
          encryptedPrompt: ep.encryptedPrompt,
          iv: ep.iv,
        });
      }

      return { id: Number(listingId), message: "Listing created. Submit for review when ready." };
    }),

  // ── Creator: Update draft listing ──────────────────────────────
  update: authedQuery
    .input(
      z.object({
        id: z.number(),
        title: z.string().min(3).max(200).optional(),
        description: z.string().optional(),
        objectives: z.string().optional(),
        inputFormat: z.string().optional(),
        outputFormat: z.string().optional(),
        remarks: z.string().optional(),
        category: z.enum(["translation", "writing", "code", "analysis", "creative", "other"]).optional(),
        price: z.number().min(0).max(9999).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [listing] = await getDb()
        .select()
        .from(marketplaceListings)
        .where(and(
          eq(marketplaceListings.id, input.id),
          eq(marketplaceListings.creatorId, ctx.user.id),
        ));

      if (!listing) throw new Error("Listing not found");
      if (listing.status !== "draft" && listing.status !== "rejected") {
        throw new Error("Can only edit draft or rejected listings");
      }

      const updateData: Record<string, unknown> = {};
      if (input.title !== undefined) updateData.title = input.title;
      if (input.description !== undefined) updateData.description = input.description;
      if (input.objectives !== undefined) updateData.objectives = input.objectives;
      if (input.inputFormat !== undefined) updateData.inputFormat = input.inputFormat;
      if (input.outputFormat !== undefined) updateData.outputFormat = input.outputFormat;
      if (input.remarks !== undefined) updateData.remarks = input.remarks;
      if (input.category !== undefined) updateData.category = input.category;
      if (input.price !== undefined) updateData.price = String(input.price);

      await getDb()
        .update(marketplaceListings)
        .set(updateData)
        .where(eq(marketplaceListings.id, input.id));

      return { message: "Listing updated" };
    }),

  // ── Creator: Submit for review (FIRE-AND-FORGET) ───────────────
  // Returns immediately. Test data generation runs in background.
  // User can navigate away. Poll getGenerationStatus for progress.
  submitForReview: authedQuery
    .input(z.object({ id: z.number(), giteeToken: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const [listing] = await getDb()
        .select()
        .from(marketplaceListings)
        .where(and(
          eq(marketplaceListings.id, input.id),
          eq(marketplaceListings.creatorId, ctx.user.id),
        ));

      if (!listing) throw new Error("Listing not found");
      if (listing.status !== "draft" && listing.status !== "rejected") {
        throw new Error("Can only submit draft or rejected listings");
      }
      // Refuse BEFORE spending anything on test-data generation: a v2 listing's
      // visibility is decided by its evidence, not by the legacy review flow.
      await assertLegacyFlowAllowed(input.id, "legacy submitForReview");

      // Resubmission idempotency: clear prior review-cycle artifacts so a
      // re-submit regenerates from scratch instead of appending (duplicate
      // test prompts, stale scan input).
      await getDb().delete(testPrompts).where(eq(testPrompts.listingId, input.id));
      await getDb()
        .update(marketplaceListings)
        .set({ aiGrade: null, aiFeedback: null, aiReviewedAt: null })
        .where(eq(marketplaceListings.id, input.id));

      // ─── Step 1 (spec 0.2): deterministic security scan — FIRST gate ──
      // Runs before any LLM call, test generation, or visibility change.
      // Fail → `rejected` with findings stored in aiFeedback ([SECURITY]).
      const scan = await scanListingSecurity(input.id);
      if (!scan.ok) {
        await setLegacyListingStatus(input.id, {
          status: "rejected",
          aiFeedback: `[SECURITY] ${scan.findings.join(" | ")}`,
          aiReviewedAt: new Date(),
        });
        logger.warn("marketplace.security.rejected", { listingId: input.id, findingCount: scan.findings.length });
        return {
          message: `Listing rejected by automated security review. ${scan.findings[0] ?? ""}`.trim(),
          status: "rejected",
          promptsCount: 0,
          giteeSaved: false,
          giteeWarning: undefined,
        };
      }

      // Creator's own provider — needed ONLY for test-data generation (spec
      // 0.3.4). The platform itself pays for ZERO model calls in this flow:
      // no AI triage, no AI ensemble — the old user-key AI review prerequisite
      // (checkAiReviewProviders, 3 distinct providers) is retired with them.
      const providers = await getDb()
        .select()
        .from(llmProviders)
        .where(eq(llmProviders.userId, ctx.user.id))
        .limit(1);

      if (providers.length === 0) {
        throw new Error("You need at least one LLM provider configured to generate test data. Go to Settings > LLM Providers.");
      }
      const provider = providers[0];
      const apiKey = decryptApiKey(provider.apiKeyRef);
      const adapter = createProviderAdapter(provider.slug, apiKey, provider.baseUrl, provider.defaultModel);

      // Step 1: Generate 10 test prompts tailored to pipeline description
      const description = listing.description || listing.objectives || listing.title || "";
      const testData = await generateTestPrompts(input.id, description, listing.title, adapter);
      await getDb().insert(testPrompts).values(
        testData.map((p) => ({ ...p, actualOutput: "[Generating...]" })),
      );

      // Step 2: Set status to generating, get DB ids
      await setLegacyListingStatus(input.id, { status: "generating" });

      const insertedPrompts = await getDb()
        .select()
        .from(testPrompts)
        .where(eq(testPrompts.listingId, input.id))
        .orderBy(testPrompts.promptIndex);

      // Get template name for Gitee folder
      const [template] = await getDb()
        .select()
        .from(pipelineTemplates)
        .where(eq(pipelineTemplates.id, listing.templateId));
      const safeName = (template?.name ?? `pipeline_${listing.templateId}`)
        .replace(/[^a-zA-Z0-9_-]/g, "_");

      // ─── FIRE AND FORGET: background execution ──────────────────
      // Quality-checked: retries failed prompts (max 3 total attempts).
      // Credit errors: pause immediately, revert to draft.
      // If >50% prompts fail after all retries: revert to draft.
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        try {
          // Track each prompt's state
          const promptStates = insertedPrompts.map((p) => ({
            id: p.id,
            promptIndex: p.promptIndex,
            inputText: p.inputText,
            output: "[Generating...]" as string,
            error: null as string | null,
            attempts: 0,
          }));

          // Helper: run a single prompt, return true on success
          const runOnePrompt = async (state: typeof promptStates[0]): Promise<boolean> => {
            state.attempts++;
            try {
              const output = await runTestPipeline(
                input.id, ctx.user.id, listing.templateId,
                state.inputText, state.id,
              );
              // Check for credit-exhausted marker from runTestPipeline
              if (output.startsWith("[CREDIT_EXHAUSTED")) {
                state.output = output;
                state.error = "Credit exhausted";
                return false;
              }
              state.output = output;
              state.error = null;
              await getDb().update(testPrompts)
                .set({ actualOutput: output })
                .where(eq(testPrompts.id, state.id));
              return true;
            } catch (err) {
              const msg = (err as Error).message;
              state.output = `[Error: ${msg}]`;
              state.error = msg;
              await getDb().update(testPrompts)
                .set({ actualOutput: `[Error: ${msg}]` })
                .where(eq(testPrompts.id, state.id));
              return false;
            }
          };

          // ─── First pass: sequential (not parallel — avoid rate limits) ──
          logger.info("Marketplace starting first pass of test generation");
          for (const state of promptStates) {
            await runOnePrompt(state);
          }

          // ─── Check for credit errors ──────────────────────────────────
          const creditFailures = promptStates.filter((s) => s.error === "Credit exhausted");
          if (creditFailures.length > 0) {
            logger.error("Marketplace CREDIT EXHAUSTED, reverting to draft", { failedPrompts: creditFailures.length });
            await setLegacyListingStatus(input.id, { status: "draft" });
            return; // STOP — user must add credit
          }

          // ─── Retry rounds (up to 2 more attempts per prompt) ──────────
          const maxTotalAttempts = 3;
          for (let round = 1; round < maxTotalAttempts; round++) {
            const failed = promptStates.filter((s) => s.error !== null);
            if (failed.length === 0) break; // All succeeded

            logger.info("Marketplace retry round", { round, failedPrompts: failed.length });
            for (const state of failed) {
              if (state.attempts >= maxTotalAttempts) continue;
              const ok = await runOnePrompt(state);
              if (!ok && state.error === "Credit exhausted") {
                // Credit error mid-retry → pause everything
                await setLegacyListingStatus(input.id, { status: "draft" });
                return;
              }
            }
          }

          // ─── Evaluate results ─────────────────────────────────────────
          const totalCount = promptStates.length;
          const finalFailures = promptStates.filter((s) => s.error !== null).length;
          const failureRate = finalFailures / totalCount;

          logger.info("Marketplace generation complete", { succeeded: totalCount - finalFailures, total: totalCount });

          // Save to Gitee (best-effort, even with partial failures)
          if (input.giteeToken) {
            logger.info("Marketplace saving test data to Gitee", { prompts: promptStates.length });
            try {
              const results = promptStates.map((s) => ({ id: s.id, output: s.output, error: s.error }));
              await saveTestDataToGitee(
                input.giteeToken, safeName, input.id,
                listing.title, insertedPrompts, results,
              );
              logger.info("Marketplace Gitee save completed successfully");
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              logger.error("Marketplace Gitee save failed", { error: errMsg });
              // Store the error info in memory — will be picked up by status polling
              await getDb().update(marketplaceListings)
                .set({ description: (listing.description ?? "") + `\n[GITEE_SAVE_ERROR: ${errMsg}]` })
                .where(eq(marketplaceListings.id, input.id));
            }
          } else {
            logger.info("Marketplace no Gitee token provided — skipping Gitee save. Prompt user to add token in Settings");
          }

          // If >50% failed → revert to draft (not enough quality data)
          if (failureRate > 0.5) {
            logger.error("Marketplace too many failures, reverting to draft", { failures: finalFailures, total: totalCount, failureRatePct: (failureRate * 100).toFixed(0) });
            await setLegacyListingStatus(input.id, { status: "draft" });
            return;
          }

          // ─── Step 3: enter `certifying` — VISIBLE, NOT buyable ──────────
          // The platform pays for ZERO model calls here: AI triage and the AI
          // ensemble are gone, and there is no blind human review pool. The
          // deterministic security scan above is the only gate this flow
          // applies. Buyability is decided by the evidence boundary instead —
          // a listing becomes `published` (buyable) when its seller publishes
          // a signed evidence record via marketplace.publishVersion, which
          // refuses to publish without consent to the exact measured version.
          // So the certification gate is: security scan (here) + a published
          // evidence record (there) — never N human reviews.
          await setLegacyListingStatus(input.id, { status: "certifying" });
          logger.info("marketplace.certifying", { listingId: input.id });
        } catch (e) {
          if (e instanceof V2PublicationLockedError) {
            // The listing moved under the v2 boundary while generation ran. The
            // v2 rules own its status from here on — there is nothing to revert.
            logger.warn("Marketplace background generation stopped: listing is v2-published", { listingId: input.id });
            return;
          }
          logger.error("Marketplace background gen failed", { error: (e as Error).message });
          // This runs OUTSIDE the awaited request: a refusal here (the listing
          // went v2 while generation was running) must not become an unhandled
          // rejection. The listing keeps whatever status the v2 boundary set.
          await setLegacyListingStatus(input.id, { status: "draft" }).catch((err) => {
            logger.warn("Marketplace background revert to draft skipped", { listingId: input.id, error: (err as Error).message });
          });
        }
      })();
      // ─── END FIRE AND FORGET ────────────────────────────────────

      return {
        message: "Generation started. Navigate away freely — it will continue.",
        status: "generating",
        promptsCount: testData.length,
        giteeSaved: !!input.giteeToken,
        giteeWarning: input.giteeToken
          ? undefined
          : "No Gitee token found. Test data will be saved locally only. Add your token in Settings > Gitee for cloud backup.",
      };
    }),

  // ── Creator: Self-test pipeline before submitting for review ────
  // Runs a single custom prompt through the pipeline and returns the output
  // with all intermediate step traces. Saves to Gitee if token provided.
  creatorSelfTest: authedQuery
    .input(z.object({
      listingId: z.number(),
      testInput: z.string().min(1).max(5000),
      giteeToken: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const [listing] = await getDb()
        .select()
        .from(marketplaceListings)
        .where(and(
          eq(marketplaceListings.id, input.listingId),
          eq(marketplaceListings.creatorId, ctx.user.id),
        ));

      if (!listing) throw new Error("Listing not found");

      const providers = await getDb()
        .select()
        .from(llmProviders)
        .where(eq(llmProviders.userId, ctx.user.id))
        .limit(1);

      if (providers.length === 0) throw new Error("No LLM provider configured");
      const provider = providers[0];
      const apiKey = decryptApiKey(provider.apiKeyRef);
      const adapter = createProviderAdapter(provider.slug, apiKey, provider.baseUrl, provider.defaultModel);

      // Get template
      const [template] = await getDb()
        .select()
        .from(pipelineTemplates)
        .where(eq(pipelineTemplates.id, listing.templateId));

      if (!template) throw new Error("Pipeline template not found");

      const steps = template.steps;
      if (!steps || steps.length === 0) throw new Error("Pipeline has no steps");

      // Run pipeline step by step
      let currentContext = input.testInput;
      let finalOutput = "";
      const stepTraces: Array<{
        stepIndex: number;
        stepName: string;
        stepRole: string;
        input: string;
        output: string;
        latencyMs: number;
        tokensUsed: number | null;
      }> = [];

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (step.stepType && step.stepType !== "agent") continue;

        let systemPrompt = step.systemPrompt;
        if (!systemPrompt) {
          const [encPrompt] = await getDb()
            .select()
            .from(encryptedPrompts)
            .where(and(
              eq(encryptedPrompts.listingId, input.listingId),
              eq(encryptedPrompts.agentIndex, i),
            ))
            .limit(1);
          if (encPrompt) {
            const { decryptPrompt } = await import("../lib/marketplaceCrypto");
            systemPrompt = decryptPrompt(encPrompt.encryptedPrompt, input.listingId);
          } else {
            systemPrompt = `You are a ${step.role || step.name}. Process the input and produce a high-quality output.`;
          }
        }

        const messages = [
          { role: "system" as const, content: systemPrompt },
          { role: "user" as const, content: currentContext },
        ];
        const stepInput = currentContext;
        const startTime = Date.now();

        try {
          const result = await adapter.chat(messages, {
            model: step.model ?? provider.defaultModel,
            temperature: parseFloat(step.temperature ?? "0.7"),
            maxTokens: step.maxTokens ?? 4096,
          });
          const latencyMs = Date.now() - startTime;
          currentContext = result.content;
          finalOutput = result.content;
          stepTraces.push({
            stepIndex: i,
            stepName: step.name || `Step ${i}`,
            stepRole: step.role || "agent",
            input: stepInput,
            output: result.content,
            latencyMs,
            tokensUsed: result.usage?.totalTokens ?? null,
          });
        } catch (err) {
          const errorMsg = (err as Error).message;
          stepTraces.push({
            stepIndex: i,
            stepName: step.name || `Step ${i}`,
            stepRole: step.role || "agent",
            input: stepInput,
            output: `[Error: ${errorMsg}]`,
            latencyMs: Date.now() - startTime,
            tokensUsed: null,
          });
          finalOutput = `[Pipeline Error at step "${step.name}": ${errorMsg}]`;
          break;
        }
      }

      // Save to Gitee under test_data/self_tests/{listing_id}_{timestamp}/
      if (input.giteeToken) {
        try {
          const safeName = template.name.replace(/[^a-zA-Z0-9_-]/g, "_");
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const basePath = `test_data/self_tests/${safeName}_${input.listingId}_${timestamp}`;

          const reposRes = await fetch(
            `https://gitee.com/api/v5/user/repos?access_token=${input.giteeToken}&type=owner&page=1&per_page=20`,
          );
          if (reposRes.ok) {
            const repos = (await reposRes.json()) as Array<{ owner: { login: string }; name: string; path?: string }>;
            const targetRepo = repos.find((r) => r.name === "swarm-studio" || (r.path && r.path === "swarm-studio"));
            if (targetRepo) {
              const owner = targetRepo.owner.login;
              const repo = targetRepo.name;

              // Save input
              await createOrUpdateFile(
                input.giteeToken, owner, repo,
                `${basePath}/input.txt`,
                input.testInput,
                `Self-test input for "${listing.title}"`,
              );

              // Save each step trace
              for (const trace of stepTraces) {
                const idx = String(trace.stepIndex + 1).padStart(2, "0");
                await createOrUpdateFile(
                  input.giteeToken, owner, repo,
                  `${basePath}/step_${idx}_${trace.stepName.replace(/[^a-zA-Z0-9]/g, "_")}.md`,
                  `# Step ${trace.stepIndex + 1}: ${trace.stepName}\n\n**Role**: ${trace.stepRole}\n**Latency**: ${trace.latencyMs}ms\n**Tokens**: ${trace.tokensUsed ?? "N/A"}\n\n## Input\n\n${trace.input}\n\n## Output\n\n${trace.output}`,
                  `Self-test step ${trace.stepIndex + 1} for "${listing.title}"`,
                );
              }

              // Save final output
              await createOrUpdateFile(
                input.giteeToken, owner, repo,
                `${basePath}/final_output.txt`,
                finalOutput,
                `Self-test final output for "${listing.title}"`,
              );

              logger.info("SelfTest saved to Gitee", { basePath });
            }
          }
        } catch (e) {
          logger.warn("SelfTest Gitee save failed", { error: (e as Error).message });
          // Don't fail the self-test if Gitee save fails
        }
      }

      return {
        finalOutput,
        stepCount: steps.length,
        agentSteps: stepTraces.length,
        traces: stepTraces,
        pipelineName: template.name,
      };
    }),

  // ── Creator: Publish/unpublish ─────────────────────────────────
  publish: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const [listing] = await getDb()
        .select()
        .from(marketplaceListings)
        .where(and(
          eq(marketplaceListings.id, input.id),
          eq(marketplaceListings.creatorId, ctx.user.id),
        ));

      if (!listing) throw new Error("Listing not found");
      // Nothing grants `approved` any more — the reviewer quorum that wrote it
      // was removed. A seller clicking this needs the door that exists, not a
      // status that can never arrive.
      if (listing.status !== "approved") throw new Error(
        "publish_version is how a listing goes live: submit the benchmark evidence for this "
        + `version (status is '${listing.status}'). There is no human approval step to wait for.`,
      );

      await setLegacyListingStatus(input.id, { status: "published" }, { ownerId: ctx.user.id });

      return { message: "Listing published" };
    }),

  unpublish: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      await setLegacyListingStatus(input.id, { status: "unpublished" }, { ownerId: ctx.user.id });

      return { message: "Listing unpublished" };
    }),

  // ── V2: the sole seller publication boundary (spec §10.1) ─────────
  // Evidence and the version it describes are linked in one transaction, and
  // the caller must name the workflow version they are actually selling —
  // a new revision cannot inherit an older revision's scores (A11).
  publishVersion: authedQuery
    .input(z.object({
      listingId: z.number().int().positive(),
      workflowVersionId: z.number().int().positive(),
      benchmarkId: z.number().int().positive(),
      previewHash: z.string().length(64),
      consentVersion: z.string().min(1).max(40),
      expectedListingRevision: z.number().int().nonnegative().optional(),
      withholdInputs: z.boolean().optional(),
      withheldReason: z.string().min(3).max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) =>
      publishVersion({
        userId: ctx.user.id, listingId: input.listingId, workflowVersionId: input.workflowVersionId,
        benchmarkId: input.benchmarkId, previewHash: input.previewHash, consentVersion: input.consentVersion,
        expectedListingRevision: input.expectedListingRevision,
        withholdInputs: input.withholdInputs, withheldReason: input.withheldReason,
      }),
    ),

  /** Owner-scoped read of where a listing currently stands under the v2 rules:
   *  which version is sold, which evidence backs it, and the revision token to
   *  pass as `expectedListingRevision`. Never returns the private benchmark. */
  publicationState: authedQuery
    .input(z.object({ listingId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const [listing] = await db.select({ id: marketplaceListings.id, status: marketplaceListings.status })
        .from(marketplaceListings)
        .where(and(eq(marketplaceListings.id, input.listingId), eq(marketplaceListings.creatorId, ctx.user.id)))
        .limit(1);
      if (!listing) throw new Error("not_found_or_not_authorized");
      const [v2] = await db.select().from(marketplaceListingV2)
        .where(eq(marketplaceListingV2.listingId, listing.id)).limit(1);
      return {
        listingId: listing.id,
        listingStatus: listing.status,
        publicationMode: v2?.publicationMode ?? "legacy",
        currentWorkflowVersionId: v2?.currentWorkflowVersionId ?? null,
        currentEvidencePublicationId: v2?.currentEvidencePublicationId ?? null,
        evidenceSummaryRevision: v2?.evidenceSummaryRevision ?? 0,
      };
    }),

  // ── Public evidence reads: manifest DTOs only, never private rows ─
  getPublicEvidence: publicQuery
    .input(z.object({ listingId: z.number().int().positive() }))
    .query(async ({ input }) => ({ manifest: await getPublicEvidenceForListing(input.listingId) })),

  listCommunityEvidence: publicQuery
    .input(z.object({
      listingId: z.number().int().positive(),
      workflowVersionId: z.number().int().positive().optional(),
      model: z.string().max(120).optional(),
      includeWithdrawn: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }))
    .query(async ({ input }) => listPublicEvidenceForListing(input.listingId, {
      kind: "community", workflowVersionId: input.workflowVersionId, model: input.model,
      includeWithdrawn: input.includeWithdrawn, limit: input.limit,
    })),

  /** Every publication attached to a listing — the shop front's "who inspected
   *  what" list. Seller evidence included, and withdrawals stay VISIBLE as
   *  withdrawn: a reader who followed an old link deserves to learn the record
   *  was pulled, not that it never existed. Manifest DTOs only. */
  listListingEvidence: publicQuery
    .input(z.object({
      listingId: z.number().int().positive(),
      workflowVersionId: z.number().int().positive().optional(),
    }))
    .query(async ({ input }) => listPublicEvidenceForListing(input.listingId, {
      workflowVersionId: input.workflowVersionId,
      includeWithdrawn: true,
      limit: 50,
    })),

  /** A manifest addressed by the hash a reader was given (§6.2 canonical URL). */
  getEvidenceByHash: publicQuery
    .input(z.object({ manifestHash: z.string().length(64) }))
    .query(async ({ input }) => ({ manifest: await getPublishedManifestByHash(input.manifestHash) })),

  getPurchasedEvidence: authedQuery
    .input(z.object({ listingId: z.number().int().positive() }))
    .query(({ input, ctx }) => getPurchasedEvidenceForListing({ userId: ctx.user.id, listingId: input.listingId })),

  getEvidenceReceipt: authedQuery
    .input(z.object({ publicationId: z.number().int().positive() }))
    .query(({ input, ctx }) => getEvidenceForViewer({ userId: ctx.user.id, publicationId: input.publicationId })),

  // ── Creator: Delete a listing ──────────────────────────────────
  // Removes the listing and its generated test artifacts. Review-derived
  // rows (listing_reviews, review_assignments, blind_review_tasks) carry
  // ON DELETE CASCADE from the listing FK, so they clear with it.
  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const [listing] = await getDb()
        .select()
        .from(marketplaceListings)
        .where(and(
          eq(marketplaceListings.id, input.id),
          eq(marketplaceListings.creatorId, ctx.user.id),
        ));

      if (!listing) throw new Error("Listing not found");
      // A v2 listing carries public evidence whose FK is RESTRICT — deleting it
      // would strand the manifest buyers were shown. Say so instead of 500ing.
      await assertLegacyFlowAllowed(input.id, "delete");

      // Delete intermediates: first get all test prompt IDs for this listing
      const prompts = await getDb()
        .select({ id: testPrompts.id })
        .from(testPrompts)
        .where(eq(testPrompts.listingId, input.id));
      const promptIds = prompts.map((p) => p.id);

      // Delete in FK-safe order
      if (promptIds.length > 0) {
        for (const pid of promptIds) {
          await getDb().delete(testPromptIntermediate)
            .where(eq(testPromptIntermediate.testPromptId, pid));
        }
        await getDb().delete(testPrompts)
          .where(eq(testPrompts.listingId, input.id));
      }
      await getDb().delete(encryptedPrompts)
        .where(eq(encryptedPrompts.listingId, input.id));

      // Delete the listing
      await getDb().delete(marketplaceListings)
        .where(eq(marketplaceListings.id, input.id));

      return { message: "Listing deleted" };
    }),

  // ── Creator: Get my listings ───────────────────────────────────
  myListings: authedQuery.query(async ({ ctx }) => {
    const listings = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.creatorId, ctx.user.id))
      .orderBy(desc(marketplaceListings.createdAt));

    return listings;
  }),

  // ── Creator: Poll generation status (for "generating" listings) ─
  getGenerationStatus: authedQuery
    .input(z.object({ listingId: z.number() }))
    .query(async ({ input, ctx }) => {
      const [listing] = await getDb()
        .select()
        .from(marketplaceListings)
        .where(and(
          eq(marketplaceListings.id, input.listingId),
          eq(marketplaceListings.creatorId, ctx.user.id),
        ));

      if (!listing) throw new Error("Listing not found");

      const totalPrompts = await getDb()
        .select({ count: count() })
        .from(testPrompts)
        .where(eq(testPrompts.listingId, input.listingId));

      const generatedCount = await getDb()
        .select({ count: count() })
        .from(testPrompts)
        .where(and(
          eq(testPrompts.listingId, input.listingId),
          sql`${testPrompts.actualOutput} IS NOT NULL`,
          sql`${testPrompts.actualOutput} != '[Generating...]'`,
        ));

      // Check for credit-exhausted markers in any prompt
      const creditErrors = await getDb()
        .select({ count: count() })
        .from(testPrompts)
        .where(and(
          eq(testPrompts.listingId, input.listingId),
          sql`${testPrompts.actualOutput} LIKE '%CREDIT_EXHAUSTED%'`,
        ));
      const hasCreditError = (creditErrors[0]?.count ?? 0) > 0;

      // Count prompts with errors (not credit, not still generating)
      const errorCount = await getDb()
        .select({ count: count() })
        .from(testPrompts)
        .where(and(
          eq(testPrompts.listingId, input.listingId),
          sql`${testPrompts.actualOutput} LIKE '%Error:%'`,
        ));

      const promptCount = totalPrompts[0]?.count ?? 0;
      const doneCount = generatedCount[0]?.count ?? 0;
      const errCount = errorCount[0]?.count ?? 0;

      // Build status message
      let message = "";
      if (hasCreditError) {
        message = "API credit exhausted during generation. Please add credit to your provider account and submit again.";
      } else if (listing.status === "generating") {
        message = `Generating test data... ${doneCount} of ${promptCount} completed`;
      } else if (listing.status === "pending_review") {
        message = errCount > 0
          ? `Test data ready (${promptCount - errCount}/${promptCount} prompts succeeded). Waiting for reviewers.`
          : "Test data ready. Waiting for reviewers.";
      } else if (listing.status === "reviewing") {
        message = "Review in progress.";
      } else if (listing.status === "certifying") {
        message = "Test data ready and the security scan passed — your pipeline is visible in the marketplace. It becomes buyable once you publish its signed evidence record; until then it stays locked.";
      } else if (listing.status === "published") {
        message = "Published — your pipeline is live and buyable.";
      } else if (listing.status === "rejected") {
        message = "This listing was rejected during review. See the feedback, revise, and resubmit.";
      } else if (listing.status === "draft") {
        message = doneCount > 0
          ? `Generation incomplete (${doneCount}/${promptCount} prompts). Submit again to retry failed prompts.`
          : "Ready for submission.";
      }

      return {
        status: listing.status,
        totalPrompts: promptCount,
        generated: doneCount,
        errors: errCount,
        hasCreditError,
        isGenerating: listing.status === "generating",
        isReady: listing.status === "pending_review" || listing.status === "reviewing",
        message,
      };
    }),

  // ── Creator: Get test prompts (for display in dashboard) ───────
  getTestPrompts: authedQuery
    .input(z.object({ listingId: z.number() }))
    .query(async ({ input, ctx }) => {
      const [listing] = await getDb()
        .select()
        .from(marketplaceListings)
        .where(and(
          eq(marketplaceListings.id, input.listingId),
          eq(marketplaceListings.creatorId, ctx.user.id),
        ));

      if (!listing) throw new Error("Listing not found or not owned by you");

      try {
        const prompts = await getDb()
          .select()
          .from(testPrompts)
          .where(eq(testPrompts.listingId, input.listingId))
          .orderBy(testPrompts.promptIndex);

        logger.info("getTestPrompts found prompts", { count: prompts.length, listingId: input.listingId });
        return prompts;
      } catch (err) {
        logger.error("getTestPrompts DB error", { listingId: input.listingId, error: (err as Error).message });
        throw new Error(`Failed to load test prompts: ${(err as Error).message}`);
      }
    }),

  // ── Creator: Debug endpoint — check raw DB state ───────────────
  debugListing: authedQuery
    .input(z.object({ listingId: z.number() }))
    .query(async ({ input, ctx }) => {
      const [listing] = await getDb()
        .select()
        .from(marketplaceListings)
        .where(and(
          eq(marketplaceListings.id, input.listingId),
          eq(marketplaceListings.creatorId, ctx.user.id),
        ));

      if (!listing) return { error: "Listing not found" };

      const prompts = await getDb()
        .select({
          id: testPrompts.id,
          promptIndex: testPrompts.promptIndex,
          inputText: testPrompts.inputText,
          actualOutput: testPrompts.actualOutput,
          hasOutput: sql`CASE WHEN ${testPrompts.actualOutput} IS NOT NULL THEN 1 ELSE 0 END`,
          outputLength: sql`LENGTH(${testPrompts.actualOutput})`,
        })
        .from(testPrompts)
        .where(eq(testPrompts.listingId, input.listingId))
        .orderBy(testPrompts.promptIndex);

      const intermediates = await getDb()
        .select({ count: count() })
        .from(testPromptIntermediate)
        .where(sql`${testPromptIntermediate.testPromptId} IN (SELECT id FROM test_prompts WHERE listing_id = ${input.listingId})`);

      return {
        listingStatus: listing.status,
        promptCount: prompts.length,
        promptsWithOutput: prompts.filter((p) => p.actualOutput !== null && p.actualOutput !== "[Generating...]").length,
        promptsGenerating: prompts.filter((p) => p.actualOutput === "[Generating...]").length,
        promptsWithError: prompts.filter((p) => p.actualOutput?.startsWith("[Error:")).length,
        intermediateCount: intermediates[0]?.count ?? 0,
        raw: prompts,
      };
    }),

  // ── Creator: Get intermediate pipeline responses for a test prompt ─
  getIntermediateResponses: authedQuery
    .input(z.object({ testPromptId: z.number() }))
    .query(async ({ input, ctx }) => {
      // Verify the test prompt belongs to a listing owned by this user
      const [tp] = await getDb()
        .select()
        .from(testPrompts)
        .where(eq(testPrompts.id, input.testPromptId));

      if (!tp) throw new Error("Test prompt not found");

      const [listing] = await getDb()
        .select()
        .from(marketplaceListings)
        .where(and(
          eq(marketplaceListings.id, tp.listingId),
          eq(marketplaceListings.creatorId, ctx.user.id),
        ));

      if (!listing) throw new Error("Not authorized");

      const intermediates = await getDb()
        .select()
        .from(testPromptIntermediate)
        .where(eq(testPromptIntermediate.testPromptId, input.testPromptId))
        .orderBy(testPromptIntermediate.stepIndex);

      return intermediates;
    }),

  // ── Buyer: take delivery of a purchased copy (v3 Class A) ───────
  // Sold as a copy, decided 2026-10-13: the entitlement IS the purchase/grant
  // row, resolved by the same authority a protected run consults. So this needs
  // no flag and no payment configuration to exist — and a refund closes the
  // delivery door at the exact moment it closes the run door.
  deliverCopy: authedQuery
    .input(deliverPurchasedCopyInputSchema)
    .mutation(async ({ input, ctx }) => deliverPurchasedCopy(ctx.user.id, input)),

  // ── Buyer: Fork a public listing (free, open-source sharing) ─────
  // The marketplace sells nothing: a published listing with published
  // evidence may be forked into anyone's account at no cost. The service
  // enforces the evidence gate and attribution.
  forkListing: authedQuery
    .input(forkPublicListingInputSchema)
    .mutation(async ({ input, ctx }) => forkPublicListing(ctx.user.id, input)),

  // ── Buyer: Purchase listing ────────────────────────────────────
  // ── Buyer: Purchase a listing via Stripe Checkout (Phase 1) ─────
  // Returns a hosted checkout URL. The purchase ledger row, sales
  // counter, and entitlement grant are written ONLY by the Stripe
  // webhook after payment confirms (see services/entitlementSync).
  purchase: authedQuery
    .input(z.object({ listingId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      // Feature-flag gated rollout (store_relaunch)
      const enabled = await isFeatureEnabled("store_relaunch", ctx.user.id);
      if (!enabled) throw new Error("Marketplace purchases are not available yet");
      if (!isBillingConfigured()) {
        throw new BillingNotConfiguredError();
      }

      const [listing] = await getDb()
        .select()
        .from(marketplaceListings)
        .where(eq(marketplaceListings.id, input.listingId));

      if (!listing) throw new Error("Listing not found");
      // Buyability guard (spec 0.4): only human-certified (`published`)
      // listings may transact. `certifying` listings are visible but locked.
      if (listing.status === "certifying") {
        throw new Error("This pipeline is still being certified and cannot be purchased yet.");
      }
      if (listing.status !== "published") throw new Error("Listing is not available for purchase");

      // Already owns it (ledger row or live entitlement)
      const [existing] = await getDb()
        .select()
        .from(marketplacePurchases)
        .where(and(
          eq(marketplacePurchases.buyerId, ctx.user.id),
          eq(marketplacePurchases.listingId, input.listingId),
          eq(marketplacePurchases.status, "active"),
        ));
      if (existing) throw new Error("You already own this pipeline");
      if (await entitlementCan(ctx.user.id, purchaseCapability(input.listingId))) {
        throw new Error("You already own this pipeline");
      }

      const priceCents = Math.round(parseFloat(String(listing.price)) * 100);
      if (priceCents <= 0) throw new Error("Invalid listing price");

      const origin = requestOrigin(ctx.req);
      const { url } = await createMarketplaceCheckoutSession({
        userId: ctx.user.id,
        listingId: input.listingId,
        title: listing.title,
        amountCents: priceCents,
        successUrl: `${origin}/marketplace/${input.listingId}?checkout=success`,
        cancelUrl: `${origin}/marketplace/${input.listingId}?checkout=cancel`,
      });

      return { checkoutUrl: url };
    }),

  // ── Buyer: Check if purchased ──────────────────────────────────
  checkPurchase: authedQuery
    .input(z.object({ listingId: z.number() }))
    .query(async ({ input, ctx }) => {
      const [purchase] = await getDb()
        .select()
        .from(marketplacePurchases)
        .where(and(
          eq(marketplacePurchases.buyerId, ctx.user.id),
          eq(marketplacePurchases.listingId, input.listingId),
          eq(marketplacePurchases.status, "active"),
        ));

      // Entitlement is the enforcement layer; either source means owned.
      const entitled = await entitlementCan(ctx.user.id, purchaseCapability(input.listingId));
      return { purchased: !!purchase || entitled, purchase: purchase ?? null };
    }),

  // ── Buyer: Get my purchases ────────────────────────────────────
  myPurchases: authedQuery.query(async ({ ctx }) => {
    const purchases = await getDb()
      .select({
        id: marketplacePurchases.id,
        listingId: marketplacePurchases.listingId,
        amountPaid: marketplacePurchases.amountPaid,
        status: marketplacePurchases.status,
        createdAt: marketplacePurchases.createdAt,
        title: marketplaceListings.title,
        category: marketplaceListings.category,
      })
      .from(marketplacePurchases)
      .innerJoin(marketplaceListings, eq(marketplacePurchases.listingId, marketplaceListings.id))
      .where(eq(marketplacePurchases.buyerId, ctx.user.id))
      .orderBy(desc(marketplacePurchases.createdAt));

    return purchases;
  }),

});
