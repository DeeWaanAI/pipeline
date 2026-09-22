import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "../middleware";
import { eq, and, ne, desc, sql, count, inArray } from "drizzle-orm";
import { getDb, getReadDb } from "../queries/connection";
import {
  marketplaceListings,
  marketplaceListingV2,
  testPrompts,
  testPromptIntermediate,
  listingReviews,
  reviewerProfiles,
  reviewAssignments,
  blindReviewTasks,
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
import {
  getPublishedManifestByHash, getPublicEvidenceForListing, listPublicEvidenceForListing, publishVersion,
  getEvidenceForViewer, getPurchasedEvidenceForListing,
} from "../services/evidenceService";
import { logger } from "../lib/logger";
import { env, isAiTriageConfigured } from "../lib/env";
import { can as entitlementCan, grant as entitlementGrant } from "../services/entitlements";
import { purchaseCapability } from "../services/entitlementSync";
import {
  createMarketplaceCheckoutSession,
  isBillingConfigured,
  BillingNotConfiguredError,
} from "../services/billingService";
import { scanListingSecurity } from "../services/promptSecurityScan";
import { runAiTriage } from "../services/aiEnsembleReviewService";

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

// ─── Certification policy (Phase 1) ──────────────────────────────
// A listing can only be graded when at least MIN_UNIQUE_REVIEWERS distinct
// reviewers (excluding the pipeline designer) have submitted reviews, with at
// least MIN_REVIEWS_PER_REVIEWER reviewed prompts each. Override via env vars
// for beta (e.g., 1/1 for self-certification), defaults are 5/3.
const MIN_UNIQUE_REVIEWERS = env.marketplaceMinReviewers;
const MIN_REVIEWS_PER_REVIEWER = env.marketplaceMinReviewsPerReviewer;
const MIN_TOTAL_REVIEWS = MIN_UNIQUE_REVIEWERS * MIN_REVIEWS_PER_REVIEWER;

// ─── Kappa Calculator (Fleiss' Kappa for 3+ raters) ──────────────
export function calculateFleissKappa(
  ratings: number[][],
  categories: number,
): { kappa: number; pe: number } {
  const n = ratings.length; // number of prompts
  const m = ratings[0]?.length ?? 0; // number of raters

  if (n === 0 || m === 0) return { kappa: 0, pe: 0 };

  // Kappa is mathematically undefined with < 2 raters
  // With 1 reviewer, we treat agreement as perfect (1.0) by definition
  if (m < 2) return { kappa: 1.0, pe: 0 };

  // For each prompt, count how many raters assigned each category (1-5)
  const categoryCounts: number[][] = [];
  for (let i = 0; i < n; i++) {
    const counts = new Array(categories).fill(0);
    for (let j = 0; j < m; j++) {
      const rating = ratings[i][j];
      if (rating >= 1 && rating <= categories) {
        counts[rating - 1]++;
      }
    }
    categoryCounts.push(counts);
  }

  // P_i: extent of agreement for each prompt
  let sumPi = 0;
  for (let i = 0; i < n; i++) {
    let sumSq = 0;
    for (let k = 0; k < categories; k++) {
      sumSq += categoryCounts[i][k] * categoryCounts[i][k];
    }
    sumPi += (sumSq - m) / (m * (m - 1));
  }
  const Pbar = sumPi / n;

  // P_e: chance agreement
  let sumPe = 0;
  for (let k = 0; k < categories; k++) {
    let pK = 0;
    for (let i = 0; i < n; i++) {
      pK += categoryCounts[i][k];
    }
    pK /= n * m;
    sumPe += pK * pK;
  }
  const Pe = sumPe;

  if (Pe >= 0.999) return { kappa: 1, pe: Pe };

  const kappa = (Pbar - Pe) / (1 - Pe);
  return { kappa: Math.max(-1, Math.min(1, kappa)), pe: Pe };
}

/**
 * Bucket a review's weighted score for the kappa computation (Trust spec
 * calibration, 2026-07-27): kappa must measure agreement on the CERTIFICATION
 * DECISION (acceptable or not), not on exact 1–5 values. Fleiss' kappa on raw
 * 5-point ratings suffers the prevalence problem — real panels clustering at
 * 4–5 get "disagreement" verdicts despite agreeing the listing is good
 * (rehearsal evidence: grade 4.29 rejected on kappa 0.479 with only ±1 jitter).
 * Buckets: 2 = pass (≥ CERTIFY_MIN_AVG_SCORE), 1 = fail. The 1–5 weighted
 * average remains the quality grade; only agreement measurement is bucketed.
 */
export function bucketForKappa(weightedScore: number): number {
  return weightedScore >= CERTIFY_MIN_AVG_SCORE ? 2 : 1;
}

/** Number of kappa categories when ratings are bucketed (fail / pass). */
export const KAPPA_BUCKET_CATEGORIES = 2;

// ─── Weighted Score Calculator ─────────────────────────────────────
const DIMENSION_WEIGHTS = {  accuracy: 0.30,
  completeness: 0.20,
  clarity: 0.15,
  tokenEfficiency: 0.10,
  speed: 0.10,
  consistency: 0.15,
};

function calculateWeightedScore(dimensions: {
  accuracy: number;
  completeness: number;
  clarity: number;
  tokenEfficiency: number;
  speed: number;
  consistency: number;
}): number {
  return (
    dimensions.accuracy * DIMENSION_WEIGHTS.accuracy +
    dimensions.completeness * DIMENSION_WEIGHTS.completeness +
    dimensions.clarity * DIMENSION_WEIGHTS.clarity +
    dimensions.tokenEfficiency * DIMENSION_WEIGHTS.tokenEfficiency +
    dimensions.speed * DIMENSION_WEIGHTS.speed +
    dimensions.consistency * DIMENSION_WEIGHTS.consistency
  );
}

// ─── Marketplace Trust & Certification (spec v2, Phase 0) ──────────
// AI triage rejection floor (spec 0.3): below this the listing is rejected
// with feedback; at/above it goes to `certifying`. AI NEVER publishes.
export const AI_TRIAGE_FLOOR = 2.5;

// Human certification thresholds (spec 0.5.5) — the buyability gate.
export const CERTIFY_MIN_AVG_SCORE = 3.5;
export const CERTIFY_MIN_KAPPA = 0.60; // DEPRECATED as a gate — kept as a logged diagnostic
// Certification gate (2026-07-28, beta-simulation evidence): minimum share of
// reviews that pass the CERTIFY_MIN_AVG_SCORE bar. Fleiss' kappa was retired
// as the agreement gate: at high pass rates it collapses toward zero no
// matter how much reviewers actually agree (prevalence paradox — a 4.87-avg
// listing scored kappa 0.01 and was rejected). Pass-ratio is the standard,
// robust alternative at extreme prevalence; kappa is still computed + logged.
export const CERTIFY_MIN_PASS_RATIO = 0.8;

/**
 * Pure certification decision (2026-07-28 redesign): a listing passes blind
 * human review when its weighted-average score clears the bar AND at least
 * CERTIFY_MIN_PASS_RATIO of individual reviews pass the bar. The second
 * condition catches "a few fans carry a mediocre listing" and "a few
 * haters sink a good listing" — the two failure modes the kappa gate was
 * meant to prevent but couldn't measure reliably.
 */
export function decideCertification(
  avgScore: number,
  passRatio: number,
): "published" | "rejected" {
  return avgScore >= CERTIFY_MIN_AVG_SCORE && passRatio >= CERTIFY_MIN_PASS_RATIO
    ? "published"
    : "rejected";
}

// Static scoring rubric handed to blind reviewers with each task (spec 0.5.3).
export const REVIEW_RUBRIC = {
  accuracy: "1-5: Is the output correct and faithful to the input?",
  completeness: "1-5: Does the output cover everything the input asked for?",
  clarity: "1-5: Is the output well-structured and easy to understand?",
  tokenEfficiency: "1-5: Is the output concise, without padding or waste?",
  speed: "1-5: Was the pipeline's responsiveness acceptable?",
  consistency: "1-5: Is the output internally consistent and on-style?",
} as const;

export interface BlindReviewScores {
  accuracy: number;
  completeness: number;
  clarity: number;
  tokenEfficiency: number;
  speed: number;
  consistency: number;
  reviewTime: number;
}

/**
 * Pure payload builder — the ONLY thing a blind reviewer ever sees.
 * Deliberately contains no listingId, title, creator, or category (spec 0.5.3).
 */
export function toBlindTaskPayload(
  taskId: number,
  inputText: string,
  actualOutput: string | null,
): { taskId: number; inputText: string; actualOutput: string | null; rubric: typeof REVIEW_RUBRIC } {
  return { taskId, inputText, actualOutput, rubric: REVIEW_RUBRIC };
}

/**
 * Enqueue a listing's test prompts into the blind review pool as UNASSIGNED
 * (`pooled`, reviewerId NULL) tasks (spec 0.5.2). Each prompt gets
 * MIN_UNIQUE_REVIEWERS pooled copies — one per required reviewer. A single
 * row per (listing, prompt) could never reach the reviewers×reviews quorum
 * (e.g. 10 prompts × 1 row = 10 reviews < 15 needed for 5×3).
 * Re-enqueueing wipes leftover task rows first: a listing can only
 * (re)enter `certifying` from draft/rejected, so no tasks should be in
 * flight; the actual reviews live in listing_reviews, not here.
 * (MySQL unique indexes treat NULL reviewer_id as distinct, so the pooled
 * copies are legal despite unique(listingId, promptIndex, reviewerId).)
 */
export async function enqueueBlindReviewTasks(listingId: number): Promise<number> {
  // Fresh certification round — clear any leftover pool rows for this listing.
  await getDb().delete(blindReviewTasks).where(eq(blindReviewTasks.listingId, listingId));

  const prompts = await getDb()
    .select({ promptIndex: testPrompts.promptIndex })
    .from(testPrompts)
    .where(eq(testPrompts.listingId, listingId));

  let enqueued = 0;
  for (const p of prompts) {
    for (let copy = 0; copy < MIN_UNIQUE_REVIEWERS; copy++) {
      await getDb().insert(blindReviewTasks).values({
        listingId,
        promptIndex: p.promptIndex,
        reviewerId: null,
        status: "pooled",
      });
      enqueued++;
    }
  }
  logger.info("marketplace.blindpool.enqueue", {
    listingId, enqueued, prompts: prompts.length, copiesPerPrompt: MIN_UNIQUE_REVIEWERS,
  });
  return enqueued;
}

/**
 * Claim ONE pooled blind task for a reviewer (spec 0.5.3). Server-side only —
 * the listing identity never leaves this function. Rules:
 *  - reviewer must have reviewerProfiles.status = 'active'
 *  - self-review ban: never a listing whose creatorId === reviewerId
 *  - no clustering: skip listings the reviewer currently holds an OPEN
 *    ('assigned') task for; once completed/expired they may draw another
 *    prompt from the same listing (this is how a reviewer reaches the
 *    MIN_REVIEWS_PER_REVIEWER quota on one listing over time)
 *  - atomic claim: conditional UPDATE … WHERE reviewer_id IS NULL, then
 *    re-read to confirm we won the race; retry a few times on contention
 * Returns the blind payload ({ taskId, inputText, actualOutput, rubric }) or
 * null when no eligible task exists.
 */
export async function claimNextBlindTask(
  reviewerId: number,
): Promise<ReturnType<typeof toBlindTaskPayload> | null> {
  const [profile] = await getDb()
    .select()
    .from(reviewerProfiles)
    .where(eq(reviewerProfiles.userId, reviewerId))
    .limit(1);

  if (!profile || profile.status !== "active" || !profile.isActive) {
    throw new Error("You must be an active reviewer to pull review tasks. Enroll first.");
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const [candidate] = await getDb()
      .select({
        id: blindReviewTasks.id,
        listingId: blindReviewTasks.listingId,
        promptIndex: blindReviewTasks.promptIndex,
      })
      .from(blindReviewTasks)
      .innerJoin(marketplaceListings, eq(blindReviewTasks.listingId, marketplaceListings.id))
      .where(and(
        eq(blindReviewTasks.status, "pooled"),
        sql`${blindReviewTasks.reviewerId} IS NULL`,
        eq(marketplaceListings.status, "certifying"),
        ne(marketplaceListings.creatorId, reviewerId),
        sql`NOT EXISTS (
          SELECT 1 FROM blind_review_tasks mine
          WHERE mine.listing_id = ${blindReviewTasks.listingId}
            AND mine.reviewer_id = ${reviewerId}
            AND mine.status = 'assigned'
        )`,
        // Never the same (listing, prompt) twice: with multiple pooled copies
        // per prompt, without this a reviewer could claim a second copy of a
        // prompt they already reviewed and double-count it toward quorum.
        sql`NOT EXISTS (
          SELECT 1 FROM blind_review_tasks done
          WHERE done.listing_id = ${blindReviewTasks.listingId}
            AND done.prompt_index = ${blindReviewTasks.promptIndex}
            AND done.reviewer_id = ${reviewerId}
            AND done.status = 'completed'
        )`,
        // Per-reviewer-per-listing cap (2026-07-28 beta finding): without it,
        // reviewers kept drawing the same listing past the quorum requirement
        // (beta: 25–43 reviews/listing instead of ~15), delaying certification
        // and wasting reviewer effort. Cap = the per-reviewer quota.
        sql`(SELECT COUNT(*) FROM blind_review_tasks capped
             WHERE capped.listing_id = ${blindReviewTasks.listingId}
               AND capped.reviewer_id = ${reviewerId}
               AND capped.status = 'completed') < ${MIN_REVIEWS_PER_REVIEWER}`,
      ))
      // Fair ordering (2026-07-28 beta finding): lowest-id-first let one
      // listing monopolize the pool and starve every other certifying
      // listing. Random order spreads reviewers across listings.
      .orderBy(sql`RAND()`)
      .limit(1);

    if (!candidate) return null;

    // Atomic claim: only succeeds if the row is still pooled & unassigned.
    await getDb()
      .update(blindReviewTasks)
      .set({ reviewerId, status: "assigned", assignedAt: new Date() })
      .where(and(
        eq(blindReviewTasks.id, candidate.id),
        eq(blindReviewTasks.status, "pooled"),
        sql`${blindReviewTasks.reviewerId} IS NULL`,
      ));

    // Re-check: did WE win the claim?
    const [won] = await getDb()
      .select({ reviewerId: blindReviewTasks.reviewerId, status: blindReviewTasks.status })
      .from(blindReviewTasks)
      .where(eq(blindReviewTasks.id, candidate.id))
      .limit(1);

    if (!won || won.reviewerId !== reviewerId || won.status !== "assigned") {
      continue; // lost the race to another reviewer — try the next candidate
    }

    // Fetch the test I/O for the blind payload (listingId stays server-side).
    const [prompt] = await getDb()
      .select({ inputText: testPrompts.inputText, actualOutput: testPrompts.actualOutput })
      .from(testPrompts)
      .where(and(
        eq(testPrompts.listingId, candidate.listingId),
        eq(testPrompts.promptIndex, candidate.promptIndex),
      ))
      .limit(1);

    if (!prompt) {
      // Data inconsistency — release the claim rather than strand the task.
      await getDb()
        .update(blindReviewTasks)
        .set({ reviewerId: null, status: "pooled", assignedAt: null })
        .where(eq(blindReviewTasks.id, candidate.id));
      continue;
    }

    logger.info("marketplace.blindpool.claim", { taskId: candidate.id, reviewerId });
    return toBlindTaskPayload(candidate.id, prompt.inputText, prompt.actualOutput);
  }

  return null; // repeated contention — caller can retry
}

/**
 * Submit a blind review for a claimed task (spec 0.5.4) and run the
 * certification aggregation (spec 0.5.5). Shared by the tRPC procedure and
 * the MCP tool so both paths behave identically.
 */
export async function submitBlindTaskReview(
  reviewerId: number,
  taskId: number,
  scores: BlindReviewScores,
): Promise<{ message: string; weightedScore: number; pointsAwarded: number; listingOutcome: "published" | "rejected" | "certifying" }> {
  const [task] = await getDb()
    .select()
    .from(blindReviewTasks)
    .where(eq(blindReviewTasks.id, taskId))
    .limit(1);

  if (!task) throw new Error("Review task not found");
  if (task.reviewerId !== reviewerId || task.status !== "assigned") {
    throw new Error("This review task is not assigned to you or is already closed");
  }

  const [listing] = await getDb()
    .select({ id: marketplaceListings.id, creatorId: marketplaceListings.creatorId, status: marketplaceListings.status })
    .from(marketplaceListings)
    .where(eq(marketplaceListings.id, task.listingId))
    .limit(1);

  if (!listing) throw new Error("Listing not found");
  // Defense in depth: the self-review ban is enforced at claim time; re-check here.
  if (listing.creatorId === reviewerId) {
    throw new Error("Pipeline designers cannot review their own pipeline");
  }

  const weightedScore = calculateWeightedScore(scores);

  await getDb().insert(listingReviews).values({
    listingId: task.listingId,
    reviewerId,
    promptIndex: task.promptIndex,
    accuracy: scores.accuracy,
    completeness: scores.completeness,
    clarity: scores.clarity,
    tokenEfficiency: scores.tokenEfficiency,
    speed: scores.speed,
    consistency: scores.consistency,
    weightedScore: String(weightedScore.toFixed(2)),
    reviewTime: scores.reviewTime,
  });

  await getDb()
    .update(blindReviewTasks)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(blindReviewTasks.id, taskId));

  // Reviewer points/trust — matches the existing submitReview points logic.
  const BASE_POINTS_PER_PROMPT = 10;
  const COMPLETION_BONUS = 50; // all 10 prompts of a listing by this reviewer

  await getDb()
    .update(reviewerProfiles)
    .set({
      reviewsCompleted: sql`reviews_completed + 1`,
      pointsEarned: sql`points_earned + ${BASE_POINTS_PER_PROMPT}`,
      pointsBalance: sql`points_balance + ${BASE_POINTS_PER_PROMPT}`,
    })
    .where(eq(reviewerProfiles.userId, reviewerId));

  let pointsAwarded = BASE_POINTS_PER_PROMPT;

  const thisListingReviews = await getDb()
    .select({ count: count() })
    .from(listingReviews)
    .where(and(
      eq(listingReviews.listingId, task.listingId),
      eq(listingReviews.reviewerId, reviewerId),
    ));

  if (thisListingReviews[0]?.count === 10) {
    await getDb()
      .update(reviewerProfiles)
      .set({
        pointsEarned: sql`points_earned + ${COMPLETION_BONUS}`,
        pointsBalance: sql`points_balance + ${COMPLETION_BONUS}`,
      })
      .where(eq(reviewerProfiles.userId, reviewerId));
    pointsAwarded += COMPLETION_BONUS;
  }

  // ─── Aggregation & certification (spec 0.5.5) ─────────────────────
  // Same policy as the legacy submitReview anchor: MIN_REVIEWERS distinct
  // reviewers × MIN_REVIEWS_PER_REVIEWER reviews each; the designer's own
  // reviews never count when MIN_REVIEWERS > 1.
  const allReviewsRaw = await getDb()
    .select()
    .from(listingReviews)
    .where(eq(listingReviews.listingId, task.listingId));
  const allReviews = MIN_UNIQUE_REVIEWERS > 1
    ? allReviewsRaw.filter((r) => r.reviewerId !== listing.creatorId)
    : allReviewsRaw;

  const perReviewer = new Map<number, number>();
  for (const r of allReviews) {
    perReviewer.set(r.reviewerId, (perReviewer.get(r.reviewerId) ?? 0) + 1);
  }
  const qualifiedReviewers = [...perReviewer.values()].filter((n) => n >= MIN_REVIEWS_PER_REVIEWER).length;
  const hasQuorum = qualifiedReviewers >= MIN_UNIQUE_REVIEWERS;

  let listingOutcome: "published" | "rejected" | "certifying" = "certifying";

  if (hasQuorum) {
    const avgScore = allReviews.reduce((sum, r) => sum + parseFloat(String(r.weightedScore)), 0) / allReviews.length;
    const passRatio =
      allReviews.filter((r) => parseFloat(String(r.weightedScore)) >= CERTIFY_MIN_AVG_SCORE).length / allReviews.length;

    const prompts = await getDb()
      .select()
      .from(testPrompts)
      .where(eq(testPrompts.listingId, task.listingId));

    const ratings: number[][] = [];
    for (const prompt of prompts) {
      const promptReviews = allReviews.filter((r) => r.promptIndex === prompt.promptIndex);
      if (promptReviews.length >= 1) {
        ratings.push(promptReviews.map((r) => bucketForKappa(parseFloat(String(r.weightedScore)))));
      }
    }

    let kappaScore = 0;
    if (ratings.length > 0) {
      const { kappa } = calculateFleissKappa(ratings, KAPPA_BUCKET_CATEGORIES);
      kappaScore = kappa;
    }

    const decision = decideCertification(avgScore, passRatio);
    listingOutcome = decision;

    if (decision === "published") {
      await setLegacyListingStatus(task.listingId, {
        grade: String(avgScore.toFixed(2)),
        reviewCount: allReviews.length,
        kappaScore: String(kappaScore.toFixed(3)),
        status: "published",
        certifiedAt: new Date(),
      });
    } else {
      await setLegacyListingStatus(task.listingId, {
        grade: String(avgScore.toFixed(2)),
        reviewCount: allReviews.length,
        kappaScore: String(kappaScore.toFixed(3)),
        status: "rejected",
        aiFeedback: `Certification failed after blind human review: weighted average ${avgScore.toFixed(2)} (need ≥ ${CERTIFY_MIN_AVG_SCORE}), pass ratio ${(passRatio * 100).toFixed(0)}% (need ≥ ${CERTIFY_MIN_PASS_RATIO * 100}%). Revise the pipeline and resubmit.`,
      });
    }

    // Outcome logging for calibration (spec 0.8).
    logger.info("marketplace.certify.outcome", {
      listingId: task.listingId,
      outcome: decision,
      avgScore: Number(avgScore.toFixed(2)),
      passRatio: Number(passRatio.toFixed(3)),
      kappaScore: Number(kappaScore.toFixed(3)),
      reviewCount: allReviews.length,
      uniqueReviewers: perReviewer.size,
      qualifiedReviewers,
    });
  }
  // No quorum → stays `certifying` (fail-closed, spec 0.5.5).

  return {
    message: `Review submitted! +${pointsAwarded} pts`,
    weightedScore: Number(weightedScore.toFixed(2)),
    pointsAwarded,
    listingOutcome,
  };
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
      // test prompts → doubled blind-review pool, stale scan input).
      await getDb().delete(blindReviewTasks).where(eq(blindReviewTasks.listingId, input.id));
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
      // 0.3.4). The old user-key AI ensemble prerequisite
      // (checkAiReviewProviders, 3 distinct providers) is retired: AI judging
      // now runs on the platform triage model and never gates buyability.
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

          // ─── Step 3 (spec 0.3): AI triage — platform model, NON-gating ──
          // Runs on env-configured platform credentials (never the creator's
          // keys), sees test I/O only (never encryptedPrompts), and can ONLY
          // reject below the floor — it must NEVER set `published`.
          // Unconfigured / flag off / error → triage is skipped and the
          // listing still reaches `certifying` (fail-closed = not-buyable).
          let triage: { score: number; feedback: string } | null = null;
          const triageFlagOn = await isFeatureEnabled("marketplace_ai_triage", ctx.user.id);
          if (triageFlagOn && isAiTriageConfigured()) {
            try {
              triage = await runAiTriage(input.id);
            } catch (triageErr) {
              logger.error("marketplace.triage.error", { listingId: input.id, error: (triageErr as Error).message });
              triage = null; // non-gating: errors skip triage
            }
          }

          if (triage && triage.score < AI_TRIAGE_FLOOR) {
            await setLegacyListingStatus(input.id, {
              status: "rejected",
              aiGrade: String(triage.score.toFixed(2)),
              aiFeedback: triage.feedback,
              aiReviewedAt: new Date(),
            });
            logger.info("marketplace.triage.rejected", { listingId: input.id, score: triage.score, floor: AI_TRIAGE_FLOOR });
            return;
          }

          // ─── Step 4 (spec 0.1/0.5): enter `certifying` — VISIBLE, NOT buyable ──
          await setLegacyListingStatus(input.id, {
            status: "certifying",
            ...(triage
              ? {
                  aiGrade: String(triage.score.toFixed(2)),
                  aiFeedback: triage.feedback,
                  aiReviewedAt: new Date(),
                }
              : {}),
          });

          // Enqueue this listing's prompts into the blind review pool —
          // UNASSIGNED (pooled); reviewers claim one prompt at a time.
          await enqueueBlindReviewTasks(input.id);
          logger.info("marketplace.certifying", { listingId: input.id, triageScore: triage?.score ?? null });
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
      if (listing.status !== "approved") throw new Error("Listing must be approved before publishing");

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
  // Reviewers keep their earned points. Only removes the listing.
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
      await getDb().delete(listingReviews)
        .where(eq(listingReviews.listingId, input.id));
      await getDb().delete(reviewAssignments)
        .where(eq(reviewAssignments.listingId, input.id));
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

  // ── Creator: Get review progress ───────────────────────────────
  reviewProgress: authedQuery
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

      const completedReviews = await getDb()
        .select({ count: count() })
        .from(listingReviews)
        .where(eq(listingReviews.listingId, input.listingId));

      const assignments = await getDb()
        .select()
        .from(reviewAssignments)
        .where(eq(reviewAssignments.listingId, input.listingId));

      return {
        status: listing.status,
        totalPrompts: totalPrompts[0]?.count ?? 0,
        completedReviews: completedReviews[0]?.count ?? 0,
        assignments: assignments.map((a) => ({
          reviewerId: a.reviewerId,
          status: a.status,
          assignedAt: a.assignedAt,
          dueAt: a.dueAt,
        })),
        grade: listing.grade,
        kappaScore: listing.kappaScore,
      };
    }),

  // ── Creator: Get review stats (for Calculate Grade gating) ─────
  getReviewStats: authedQuery
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

      // How many test prompts exist
      const totalPrompts = await getDb()
        .select({ count: count() })
        .from(testPrompts)
        .where(eq(testPrompts.listingId, input.listingId));

      // How many review assignments exist
      const totalAssignments = await getDb()
        .select({ count: count() })
        .from(reviewAssignments)
        .where(eq(reviewAssignments.listingId, input.listingId));

      // How many individual reviews have been submitted
      const completedReviews = await getDb()
        .select({ count: count() })
        .from(listingReviews)
        .where(eq(listingReviews.listingId, input.listingId));

      // How many unique reviewers have submitted at least one review
      // In production (MIN_REVIEWERS>=2), the designer's own reviews never count.
      // In beta (MIN_REVIEWERS=1), allow self-review so creators can test the flow.
      const reviewFilters = [
        eq(listingReviews.listingId, input.listingId),
      ];
      if (MIN_UNIQUE_REVIEWERS > 1) {
        reviewFilters.push(ne(listingReviews.reviewerId, listing.creatorId));
      }
      const uniqueReviewers = await getDb()
        .select({ reviewerId: listingReviews.reviewerId })
        .from(listingReviews)
        .where(and(...reviewFilters))
        .groupBy(listingReviews.reviewerId);

      const promptCount = totalPrompts[0]?.count ?? 0;
      const reviewCount = completedReviews[0]?.count ?? 0;
      const reviewerCount = uniqueReviewers.length;
      const assignmentCount = totalAssignments[0]?.count ?? 0;

      // Phase 1 certification rule: 5 distinct reviewers, 3+ reviews each
      const minReviewsNeeded = MIN_TOTAL_REVIEWS;
      const minReviewersNeeded = MIN_UNIQUE_REVIEWERS;
      const canCalculateGrade = reviewerCount >= minReviewersNeeded && reviewCount >= minReviewsNeeded;

      return {
        status: listing.status,
        totalPrompts: promptCount,
        totalAssignments: assignmentCount,
        completedReviews: reviewCount,
        uniqueReviewers: reviewerCount,
        minReviewsNeeded,
        minReviewersNeeded,
        canCalculateGrade,
        message: canCalculateGrade
          ? "Ready to calculate grade"
          : reviewerCount < minReviewersNeeded
            ? `Waiting for review reports: ${reviewerCount} of ${minReviewersNeeded} reviewers submitted (need ${minReviewersNeeded} reviewers minimum)`
            : `Waiting for review reports: ${reviewCount} of ${minReviewsNeeded} reviews submitted (${reviewerCount} reviewers active)`,
      };
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
        message = "Test data ready. Certification in progress — your pipeline is visible in the marketplace and awaiting blind human review. It cannot be purchased until certified.";
      } else if (listing.status === "published") {
        message = "Certified and published — your pipeline is live and buyable.";
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

  // ── Reviewer: Get intermediate pipeline responses for a test prompt ─
  // Reviewers can see step-by-step traces to better evaluate pipeline quality
  getIntermediateForReviewer: authedQuery
    .input(z.object({ testPromptId: z.number() }))
    .query(async ({ input, ctx }) => {
      // Verify the reviewer has an assignment for this listing
      const [tp] = await getDb()
        .select()
        .from(testPrompts)
        .where(eq(testPrompts.id, input.testPromptId));

      if (!tp) throw new Error("Test prompt not found");

      const [assignment] = await getDb()
        .select()
        .from(reviewAssignments)
        .where(and(
          eq(reviewAssignments.listingId, tp.listingId),
          eq(reviewAssignments.reviewerId, ctx.user.id),
        ));

      if (!assignment) throw new Error("Not assigned to review this listing");

      const intermediates = await getDb()
        .select()
        .from(testPromptIntermediate)
        .where(eq(testPromptIntermediate.testPromptId, input.testPromptId))
        .orderBy(testPromptIntermediate.stepIndex);

      return intermediates;
    }),

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

  // ── Reviewer: Get my assignments ───────────────────────────────
  myAssignments: authedQuery.query(async ({ ctx }) => {
    const assignments = await getDb()
      .select({
        id: reviewAssignments.id,
        listingId: reviewAssignments.listingId,
        status: reviewAssignments.status,
        assignedAt: reviewAssignments.assignedAt,
        dueAt: reviewAssignments.dueAt,
        title: marketplaceListings.title,
        category: marketplaceListings.category,
      })
      .from(reviewAssignments)
      .innerJoin(marketplaceListings, eq(reviewAssignments.listingId, marketplaceListings.id))
      .where(eq(reviewAssignments.reviewerId, ctx.user.id))
      .orderBy(desc(reviewAssignments.assignedAt));

    return assignments;
  }),

  // ── Reviewer: Get prompts for an assignment ────────────────────
  getAssignmentPrompts: authedQuery
    .input(z.object({ listingId: z.number() }))
    .query(async ({ input, ctx }) => {
      // Verify reviewer has assignment
      const [assignment] = await getDb()
        .select()
        .from(reviewAssignments)
        .where(and(
          eq(reviewAssignments.listingId, input.listingId),
          eq(reviewAssignments.reviewerId, ctx.user.id),
        ));

      if (!assignment) throw new Error("No assignment found for this listing");

      // Get all test prompts
      const prompts = await getDb()
        .select()
        .from(testPrompts)
        .where(eq(testPrompts.listingId, input.listingId))
        .orderBy(testPrompts.promptIndex);

      // Check which prompts this reviewer has already reviewed
      const existingReviews = await getDb()
        .select({ promptIndex: listingReviews.promptIndex })
        .from(listingReviews)
        .where(and(
          eq(listingReviews.listingId, input.listingId),
          eq(listingReviews.reviewerId, ctx.user.id),
        ));

      const reviewedIndices = new Set(existingReviews.map((r) => r.promptIndex));

      return prompts.map((p) => ({
        ...p,
        reviewed: reviewedIndices.has(p.promptIndex),
      }));
    }),

  // ── Reviewer: Submit a review ──────────────────────────────────
  submitReview: authedQuery
    .input(
      z.object({
        listingId: z.number(),
        promptIndex: z.number(),
        accuracy: z.number().min(1).max(5),
        completeness: z.number().min(1).max(5),
        clarity: z.number().min(1).max(5),
        tokenEfficiency: z.number().min(1).max(5),
        speed: z.number().min(1).max(5),
        consistency: z.number().min(1).max(5),
        reviewTime: z.number().min(1), // seconds
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // ─── Guards (Phase 1 certification rules) ─────────────────────
      // 1. The pipeline designer can never review their own pipeline.
      // 2. Only assigned reviewers may submit (previously unchecked —
      //    any authenticated user could review any listing).
      const [listingForReview] = await getDb()
        .select({ creatorId: marketplaceListings.creatorId })
        .from(marketplaceListings)
        .where(eq(marketplaceListings.id, input.listingId));
      if (!listingForReview) throw new Error("Listing not found");
      if (listingForReview.creatorId === ctx.user.id) {
        throw new Error("Pipeline designers cannot review their own pipeline");
      }
      const [assignment] = await getDb()
        .select({ id: reviewAssignments.id })
        .from(reviewAssignments)
        .where(and(
          eq(reviewAssignments.listingId, input.listingId),
          eq(reviewAssignments.reviewerId, ctx.user.id),
        ))
        .limit(1);
      if (!assignment) throw new Error("Not assigned to review this listing");

      const weightedScore = calculateWeightedScore({
        accuracy: input.accuracy,
        completeness: input.completeness,
        clarity: input.clarity,
        tokenEfficiency: input.tokenEfficiency,
        speed: input.speed,
        consistency: input.consistency,
      });

      await getDb().insert(listingReviews).values({
        listingId: input.listingId,
        reviewerId: ctx.user.id,
        promptIndex: input.promptIndex,
        accuracy: input.accuracy,
        completeness: input.completeness,
        clarity: input.clarity,
        tokenEfficiency: input.tokenEfficiency,
        speed: input.speed,
        consistency: input.consistency,
        weightedScore: String(weightedScore.toFixed(2)),
        reviewTime: input.reviewTime,
      });

      // Transition listing to "reviewing" on first review (so creator sees progress)
      const [listing] = await getDb()
        .select({ status: marketplaceListings.status })
        .from(marketplaceListings)
        .where(eq(marketplaceListings.id, input.listingId));

      if (listing?.status === "pending_review") {
        await setLegacyListingStatus(input.listingId, { status: "reviewing" });
      }

      // Check how many prompts this reviewer has now reviewed
      const reviewerReviewCount = await getDb()
        .select({ count: count() })
        .from(listingReviews)
        .where(and(
          eq(listingReviews.listingId, input.listingId),
          eq(listingReviews.reviewerId, ctx.user.id),
        ));

      const totalPromptsForListing = await getDb()
        .select({ count: count() })
        .from(testPrompts)
        .where(eq(testPrompts.listingId, input.listingId));

      const promptsReviewed = reviewerReviewCount[0]?.count ?? 0;
      const totalPrompts = totalPromptsForListing[0]?.count ?? 0;
      const allDone = promptsReviewed >= totalPrompts && totalPrompts > 0;

      // Update assignment status: in_progress until all prompts reviewed, then completed
      await getDb()
        .update(reviewAssignments)
        .set({
          status: allDone ? "completed" : "in_progress",
          completedAt: allDone ? new Date() : undefined,
        })
        .where(and(
          eq(reviewAssignments.listingId, input.listingId),
          eq(reviewAssignments.reviewerId, ctx.user.id),
        ));

      // Award points: 10 per prompt reviewed
      const BASE_POINTS_PER_PROMPT = 10;
      const COMPLETION_BONUS = 50; // for completing all 10 prompts of a listing

      await getDb()
        .update(reviewerProfiles)
        .set({
          reviewsCompleted: sql`reviews_completed + 1`,
          pointsEarned: sql`points_earned + ${BASE_POINTS_PER_PROMPT}`,
          pointsBalance: sql`points_balance + ${BASE_POINTS_PER_PROMPT}`,
        })
        .where(eq(reviewerProfiles.userId, ctx.user.id));

      let pointsAwarded = BASE_POINTS_PER_PROMPT;
      let bonusAwarded = 0;

      // Check if this reviewer has now reviewed ALL 10 prompts for this listing
      const thisListingReviews = await getDb()
        .select({ count: count() })
        .from(listingReviews)
        .where(and(
          eq(listingReviews.listingId, input.listingId),
          eq(listingReviews.reviewerId, ctx.user.id),
        ));

      if (thisListingReviews[0]?.count === 10) {
        // Award completion bonus
        await getDb()
          .update(reviewerProfiles)
          .set({
            pointsEarned: sql`points_earned + ${COMPLETION_BONUS}`,
            pointsBalance: sql`points_balance + ${COMPLETION_BONUS}`,
          })
          .where(eq(reviewerProfiles.userId, ctx.user.id));
        bonusAwarded = COMPLETION_BONUS;
        pointsAwarded += COMPLETION_BONUS;
      }

      // ─── Auto-calculate grade when all assignments are completed ──
      if (allDone) {
        // Check if ALL assignments for this listing are now completed
        const assignmentStatuses = await getDb()
          .select({ status: reviewAssignments.status })
          .from(reviewAssignments)
          .where(eq(reviewAssignments.listingId, input.listingId));

        const allAssignmentsCompleted = assignmentStatuses.length > 0 &&
          assignmentStatuses.every((a) => a.status === "completed");

        if (allAssignmentsCompleted) {
          logger.info("submitReview all assignments completed, auto-calculating grade", { listingId: input.listingId });

          // Get all reviews for this listing.
          // In production (MIN_REVIEWERS>=2), exclude the designer's own reviews.
          // In beta (MIN_REVIEWERS=1), allow self-review so creators can test.
          const allReviewsRaw = await getDb()
            .select()
            .from(listingReviews)
            .where(eq(listingReviews.listingId, input.listingId));
          const allReviews = MIN_UNIQUE_REVIEWERS > 1
            ? allReviewsRaw.filter((r) => r.reviewerId !== listingForReview.creatorId)
            : allReviewsRaw;

          const uniqueReviewers = new Set(allReviews.map((r) => r.reviewerId)).size;

          if (allReviews.length >= MIN_TOTAL_REVIEWS && uniqueReviewers >= MIN_UNIQUE_REVIEWERS) {
            const avgScore = allReviews.reduce((sum, r) => sum + parseFloat(String(r.weightedScore)), 0) / allReviews.length;

            // Calculate Kappa
            const prompts = await getDb()
              .select()
              .from(testPrompts)
              .where(eq(testPrompts.listingId, input.listingId));

            const ratings: number[][] = [];
            for (const prompt of prompts) {
              const promptReviews = allReviews.filter((r) => r.promptIndex === prompt.promptIndex);
              if (promptReviews.length >= 1) {
                ratings.push(promptReviews.map((r) => bucketForKappa(parseFloat(String(r.weightedScore)))));
              }
            }

            let kappaScore = 0;
            if (ratings.length > 0) {
              const { kappa } = calculateFleissKappa(ratings, KAPPA_BUCKET_CATEGORIES);
              kappaScore = kappa;
            }

            const passRatio =
              allReviews.filter((r) => parseFloat(String(r.weightedScore)) >= CERTIFY_MIN_AVG_SCORE).length / allReviews.length;
            const newStatus = avgScore >= CERTIFY_MIN_AVG_SCORE && passRatio >= CERTIFY_MIN_PASS_RATIO ? "approved" : "rejected";

            await setLegacyListingStatus(input.listingId, {
              grade: String(avgScore.toFixed(2)),
              reviewCount: allReviews.length,
              kappaScore: String(kappaScore.toFixed(3)),
              status: newStatus,
            });

            // Auto-publish approved listings
            if (newStatus === "approved") {
              await setLegacyListingStatus(input.listingId, { status: "published" });
              logger.info("submitReview auto-publish", { listingId: input.listingId });
            }

            logger.info("submitReview auto-grade", { avgScore: avgScore.toFixed(2), kappa: kappaScore.toFixed(3), newStatus });
          }
        }
      }

      return {
        message: bonusAwarded > 0
          ? `Review submitted! +${BASE_POINTS_PER_PROMPT} pts. Completion bonus +${COMPLETION_BONUS} pts!`
          : `Review submitted! +${BASE_POINTS_PER_PROMPT} pts`,
        weightedScore: Number(weightedScore.toFixed(2)),
        pointsAwarded,
        totalEarned: (thisListingReviews[0]?.count ?? 0) * BASE_POINTS_PER_PROMPT + bonusAwarded,
      };
    }),

  // ── Reviewer: Pull the next blind review task (spec 0.5.3) ───────
  // Claims ONE pooled task atomically. Returns ONLY { taskId, inputText,
  // actualOutput, rubric } — no listing id, title, creator, or category.
  getNextReviewTask: authedQuery.mutation(async ({ ctx }) => {
    const task = await claimNextBlindTask(ctx.user.id);
    if (!task) {
      return { task: null, message: "No review tasks available right now. Check back later." };
    }
    return { task };
  }),

  // ── Reviewer: Submit a blind review task (spec 0.5.4/0.5.5) ──────
  // Validates ownership, writes the per-prompt listingReviews row, marks the
  // task completed, updates reviewer points, and runs the certification
  // aggregation (published/rejected/stays certifying when no quorum).
  submitReviewTask: authedQuery
    .input(
      z.object({
        taskId: z.number(),
        accuracy: z.number().min(1).max(5),
        completeness: z.number().min(1).max(5),
        clarity: z.number().min(1).max(5),
        tokenEfficiency: z.number().min(1).max(5),
        speed: z.number().min(1).max(5),
        consistency: z.number().min(1).max(5),
        reviewTime: z.number().min(1), // seconds
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { taskId, ...scores } = input;
      return submitBlindTaskReview(ctx.user.id, taskId, scores);
    }),

  // ── Reviewer: Get my profile ───────────────────────────────────
  myReviewerProfile: authedQuery.query(async ({ ctx }) => {
    const [profile] = await getDb()
      .select()
      .from(reviewerProfiles)
      .where(eq(reviewerProfiles.userId, ctx.user.id));

    return profile ?? null;
  }),

  // ── Reviewer: Enroll ───────────────────────────────────────────
  enrollReviewer: authedQuery.mutation(async ({ ctx }) => {
    const [existing] = await getDb()
      .select()
      .from(reviewerProfiles)
      .where(eq(reviewerProfiles.userId, ctx.user.id));

    if (existing) throw new Error("Already enrolled as reviewer");

    await getDb().insert(reviewerProfiles).values({
      userId: ctx.user.id,
      trustScore: 100,
      reviewsCompleted: 0,
      reviewsFlagged: 0,
      arbiterRulingsAgainst: 0,
      pointsEarned: 0,
      pointsBalance: 0,
      subscriptionDays: 0,
      isActive: true,
      status: "active",
    });

    // Auto-assign to all pending_review listings
    const pendingListings = await getDb()
      .select({ id: marketplaceListings.id })
      .from(marketplaceListings)
      .where(eq(marketplaceListings.status, "pending_review"));

    let assignmentsCreated = 0;
    for (const listing of pendingListings) {
      // Avoid duplicates
      const [dup] = await getDb()
        .select()
        .from(reviewAssignments)
        .where(and(
          eq(reviewAssignments.listingId, listing.id),
          eq(reviewAssignments.reviewerId, ctx.user.id),
        ))
        .limit(1);

      if (!dup) {
        await getDb().insert(reviewAssignments).values({
          listingId: listing.id,
          reviewerId: ctx.user.id,
          status: "pending",
          dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
        assignmentsCreated++;
      }
    }

    return {
      message: `Enrolled as reviewer. ${assignmentsCreated} assignment(s) ready for review.`,
      assignmentsCreated,
    };
  }),

  // ── Admin: Calculate final grade ───────────────────────────────
  calculateGrade: authedQuery
    .input(z.object({ listingId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      // Only creator can trigger (or admin)
      const [listing] = await getDb()
        .select()
        .from(marketplaceListings)
        .where(eq(marketplaceListings.id, input.listingId));

      if (!listing) throw new Error("Listing not found");
      if (listing.creatorId !== ctx.user.id && ctx.user.role !== "admin") {
        throw new Error("Unauthorized");
      }

      // Get all human reviews.
      // In production (MIN_REVIEWERS>=2), the designer's own reviews never count.
      // In beta (MIN_REVIEWERS=1), allow self-review so creators can test.
      const reviewsRaw = await getDb()
        .select()
        .from(listingReviews)
        .where(eq(listingReviews.listingId, input.listingId));
      const reviews = MIN_UNIQUE_REVIEWERS > 1
        ? reviewsRaw.filter((r) => r.reviewerId !== listing.creatorId)
        : reviewsRaw;

      const uniqueReviewers = new Set(reviews.map((r) => r.reviewerId)).size;
      if (reviews.length < MIN_TOTAL_REVIEWS || uniqueReviewers < MIN_UNIQUE_REVIEWERS) {
        throw new Error(
          `Waiting for review reports: ${reviews.length} review(s) submitted by ${uniqueReviewers} reviewer(s). ` +
          `Certification requires at least ${MIN_UNIQUE_REVIEWERS} distinct reviewers with ${MIN_REVIEWS_PER_REVIEWER}+ reviews each ` +
          `(${MIN_TOTAL_REVIEWS} reviews total) before a grade can be calculated.`
        );
      }

      // Calculate average weighted score
      const avgScore = reviews.reduce((sum, r) => sum + parseFloat(String(r.weightedScore)), 0) / reviews.length;

      // Calculate Kappa (simplified: use accuracy dimension)
      const prompts = await getDb()
        .select()
        .from(testPrompts)
        .where(eq(testPrompts.listingId, input.listingId));

      const ratings: number[][] = [];
      for (const prompt of prompts) {
        const promptReviews = reviews.filter((r) => r.promptIndex === prompt.promptIndex);
        // MVP: 1 reviewer minimum (was >= 2 for multi-reviewer)
        if (promptReviews.length >= 1) {
          ratings.push(promptReviews.map((r) => bucketForKappa(parseFloat(String(r.weightedScore)))));
        }
      }

      let kappaScore = 0;
      if (ratings.length > 0) {
        const { kappa } = calculateFleissKappa(ratings, KAPPA_BUCKET_CATEGORIES);
        kappaScore = kappa;
      }

      const passRatio =
        reviews.filter((r) => parseFloat(String(r.weightedScore)) >= CERTIFY_MIN_AVG_SCORE).length / reviews.length;
      const status = avgScore >= CERTIFY_MIN_AVG_SCORE && passRatio >= CERTIFY_MIN_PASS_RATIO ? "approved" : "rejected";

      await setLegacyListingStatus(input.listingId, {
        grade: String(avgScore.toFixed(2)),
        reviewCount: reviews.length,
        kappaScore: String(kappaScore.toFixed(3)),
        status,
      });

      // Update assignment statuses
      await getDb()
        .update(reviewAssignments)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(reviewAssignments.listingId, input.listingId));

      return {
        grade: Number(avgScore.toFixed(2)),
        kappaScore: Number(kappaScore.toFixed(3)),
        reviewCount: reviews.length,
        status,
      };
    }),

  // ── Reviewer: Redeem points for subscription days ──────────────
  // MVP: Points → subscription days stored in reviewer profile
  // Master tier: 72 pts/day, Sage tier: 120 pts/day
  redeemPoints: authedQuery
    .input(
      z.object({
        tier: z.enum(["master", "sage"]),
        days: z.number().min(1).max(30),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [profile] = await getDb()
        .select()
        .from(reviewerProfiles)
        .where(eq(reviewerProfiles.userId, ctx.user.id));

      if (!profile) throw new Error("Not enrolled as reviewer");

      const COST_PER_DAY = input.tier === "sage" ? 120 : 72;
      const totalCost = COST_PER_DAY * input.days;

      if ((profile.pointsBalance ?? 0) < totalCost) {
        throw new Error(
          `Need ${totalCost} points for ${input.days} day(s) of ${input.tier}. ` +
          `You have ${profile.pointsBalance ?? 0} points.`,
        );
      }

      // Deduct points, add subscription days
      await getDb()
        .update(reviewerProfiles)
        .set({
          pointsBalance: sql`points_balance - ${totalCost}`,
          subscriptionDays: sql`subscription_days + ${input.days}`,
        })
        .where(eq(reviewerProfiles.userId, ctx.user.id));

      // Phase 1: payout is a data-driven entitlement grant (capability
      // tier:<tier>, N days) instead of a user-row mutation. The legacy
      // subscriptionDays counter above stays as an audit trail.
      const expiresAt = new Date(Date.now() + input.days * 24 * 60 * 60 * 1000);
      await entitlementGrant({
        subjectType: "user",
        subjectId: ctx.user.id,
        capability: `tier:${input.tier}`,
        source: "manual",
        sourceRef: `reviewer-points:${ctx.user.id}:${Date.now()}`,
        expiresAt,
      });

      return {
        message: `Redeemed ${totalCost} points for ${input.days} day(s) of ${input.tier} tier!`,
        pointsSpent: totalCost,
        pointsRemaining: (profile.pointsBalance ?? 0) - totalCost,
        daysGranted: input.days,
        tier: input.tier,
      };
    }),

  // ── Public: Get reviewer leaderboard ───────────────────────────
  reviewerLeaderboard: publicQuery.query(async () => {
    const topReviewers = await getDb()
      .select({
        userId: reviewerProfiles.userId,
        trustScore: reviewerProfiles.trustScore,
        reviewsCompleted: reviewerProfiles.reviewsCompleted,
        pointsEarned: reviewerProfiles.pointsEarned,
        subscriptionDays: reviewerProfiles.subscriptionDays,
        name: sql<string>`(SELECT name FROM users WHERE users.id = ${reviewerProfiles.userId})`,
      })
      .from(reviewerProfiles)
      .where(eq(reviewerProfiles.isActive, true))
      .orderBy(desc(reviewerProfiles.pointsEarned))
      .limit(20);

    return topReviewers;
  }),
});
