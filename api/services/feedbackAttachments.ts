// ═══════════════════════════════════════════════════════════════════════════
// CONSENTED FEEDBACK ATTACHMENTS (D11, ticket #22)
// ═══════════════════════════════════════════════════════════════════════════
//
// WHAT THIS IS. Reporting a problem with a specific pipeline, run or benchmark
// is close to useless if support can only read the description of the symptom,
// so the feedback form can attach THAT object. The owner's decision is that this
// is CONSENTED and PER ITEM: nothing is harvested automatically, ticking one
// item attaches that item and only that item, and the row keeps which consent
// text the user agreed to (`DEFAULT_CONSENT_VERSION`, stamped here — a client
// never supplies it and so can never claim an older or an invented one). A
// missing consent is a refusal, not a default.
//
// WHY THIS MODULE SELECTS NOTHING BY HAND (spec A12). An attachment is stored as
// a frozen snapshot, and a snapshot of the wrong thing would be the single
// easiest leak ever built into this app: the whole point of a feedback
// attachment is to carry prompt text to a different reader. So there is exactly
// one rule here, and it is structural rather than a list of fields to remember —
// every snapshot is the output of a projection the CONSENTING ACCOUNT CAN
// ALREADY READ:
//
//   pipeline   `pipelineSharing.getSharedWorkflow` — the owner's own definition
//              read, which for a `run_only` grantee returns step IDENTITY only
//              and says what was withheld.
//   run        `runAccess.projectRunDetail` for a run nobody else's workflow is
//              inside (the same projection `export.exportRun` answers with), and
//              `pipelineSharing.getSharedRunView` /
//              `marketplaceExecutionService.getProtectedRunView` for a
//              `run_only` share or a marketplace buyer run.
//   benchmark  `benchmarkService.getBenchmarkProgress` — the owner's own status
//              read, whose shape (not the frozen plan's case texts) is what a
//              poll already returns.
//
// A user may legitimately attach a run they RAN even when the workflow belongs
// to someone else, so the redaction cannot be "only the owner may attach": it
// has to be "the attachment carries what this caller can already see, and
// nothing more". That is what these five functions guarantee, and it is why this
// file contains no `select()` against `agentRuns`, `agentResponses` or
// `pipelineSteps` at all. The protection decision is never re-derived here
// either: it is read from `runAccess.isProtectedRun` / `sharedRunOf` /
// `withholdsModel`, the single place spec §8.1 states it.
//
// OWNERSHIP AND EXISTENCE. Every refusal is the same shape the rest of the
// codebase uses — `not_found_or_not_authorized` via `runAccess.NotVisibleError`
// or the sharing service's own error — so guessing an id teaches an attacker
// nothing about whether the object exists.
//
// NO PLAN GATE, NO GROUPS. The tier ladder and the team feature were deleted
// (ticket #26); nothing here consults `tier`/`plan` and there is no group,
// workspace or org concept. An attachment is between one account and support.

import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  benchmarks, feedback, feedbackAttachments, pipelineShares, projects, swarmRuns,
} from "@db/schema";
import { getDb } from "../queries/connection";

/** A transaction, when the caller opens one: a feedback row and its consent
 *  receipts are written together or not at all. Only `insert` is needed, which
 *  is what lets a `MySqlTransaction` and the plain pool stand in for each
 *  other here — drizzle's full database type also demands `$client`. */
type DbLike = Pick<ReturnType<typeof getDb>, "insert">;
import { logger } from "../lib/logger";
import { DEFAULT_CONSENT_VERSION, scanForSecrets } from "./evidenceService";
import {
  NotVisibleError, assertRunVisible, isProtectedRun, projectRunDetail, sharedRunOf,
} from "./runAccess";
import { getSharedRunView, getSharedWorkflow } from "./pipelineSharing";
import { getProtectedRunView } from "./marketplaceExecutionService";
import { getBenchmarkProgress } from "./benchmark/benchmarkService";

/** The three objects this product actually has. */
export const ATTACHMENT_KINDS = ["pipeline", "run", "benchmark"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** How many objects one feedback item may carry. A bound, not a tier: support
 *  reads a handful of attachments, and an unbounded list is a way to make the
 *  feedback table a document store. */
export const MAX_ATTACHMENTS_PER_FEEDBACK = 5;

/** The one wording for the cap, shared by the input schema and the service so a
 *  caller cannot get two different answers from two different layers (#38). */
export const TOO_MANY_ATTACHMENTS_MESSAGE =
  `too_many_attachments: a feedback item may carry at most ${MAX_ATTACHMENTS_PER_FEEDBACK} attachments — each one is a separate opt-in, not an export`;

export class FeedbackAttachmentError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.name = "FeedbackAttachmentError";
  }
}

/** The one input shape, shared by the tRPC router and the MCP tool so the two
 *  surfaces cannot drift into two different consent rules. */
export const attachmentInputSchema = z.object({
  kind: z.enum(ATTACHMENT_KINDS).describe("what is being attached: a pipeline, a run of one, or a benchmark"),
  refId: z.number().int().positive().describe("the object's own id (projects.id / swarm_runs.id / benchmarks.id)"),
  consent: z.boolean().describe(
    "the author's explicit opt-in for THIS item only. Nothing is attached without it, and it is not a global setting: each attachment is ticked on its own object.",
  ),
});
export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

/** Which entitlement the stored snapshot reflects, recorded IN the snapshot so a
 *  later reader can never mistake a redacted attachment for a full one. */
export type AttachmentVisibility =
  | "owner_full"
  | "redacted_run_only_share"
  | "redacted_protected_marketplace_run";

export interface BuiltAttachment {
  kind: AttachmentKind;
  refId: number;
  consentVersion: string;
  visibility: AttachmentVisibility;
  /** A short human label, so the support list can name the object without
   *  parsing the snapshot. */
  title: string;
  /** The stored (serialized) snapshot. */
  snapshot: string;
  /** Parsed form, for the caller that is about to return it. */
  detail: Record<string, unknown>;
}

// ─── Snapshot size ───────────────────────────────────────────────────
// A run's prompts and outputs are the thing support needs, and they are also
// the thing that can fill a row. Every string is capped, which only ever makes
// text SHORTER: a cap cannot introduce another account's content, and a
// truncated field says so in place.
const MAX_STRING_CHARS = 6_000;

function capStrings<T>(value: T): T {
  if (typeof value === "string") {
    return (value.length > MAX_STRING_CHARS
      ? `${value.slice(0, MAX_STRING_CHARS)}…[truncated in the feedback snapshot]`
      : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => capStrings(v)) as unknown as T;
  // A Date has no enumerable own properties, so the generic object branch below
  // would rebuild it as `{}` and silently destroy every timestamp in the
  // snapshot — `startedAt`, `completedAt` and each step's `createdAt` are the
  // first things support asks for, and the author did consent to sending them.
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = capStrings(v);
    return out as unknown as T;
  }
  return value;
}

// ─── Building one snapshot ───────────────────────────────────────────

/** A PIPELINE: a project and its steps. `getSharedWorkflow` is the read the
 *  caller already has — it returns the real definition to the owner and to a
 *  `full` grantee, and step IDENTITY plus a stated `withheld` notice to a
 *  `run_only` grantee. An account with no grant gets `not_found_or_not_authorized`
 *  out of that same function, so existence is not probed here either. */
async function buildPipelineSnapshot(userId: number, projectId: number): Promise<BuiltAttachment> {
  const view = await getSharedWorkflow(userId, { projectId });
  const redacted = view.access === "run_only";
  return finalize({
    kind: "pipeline",
    refId: projectId,
    visibility: redacted ? "redacted_run_only_share" : "owner_full",
    title: `${view.projectName || "pipeline"} (pipeline ${projectId})`,
    detail: {
      projectId: view.projectId,
      projectName: view.projectName,
      // Whose pipeline this is stays recorded: a share is a loan, and an
      // attachment about a borrowed pipeline must not read like a claim of
      // ownership. `projects.user_id` and the lineage pointer are untouched.
      definitionOwnerId: view.ownerId,
      originCreatorId: view.originCreatorId,
      accessGrantedToCaller: view.access,
      canModify: view.canModify,
      stepCount: view.steps.length,
      steps: view.steps,
      withheld: view.withheld,
    },
  });
}

/** A RUN. Visible to whoever ran it (`assertRunVisible`: the run's own user or
 *  the owner of the project it ran in) — which deliberately INCLUDES a
 *  `run_only` grantee and a marketplace buyer, because attaching the run they
 *  paid for is exactly the case this feature exists for. What decides the
 *  content is `isProtectedRun`, and for a protected run the snapshot is the
 *  recipient's OWN projection, prompt columns never selected at all. */
async function buildRunSnapshot(userId: number, swarmRunId: number): Promise<BuiltAttachment> {
  const db = getDb();
  const [run] = await db.select().from(swarmRuns).where(eq(swarmRuns.id, swarmRunId)).limit(1);
  if (!run) throw new NotVisibleError("run");
  await assertRunVisible(userId, swarmRunId);

  if (isProtectedRun(run)) {
    const share = sharedRunOf(run);
    if (share) {
      const view = await getSharedRunView({ userId, swarmRunId });
      if (!view) throw new NotVisibleError("run");
      return finalize({
        kind: "run",
        refId: swarmRunId,
        visibility: "redacted_run_only_share",
        title: `run ${swarmRunId} of “${view.projectName}” (shared pipeline)`,
        // The recipient's own explanation of what is withheld travels with the
        // snapshot (renamed, so it cannot stand in for the marker field), and
        // the projection itself selected no prompt column at all.
        detail: { source: "pipelineSharing.getSharedRunView", recipientVisibilityNote: view.visibility, ...view },
      });
    }
    const view = await getProtectedRunView({ buyerId: userId, swarmRunId });
    if (!view) throw new NotVisibleError("run");
    return finalize({
      kind: "run",
      refId: swarmRunId,
      visibility: "redacted_protected_marketplace_run",
      title: `protected marketplace run ${swarmRunId} (listing ${view.listingId})`,
      detail: { source: "marketplaceExecutionService.getProtectedRunView", ...view },
    });
  }

  // An ordinary run of the caller's own workflow: the real detail, through the
  // ONE projection that means "the whole run" (prompts, steps, responses).
  const detail = await projectRunDetail(run);
  const [project] = await db.select({ id: projects.id, name: projects.name })
    .from(projects).where(eq(projects.id, run.projectId)).limit(1);
  return finalize({
    kind: "run",
    refId: swarmRunId,
    visibility: "owner_full",
    title: `run ${swarmRunId} of “${project?.name ?? "pipeline"}”`,
    detail: {
      source: "runAccess.projectRunDetail",
      swarmRunId: run.id,
      projectName: project?.name ?? null,
      status: run.status,
      currentStep: run.currentStep,
      pipelineVersion: run.pipelineVersion,
      userPrompt: run.userPrompt,
      isTestRun: run.isTestRun ?? false,
      totalTokensUsed: run.totalTokensUsed ?? null,
      totalLatencyMs: run.totalLatencyMs ?? null,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      error: run.error ?? null,
      stepCount: detail.steps.length,
      steps: detail.steps,
      responseCount: detail.responses.length,
      responses: detail.responses.map((r) => ({
        id: r.id,
        agentRunId: r.agentRunId,
        responseType: r.responseType,
        content: r.content,
        // The step's model/provider/token figures live in this metadata blob on
        // an ordinary run row, so they ride along with the row the owner can
        // already read. A run that must not disclose them never reaches this
        // branch: `isProtectedRun` sent it to the recipient projection above.
        metadata: r.metadata,
        humanNotes: r.humanNotes ?? null,
        isFlagged: r.isFlagged ?? false,
        createdAt: r.createdAt,
      })),
    },
  });
}

/** A BENCHMARK: owner-only, and the snapshot is the STATUS view an owner polls —
 *  state, run counts, the descriptive summary, plan SHAPE and cost. Not the
 *  frozen plan's case texts: those are the user's own inputs, but support needs
 *  to know what was measured, and re-sending every case is how a feedback table
 *  turns into a second benchmark store. */
async function buildBenchmarkSnapshot(userId: number, benchmarkId: number): Promise<BuiltAttachment> {
  const view = await getBenchmarkProgress({ userId, benchmarkId });
  if (!view) throw new NotVisibleError("benchmark");
  return finalize({
    kind: "benchmark",
    refId: benchmarkId,
    visibility: "owner_full",
    title: `benchmark ${benchmarkId} (${view.executionMode}, ${view.state})`,
    detail: { source: "benchmarkService.getBenchmarkProgress", ...view },
  });
}

function finalize(args: {
  kind: AttachmentKind; refId: number; visibility: AttachmentVisibility; title: string;
  detail: Record<string, unknown>;
}): BuiltAttachment {
  // The marker fields go LAST, not first: `getSharedRunView` has a `visibility`
  // of its own (prose, for the recipient), and the snapshot's own record of
  // WHICH entitlement produced it must not be overwritten by borrowed text.
  const detail = capStrings({
    ...args.detail,
    kind: args.kind,
    visibility: args.visibility,
    title: args.title,
  });
  const snapshot = JSON.stringify(detail);
  // The last bar, and the one this module cannot know the shape of in advance:
  // a credential-shaped string in a snapshot is never useful to support and is
  // always somebody's secret. Named by category, never echoed back.
  const findings = scanForSecrets(snapshot);
  if (findings.length > 0) {
    throw new FeedbackAttachmentError(
      "attachment_credential_refused",
      `the snapshot of this ${args.kind} contains something credential-shaped (${[...new Set(findings)].join(", ")}), so nothing was attached. Remove the credential from the object and attach it again — never send a key to support.`,
    );
  }
  return {
    kind: args.kind,
    refId: args.refId,
    consentVersion: DEFAULT_CONSENT_VERSION,
    visibility: args.visibility,
    title: args.title,
    snapshot,
    detail,
  };
}

// ─── The consent gate, applied to the whole batch before anything is written ─

/** Validate every item and build every snapshot. NOTHING IS WRITTEN HERE, which
 *  is what lets the caller submit feedback and attachments as one decision: a
 *  refusal on item three leaves no half-attached receipt for items one and two,
 *  and no feedback row at all. */
export async function prepareConsentedAttachments(
  userId: number, items: AttachmentInput[],
): Promise<BuiltAttachment[]> {
  if (items.length === 0) return [];
  if (items.length > MAX_ATTACHMENTS_PER_FEEDBACK) {
    throw new FeedbackAttachmentError(
      "too_many_attachments",
      `a feedback item may carry at most ${MAX_ATTACHMENTS_PER_FEEDBACK} attachments — each one is a separate opt-in, not an export`,
    );
  }
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.kind}:${item.refId}`;
    if (seen.has(key)) {
      throw new FeedbackAttachmentError("duplicate_attachment", `${key} was attached twice — tick it once`);
    }
    seen.add(key);
    // The refusal is per item and unconditional: an absent or unticked consent
    // is not "consent by default", it is no attachment.
    if (item.consent !== true) {
      throw new FeedbackAttachmentError(
        "consent_required",
        `nothing can be attached without the author opting in on that one item (${item.kind} ${item.refId}) — this is not a setting and nothing is harvested automatically`,
      );
    }
  }
  const built: BuiltAttachment[] = [];
  for (const item of items) {
    if (item.kind === "pipeline") built.push(await buildPipelineSnapshot(userId, item.refId));
    else if (item.kind === "run") built.push(await buildRunSnapshot(userId, item.refId));
    else built.push(await buildBenchmarkSnapshot(userId, item.refId));
  }
  return built;
}

export function attachmentReceiptRows(userId: number, feedbackId: number, built: BuiltAttachment[]) {
  return built.map((b) => ({
    feedbackId,
    userId,
    kind: b.kind,
    refId: b.refId,
    consentVersion: b.consentVersion,
    snapshot: b.snapshot,
    createdAt: new Date(),
  }));
}

export interface AttachmentReceipt {
  id: number;
  kind: AttachmentKind;
  refId: number;
  consentVersion: string;
  visibility: AttachmentVisibility;
  title: string;
  createdAt: Date | null;
}

function receipt(row: typeof feedbackAttachments.$inferSelect, detail: Record<string, unknown>): AttachmentReceipt {
  return {
    id: row.id,
    kind: row.kind,
    refId: row.refId,
    consentVersion: row.consentVersion,
    visibility: (detail.visibility as AttachmentVisibility) ?? "owner_full",
    title: typeof detail.title === "string" ? detail.title : `${row.kind} ${row.refId}`,
    createdAt: row.createdAt ?? null,
  };
}

/** The summary the support list shows: what was attached, by whom, under which
 *  consent, and whether it is a redacted view — WITHOUT the payload. Reading a
 *  snapshot is an explicit second call (`feedbackAttachmentDetail`), so a
 *  list screen does not pull every attached prompt across the wire by
 *  accident. */
export interface AttachmentSummary {
  id: number;
  feedbackId: number;
  kind: AttachmentKind;
  refId: number;
  consentVersion: string;
  visibility: AttachmentVisibility;
  title: string;
  createdAt: Date | null;
}

function summaryOf(row: typeof feedbackAttachments.$inferSelect): AttachmentSummary {
  const detail = parseSnapshot(row.snapshot);
  return {
    id: row.id,
    feedbackId: row.feedbackId,
    kind: row.kind,
    refId: row.refId,
    consentVersion: row.consentVersion,
    visibility: (detail.visibility as AttachmentVisibility) ?? "owner_full",
    title: typeof detail.title === "string" ? detail.title : `${row.kind} ${row.refId}`,
    createdAt: row.createdAt ?? null,
  };
}

export function parseSnapshot(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    // A snapshot that no longer parses is reported, not handed over as bytes
    // and not silently rendered as "no attachments".
    return { unparsable: true };
  }
}

/** Summaries for a page of feedback rows, in one grouped read. Deliberately not
 *  a correlated JSON subquery: the payload can be 6 kB per row and a list
 *  screen has no business pulling it. */
export async function summarizeAttachments(feedbackIds: number[]): Promise<Map<number, AttachmentSummary[]>> {
  const byFeedback = new Map<number, AttachmentSummary[]>();
  if (feedbackIds.length === 0) return byFeedback;
  const rows = await getDb().select().from(feedbackAttachments)
    .where(inArray(feedbackAttachments.feedbackId, feedbackIds))
    .orderBy(feedbackAttachments.id);
  for (const row of rows) {
    const list = byFeedback.get(row.feedbackId) ?? [];
    list.push(summaryOf(row));
    byFeedback.set(row.feedbackId, list);
  }
  return byFeedback;
}

/** Write the prepared rows and return the receipts. Takes the caller's
 *  transaction when there is one, so a feedback row and its receipts are
 *  written atomically — see `submitFeedbackWithAttachments`. */
export async function createConsentedAttachments(
  userId: number, feedbackId: number, built: BuiltAttachment[],
  executor: DbLike = getDb(),
): Promise<AttachmentReceipt[]> {
  if (built.length === 0) return [];
  const out: AttachmentReceipt[] = [];
  for (const item of built) {
    const row = attachmentReceiptRows(userId, feedbackId, [item])[0];
    const [inserted] = await executor.insert(feedbackAttachments).values(row);
    out.push({
      id: Number((inserted as { insertId: number }).insertId),
      kind: item.kind,
      refId: item.refId,
      consentVersion: item.consentVersion,
      visibility: item.visibility,
      title: item.title,
      // The same instant written into `created_at`, so the receipt the caller
      // gets back matches the row without a second read.
      createdAt: row.createdAt,
    });
  }
  logger.info("feedback attachments consented", {
    feedbackId, userId, count: out.length,
    kinds: out.map((a) => `${a.kind}:${a.refId}`),
    redacted: out.filter((a) => a.visibility !== "owner_full").length,
  });
  return out;
}

/** One feedback row plus its attachments, for its AUTHOR. The author always
 *  reads their own consented copies; anyone else gets the same
 *  not-found-shaped refusal the rest of the codebase uses. */
export async function listOwnAttachments(userId: number, feedbackId: number): Promise<{
  feedbackId: number;
  attachments: Array<AttachmentReceipt & { snapshot: Record<string, unknown> }>;
}> {
  const db = getDb();
  const [fb] = await db.select({ id: feedback.id, userId: feedback.userId })
    .from(feedback).where(eq(feedback.id, feedbackId)).limit(1);
  if (!fb || fb.userId !== userId) throw new NotVisibleError("feedback");
  const rows = await db.select().from(feedbackAttachments)
    .where(eq(feedbackAttachments.feedbackId, feedbackId))
    .orderBy(feedbackAttachments.id);
  return {
    feedbackId,
    attachments: rows.map((row) => ({
      ...receipt(row, parseSnapshot(row.snapshot)),
      snapshot: parseSnapshot(row.snapshot),
    })),
  };
}

/** Support-side read of ONE attachment, payload included. Admin-gated at the
 *  router (`adminQuery`), and this function does not widen what is stored: it
 *  returns the snapshot exactly as the consenting author's own entitlement
 *  produced it. */
export async function readAttachmentForSupport(attachmentId: number): Promise<AttachmentSummary & {
  snapshot: Record<string, unknown>;
}> {
  const [row] = await getDb().select().from(feedbackAttachments)
    .where(eq(feedbackAttachments.id, attachmentId)).limit(1);
  if (!row) throw new NotVisibleError("attachment");
  return { ...summaryOf(row), snapshot: parseSnapshot(row.snapshot) };
}

// ─── The submit path both surfaces share ─────────────────────────────

export const feedbackSubmitInputSchema = z.object({
  projectId: z.number().int().positive().optional(),
  targetType: z.enum(["message", "ui", "general"]).default("general"),
  targetMessageId: z.number().int().positive().optional(),
  feedbackType: z.enum(["bug", "suggestion", "praise", "confusion"]),
  severity: z.enum(["critical", "major", "minor", "cosmetic"]).default("minor"),
  content: z.string().min(1).max(5000),
  screenshotUrl: z.string().optional(),
  context: z.object({
    url: z.string().optional(),
    browser: z.string().optional(),
    os: z.string().optional(),
    consoleLogs: z.array(z.string()).optional(),
    activePipeline: z.string().optional(),
    activeStep: z.string().optional(),
    modelUsed: z.string().optional(),
    tokenCount: z.number().optional(),
    latencyMs: z.number().optional(),
  }).optional(),
  tags: z.array(z.string()).optional(),
  /** D11: the per-item opt-ins. Nothing is collected when this is absent, and
   *  one unticked or unseen item refuses the whole submission rather than
   *  writing a half-attached receipt. The bound is stated here AND in the
   *  service, and carries the service's own message verbatim: an input schema
   *  that answers first with "too_big" would make `too_many_attachments` — the
   *  refusal the guide and the tests cite, and the only one that explains that
   *  each item is a separate opt-in — unreachable from this surface (#38). */
  attachments: z.array(attachmentInputSchema)
    .max(MAX_ATTACHMENTS_PER_FEEDBACK, TOO_MANY_ATTACHMENTS_MESSAGE)
    .optional(),
});
export type FeedbackSubmitInput = z.infer<typeof feedbackSubmitInputSchema>;

/**
 * One submit path for the form and the workbench. The order is the contract:
 * every attachment is validated and its snapshot built FIRST, so a refusal —
 * missing consent, an object the caller cannot see, a credential in the text —
 * leaves no feedback row behind, and nothing is ever snapshotted without the
 * consent line having been read.
 */
export async function submitFeedbackWithAttachments(
  userId: number, input: FeedbackSubmitInput,
): Promise<{ id: number; success: true; attachments: AttachmentReceipt[] }> {
  const prepared = await prepareConsentedAttachments(userId, input.attachments ?? []);
  const db = getDb();
  let id = 0;
  let attachments: AttachmentReceipt[] = [];
  // One transaction, because a receipt that names a feedback row which failed
  // to exist — or a feedback row whose author's opt-ins only half-written — is
  // a consent record nobody can trust. The snapshots are all built above,
  // outside this, so no provider or file read happens while the lock is held.
  await db.transaction(async (tx) => {
    // The team auto-detect arm is gone with ticket #26: `feedback.team_id`
    // stays a nullable column (historical rows keep their value) but new
    // submissions are attributed to the project and the submitting account.
    const [result] = await tx.insert(feedback).values({
      teamId: null,
      projectId: input.projectId || null,
      userId,
      targetType: input.targetType,
      targetMessageId: input.targetMessageId || null,
      feedbackType: input.feedbackType,
      severity: input.severity,
      content: input.content,
      screenshotUrl: input.screenshotUrl || null,
      contextJson: input.context || null,
      tagsJson: input.tags || null,
      status: "new",
    });
    id = Number((result as { insertId: number }).insertId);
    attachments = await createConsentedAttachments(userId, id, prepared, tx);
  });
  return { id, success: true, attachments };
}

// ─── What the caller may attach ──────────────────────────────────────
// The picker is a read of the caller's OWN objects (plus the pipelines someone
// named them on), because "attach THAT run" has to be answerable without asking
// the user to remember an id. It returns labels only, never content: the
// snapshot is built at submit time by the projection functions above, so this
// list cannot become a side door around them.

export interface AttachableObjects {
  consentVersion: string;
  maxPerFeedback: number;
  pipelines: Array<{ refId: number; kind: AttachmentKind; title: string; owned: boolean }>;
  runs: Array<{ refId: number; kind: AttachmentKind; title: string; status: string; startedAt: Date | null }>;
  benchmarks: Array<{ refId: number; kind: AttachmentKind; title: string; state: string }>;
}

export async function attachableObjectsFor(userId: number, projectId?: number): Promise<AttachableObjects> {
  const db = getDb();

  const owned = await db.select({ id: projects.id, name: projects.name }).from(projects)
    .where(and(eq(projects.userId, userId), projectId ? eq(projects.id, projectId) : undefined))
    .orderBy(desc(projects.id)).limit(10);
  // A pipeline shared with this account is attachable too — they may have a bug
  // to report about the run of it they made — and the snapshot for a `run_only`
  // grant comes back redacted from `getSharedWorkflow`, as it must.
  const sharedRows = await db.select({
    projectId: pipelineShares.projectId, projectName: projects.name,
  }).from(pipelineShares)
    .innerJoin(projects, eq(pipelineShares.projectId, projects.id))
    .where(and(
      eq(pipelineShares.granteeId, userId), eq(pipelineShares.state, "active"),
      projectId ? eq(pipelineShares.projectId, projectId) : undefined,
    ))
    .orderBy(desc(pipelineShares.id)).limit(10);
  const ownedIds = new Set(owned.map((p) => p.id));

  const runs = await db.select({
    id: swarmRuns.id, status: swarmRuns.status, startedAt: swarmRuns.startedAt,
    prompt: swarmRuns.userPrompt, projectName: projects.name,
  }).from(swarmRuns)
    .leftJoin(projects, eq(swarmRuns.projectId, projects.id))
    .where(and(eq(swarmRuns.userId, userId), projectId ? eq(swarmRuns.projectId, projectId) : undefined))
    .orderBy(desc(swarmRuns.id)).limit(10);

  const benchRows = await db.select({
    id: benchmarks.id, state: benchmarks.state, executionMode: benchmarks.executionMode,
    createdAt: benchmarks.createdAt,
  }).from(benchmarks).where(eq(benchmarks.ownerId, userId))
    .orderBy(desc(benchmarks.id)).limit(10);

  return {
    consentVersion: DEFAULT_CONSENT_VERSION,
    maxPerFeedback: MAX_ATTACHMENTS_PER_FEEDBACK,
    pipelines: [
      ...owned.map((p) => ({ refId: p.id, kind: "pipeline" as const, title: p.name, owned: true })),
      ...sharedRows.filter((s) => !ownedIds.has(s.projectId))
        .map((s) => ({ refId: s.projectId, kind: "pipeline" as const, title: s.projectName ?? "", owned: false })),
    ],
    runs: runs.map((r) => ({
      refId: r.id, kind: "run" as const, status: r.status, startedAt: r.startedAt ?? null,
      // A label, not a transcript: the first line of what they typed, so a
      // picker with ten runs is readable. Content only ever enters a snapshot
      // through the projection functions above.
      title: `${r.projectName ?? "run"} — ${(r.prompt ?? "").replace(/\s+/g, " ").slice(0, 80)}`,
    })),
    benchmarks: benchRows.map((b) => ({
      refId: b.id, kind: "benchmark" as const, state: b.state,
      title: `benchmark ${b.id} (${b.executionMode})`,
    })),
  };
}
