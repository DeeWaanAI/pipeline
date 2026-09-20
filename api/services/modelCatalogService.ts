// Model release awareness (offering redesign v2, spec §12.1; acceptance A19).
//
// A shared, versioned catalog plus admin-reviewed release events, turned into
// DEDUPLICATED, DISMISSIBLE SUGGESTIONS. The rules that shape this module:
// - a user's `llmProviders.models` cache is not a release history, and a
//   successor is never guessed from a name substring — lineage is an explicit
//   column the reviewer fills in;
// - a suggestion is information only. It starts no paid run, never changes the
//   model a seller chose, and there is no mandatory retest interval (§12.1);
// - notice uniqueness is (seller, workflow version, release event, channel), so
//   re-running relevance for the same event cannot spam a seller;
// - dismissal is respected; snooze defers, it does not delete;
// - email stays off: no delivery integration has been confirmed, so `in_app` is
//   the only channel this module will ever write.

import { and, desc, eq, gt, isNull, lt, ne, or } from "drizzle-orm";
import {
  evidencePublications, modelCatalog, modelReleaseEvents, notifications, retestSuggestions, users,
} from "@db/schema";
import { getDb } from "../queries/connection";
import { logger } from "../lib/logger";
import { PublicEvidenceManifestSchema } from "../../contracts/offeringV2";

export const MODEL_CATALOG_POLICY_VERSION = "v2-p3-catalog-1";
/** The only channel this module delivers on. §12.1: email is optional until a
 *  real delivery integration is confirmed — none is, so nothing writes one. */
export const SUPPORTED_NOTICE_CHANNELS = ["in_app"] as const;
export type SupportedNoticeChannel = (typeof SUPPORTED_NOTICE_CHANNELS)[number];

export class CatalogAuthorizationError extends Error {
  constructor() {
    super("not_found_or_not_authorized: the model catalog is written by admins only (§12.1)");
    this.name = "CatalogAuthorizationError";
  }
}

async function assertAdmin(userId: number): Promise<void> {
  const db = getDb();
  const [actor] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (actor?.role !== "admin") throw new CatalogAuthorizationError();
}

/**
 * Record or refresh a catalog entry. Idempotent on (provider, modelId): a
 * re-record updates the REVIEWED metadata (family, lineage, dates, source) and
 * never creates a duplicate, because the unique index is the contract.
 */
export async function recordCatalogModel(actorId: number, entry: {
  provider: string;
  modelId: string;
  family?: string | null;
  successorOfModelId?: string | null;
  sourceUrl?: string | null;
  availableAt?: Date | null;
  deprecatedAt?: Date | null;
}): Promise<{ catalogId: number; created: boolean }> {
  await assertAdmin(actorId);
  const db = getDb();
  const provider = entry.provider.trim().toLowerCase();
  const modelId = entry.modelId.trim();
  if (!provider || !modelId) throw new Error("invalid_catalog_entry: provider and modelId are required");
  if (entry.successorOfModelId) {
    const [predecessor] = await db.select({ id: modelCatalog.id, provider: modelCatalog.provider })
      .from(modelCatalog).where(eq(modelCatalog.modelId, entry.successorOfModelId.trim())).limit(1);
    // Lineage must point at a real catalog row. A name-derived guess is exactly
    // what §12.1 forbids, so an unknown predecessor is an error, not a null.
    if (!predecessor) throw new Error("unknown_predecessor: successorOfModelId must already be in the catalog");
    if (predecessor.provider !== provider) throw new Error("cross_provider_lineage: a successor must name a model from the same provider");
  }

  const [existing] = await db.select({ id: modelCatalog.id, availableAt: modelCatalog.availableAt }).from(modelCatalog)
    .where(and(eq(modelCatalog.provider, provider), eq(modelCatalog.modelId, modelId))).limit(1);
  const fields = {
    family: entry.family?.trim() || null,
    successorOfModelId: entry.successorOfModelId?.trim() || null,
    availabilitySource: "admin_reviewed" as const,
    sourceUrl: entry.sourceUrl?.trim() || null,
    availableAt: entry.availableAt ?? existing?.availableAt ?? null,
    deprecatedAt: entry.deprecatedAt ?? null,
    verifiedAt: new Date(),
  };
  if (existing) {
    await db.update(modelCatalog).set(fields).where(eq(modelCatalog.id, existing.id));
    return { catalogId: existing.id, created: false };
  }
  const [res] = await db.insert(modelCatalog).values({ provider, modelId, ...fields });
  return { catalogId: Number((res as { insertId: number }).insertId), created: true };
}

/**
 * Record an admin-reviewed release event and fan it out as deduplicated
 * suggestions. `eventKey` is the source's own identity, so replaying the same
 * review is a no-op rather than a second wave of notices.
 */
export async function recordReleaseEvent(actorId: number, event: {
  modelCatalogId: number;
  eventKey: string;
  relevanceRule?: "same_model" | "same_family" | "successor_of";
}): Promise<{ releaseEventId: number; created: boolean; suggestionsCreated: number; sellersNotified: number }> {
  await assertAdmin(actorId);
  const db = getDb();
  const [model] = await db.select().from(modelCatalog).where(eq(modelCatalog.id, event.modelCatalogId)).limit(1);
  if (!model) throw new Error("catalog_entry_not_found");
  const eventKey = event.eventKey.trim();
  if (!eventKey) throw new Error("eventKey is required — it is what makes replay harmless");

  const [existingEvent] = await db.select({ id: modelReleaseEvents.id })
    .from(modelReleaseEvents).where(eq(modelReleaseEvents.eventKey, eventKey)).limit(1);
  if (existingEvent) {
    return { releaseEventId: existingEvent.id, created: false, suggestionsCreated: 0, sellersNotified: 0 };
  }
  const [res] = await db.insert(modelReleaseEvents).values({
    modelCatalogId: model.id, eventKey, recordedBy: actorId, relevanceRule: event.relevanceRule ?? "same_model",
  });
  const releaseEventId = Number((res as { insertId: number }).insertId);
  const fanout = await generateSuggestionsForEvent(releaseEventId, event.relevanceRule ?? "same_model");
  logger.info("model release event recorded", { releaseEventId, provider: model.provider, modelId: model.modelId, ...fanout });
  return { releaseEventId, created: true, ...fanout };
}

/** Which published evidence a release event is relevant to.
 *  Reads the stored manifests — the same bytes a buyer sees — so a suggestion
 *  can never be generated about a model no public test actually used.
 *  Exported because this predicate is the whole of §12.1's relevance claim: it
 *  compares reviewed catalog identity, never a name substring. */
export function manifestMatches(
  models: Array<{ provider: string; requestedModel: string; returnedModel: string | null }>,
  target: { provider: string; modelId: string; family: string | null; successorOfModelId?: string | null },
  rule: "same_model" | "same_family" | "successor_of",
): boolean {
  for (const m of models) {
    if (m.provider.toLowerCase() !== target.provider) continue;
    const seen = [m.requestedModel, m.returnedModel].filter(Boolean) as string[];
    if (rule === "same_model" && seen.includes(target.modelId)) return true;
    if (rule === "successor_of" && target.successorOfModelId && seen.includes(target.successorOfModelId)) return true;
    // same_family compares the REVIEWED family of the catalogued model against
    // the tested model ids — never a substring of the name.
    if (rule === "same_family" && target.family && seen.some((s) => s === target.family || s.startsWith(`${target.family}:`))) return true;
  }
  return false;
}

interface CandidatePublication { id: number; sellerId: number; listingId: number; versionId: number; models: Array<{ provider: string; requestedModel: string; returnedModel: string | null }> }

/** Page through currently-published seller manifests without loading them all
 *  into memory. No silent cap: a page limit is a batch size, not a scope. */
async function publishedEvidenceByModel(): Promise<CandidatePublication[]> {
  const db = getDb();
  const out: CandidatePublication[] = [];
  const pageSize = 100;
  let cursor = 0;
  for (;;) {
    const rows = await db.select({
      id: evidencePublications.id, sellerId: evidencePublications.authorId,
      listingId: evidencePublications.listingId, versionId: evidencePublications.listingWorkflowVersionId,
      manifest: evidencePublications.publicManifest,
    }).from(evidencePublications)
      .where(and(eq(evidencePublications.state, "published"), eq(evidencePublications.publicationKind, "seller"), gt(evidencePublications.id, cursor)))
      .orderBy(evidencePublications.id)
      .limit(pageSize);
    if (!rows.length) break;
    for (const row of rows) {
      cursor = Math.max(cursor, row.id);
      // A suggestion is addressed to (seller, version) on a listing; without
      // both there is nothing to notify about, and the unique index would not
      // dedupe it either.
      if (!row.listingId || !row.versionId) continue;
      const parsed = PublicEvidenceManifestSchema.safeParse(JSON.parse(String(row.manifest)));
      if (!parsed.success) {
        logger.error("published manifest no longer parses during release fan-out", { publicationId: row.id });
        continue;
      }
      out.push({
        id: row.id, sellerId: row.sellerId, listingId: row.listingId, versionId: row.versionId,
        models: parsed.data.testedModels.map((m) => ({ provider: m.provider.toLowerCase(), requestedModel: m.requestedModel, returnedModel: m.returnedModel })),
      });
    }
    if (rows.length < pageSize) break;
  }
  return out;
}

/**
 * Create suggestions for one release event. Uniqueness is enforced by the
 * (seller, version, event, channel) index, so this is safe to call again after
 * a failure and after a re-verification of the same model.
 */
export async function generateSuggestionsForEvent(
  releaseEventId: number,
  rule: "same_model" | "same_family" | "successor_of",
): Promise<{ suggestionsCreated: number; sellersNotified: number }> {
  const db = getDb();
  const [event] = await db.select().from(modelReleaseEvents).where(eq(modelReleaseEvents.id, releaseEventId)).limit(1);
  if (!event) throw new Error("release_event_not_found");
  const [model] = await db.select().from(modelCatalog).where(eq(modelCatalog.id, event.modelCatalogId)).limit(1);
  if (!model) throw new Error("catalog_entry_not_found");

  const relevant = (await publishedEvidenceByModel()).filter((p) => manifestMatches(p.models, model, rule));
  let suggestionsCreated = 0;
  const notifiedSellers = new Set<number>();

  for (const publication of relevant) {
    for (const channel of SUPPORTED_NOTICE_CHANNELS) {
      // INSERT IGNORE rather than read-then-insert: two events landing at once
      // must not both consider the row absent.
      const [res] = await db.insert(retestSuggestions).ignore().values({
        sellerId: publication.sellerId, listingId: publication.listingId, workflowVersionId: publication.versionId,
        releaseEventId, channel, state: "pending",
      });
      const createdRows = Number((res as { affectedRows?: number }).affectedRows ?? 0);
      if (!createdRows) continue;
      suggestionsCreated += 1;
      await db.insert(notifications).values({
        userId: publication.sellerId,
        type: "model_retest_suggestion",
        title: `New model in your tested category: ${model.modelId}`,
        message: "This is a suggestion only. Nothing was re-run and no money was spent; your published evidence, its scores and its test date are unchanged.",
        dataJson: { releaseEventId, modelCatalogId: model.id, publicationId: publication.id, workflowVersionId: publication.versionId, channel },
      });
      notifiedSellers.add(publication.sellerId);
    }
  }
  return { suggestionsCreated, sellersNotified: notifiedSellers.size };
}

/** What a seller sees. Snoozed items reappear after their date; dismissed ones
 *  never do — dismissal is respected, not argued with. */
export async function listRetestSuggestions(sellerId: number, opts: { includeDismissed?: boolean } = {}) {
  const db = getDb();
  const rows = await db.select({
    id: retestSuggestions.id,
    workflowVersionId: retestSuggestions.workflowVersionId,
    releaseEventId: retestSuggestions.releaseEventId,
    channel: retestSuggestions.channel,
    state: retestSuggestions.state,
    snoozedUntil: retestSuggestions.snoozedUntil,
    createdAt: retestSuggestions.createdAt,
    modelId: modelCatalog.modelId,
    provider: modelCatalog.provider,
    family: modelCatalog.family,
    successorOfModelId: modelCatalog.successorOfModelId,
    availableAt: modelCatalog.availableAt,
    eventKey: modelReleaseEvents.eventKey,
  }).from(retestSuggestions)
    .innerJoin(modelReleaseEvents, eq(retestSuggestions.releaseEventId, modelReleaseEvents.id))
    .innerJoin(modelCatalog, eq(modelReleaseEvents.modelCatalogId, modelCatalog.id))
    .where(and(
      eq(retestSuggestions.sellerId, sellerId),
      opts.includeDismissed ? undefined : ne(retestSuggestions.state, "dismissed"),
      // snoozed items are hidden until their date passes
      or(isNull(retestSuggestions.snoozedUntil), lt(retestSuggestions.snoozedUntil, new Date())),
    ))
    .orderBy(desc(retestSuggestions.id))
    .limit(100);

  return rows.map((r) => ({
    ...r,
    note: "Acting on this starts a NEW benchmark you approve and pay for. Nothing here has run yet.",
  }));
}

export async function respondToSuggestion(sellerId: number, suggestionId: number, action: "dismiss" | "snooze" | "plan_retest", opts?: { until?: Date }): Promise<{ ok: boolean; state: string; startedWork: false }> {
  const db = getDb();
  const [row] = await db.select().from(retestSuggestions)
    .where(and(eq(retestSuggestions.id, suggestionId), eq(retestSuggestions.sellerId, sellerId))).limit(1);
  if (!row) return { ok: false, state: "not_found", startedWork: false };
  if (action === "plan_retest") {
    // D5/§12.1: recording intent is the END of what this service may do. The
    // seller then runs benchmark.create → quote → approve → start themselves,
    // with their own plan hash and spend approval.
    await db.update(retestSuggestions).set({ state: "retest_started" }).where(eq(retestSuggestions.id, row.id));
    return { ok: true, state: "retest_started", startedWork: false };
  }
  await db.update(retestSuggestions).set({
    state: action === "dismiss" ? "dismissed" : "snoozed",
    snoozedUntil: action === "snooze" ? (opts?.until ?? null) : row.snoozedUntil,
  }).where(eq(retestSuggestions.id, row.id));
  return { ok: true, state: action === "dismiss" ? "dismissed" : "snoozed", startedWork: false };
}

/**
 * Deprecation is recorded and DISCLOSED. Execution is not disabled from here:
 * §12.1 allows disabling only "after a clear compatibility check", and no
 * approved policy defines that check yet, so inventing one would be a decision
 * this module has no authority to make. Historical evidence is never touched.
 */
export async function markModelDeprecated(actorId: number, catalogId: number, deprecatedAt: Date): Promise<{ ok: true; executionDisabled: false }> {
  await assertAdmin(actorId);
  const db = getDb();
  await db.update(modelCatalog).set({ deprecatedAt }).where(eq(modelCatalog.id, catalogId));
  return { ok: true, executionDisabled: false };
}

/** Seller/buyer-facing freshness read for a published listing's current version. */
export async function modelFreshnessForListing(listingId: number) {
  const db = getDb();
  const [publication] = await db.select({
    manifest: evidencePublications.publicManifest, testedAt: evidencePublications.testedAt, id: evidencePublications.id,
  }).from(evidencePublications)
    .where(and(eq(evidencePublications.listingId, listingId), eq(evidencePublications.publicationKind, "seller"), eq(evidencePublications.state, "published")))
    .orderBy(desc(evidencePublications.id)).limit(1);
  if (!publication) return null;
  const parsed = PublicEvidenceManifestSchema.safeParse(JSON.parse(String(publication.manifest)));
  if (!parsed.success) return null;
  const tested = parsed.data.testedModels.map((m) => ({ provider: m.provider.toLowerCase(), model: m.returnedModel ?? m.requestedModel }));
  const rows = await db.select().from(modelCatalog);
  const byKey = new Map(rows.map((r) => [`${r.provider}|${r.modelId}`, r]));
  return {
    publicationId: publication.id,
    testedAt: publication.testedAt,
    models: tested.map((t) => {
      const entry = byKey.get(`${t.provider}|${t.model}`);
      // A successor must be a REVIEWED successor of THIS catalogued model —
      // never a name match.
      const successor = entry
        ? rows.find((r) => r.provider === entry.provider && r.successorOfModelId === entry.modelId)?.modelId ?? null
        : null;
      return {
        provider: t.provider,
        model: t.model,
        catalogued: !!entry,
        deprecatedAt: entry?.deprecatedAt ?? null,
        family: entry?.family ?? null,
        successor,
      };
    }),
    note: "Age alone never delists a listing, and no retest is scheduled for you (§12.1).",
  };
}

/** Exported for tests: the exact predicate the unique index uses. */
export const suggestionUniqColumns = ["sellerId", "workflowVersionId", "releaseEventId", "channel"] as const;
