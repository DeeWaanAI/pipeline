// ═══════════════════════════════════════════════════════════════════
//  PIPELINE DELIVERY — Class A: buying a listing hands over a COPY (v3)
// ═══════════════════════════════════════════════════════════════════
// The v3 fork was answered on 2026-10-13: a listing is sold as a copy
// (V3-ARCHITECTURE-DECISION.md §7). The buyer receives the certified workflow
// version as their own editable pipeline and runs it with their own keys.
//
// Nothing here protects the definition. A copy that can be read can be shared,
// and `api/services/protectedEgress.ts:31` already states the reason out loud:
// "a determined buyer can probe the workflow through its permitted outputs".
// So the product does not claim secrecy — it claims PROVENANCE, and provenance
// needs the delivered hash recorded and checkable. That is what the receipt
// below is for, and it is why this file refuses to deliver anything whose hash
// does not match the row it is read from.
//
// Three things are enforced, in order of how much they cost to get wrong:
//  1. The buyer must hold a real purchase or execution grant for the EXACT
//     version delivered. Not a flag, not a caller-supplied version id: the same
//     authority a protected run consults (`resolveProtectedExecutionRight`), so
//     a refund or revocation closes this door at the same moment it closes the
//     run door.
//  2. The prompts handed over must be the version the marketplace certified.
//     `definitionHash` is recomputed over what is about to be written and
//     compared to the immutable row; a mismatch refuses rather than shipping a
//     copy that evidence no longer describes.
//  3. The seller's private bindings never travel. `providerId` and `agentId` are
//     nulled exactly as a cross-account clone nulls them
//     (`api/services/pipelineSharing.ts:820-825`), so the buyer cannot be billed
//     against someone else's credential row and cannot reach a seller-owned
//     agent record. BYOK is a property of the copy, not a polite default.

import { createHash } from "crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { evidencePublications, marketplaceListingV2, marketplaceListings, pipelineSteps, pipelineTemplates, projects, users } from "@db/schema";
import { logger } from "../lib/logger";
import { buildPipelineBundle, bundleIntegrityHash, verifyPipelineBundle, type PipelineBundle } from "./pipelineBundle";
import { signingPublicKeyPem, type EvidenceAttestation } from "./evidenceSigning";
import { resolveProtectedExecutionRight } from "./executionRight";
import type { VersionDefinition } from "./benchmark/benchmarkTypes";
import {
  captureVersionFromProject,
  loadVersionDefinition,
  stableJson,
} from "./benchmark/versionService";

export const deliverPurchasedCopyInputSchema = z.object({
  listingId: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
});

export class PipelineDeliveryError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`delivery_${code}: ${detail}`);
    this.name = "PipelineDeliveryError";
    this.code = code;
  }
}

/** How the handed-over version was chosen. `public_fork` never came from a
 *  purchase at all: the listing is public and its evidence is published. */
export type DeliveryBinding = "purchase_receipt" | "grant" | "legacy_current" | "public_fork";

export interface DeliveredCopy {
  projectId: number;
  projectName: string;
  templateId: number;
  workflowVersionId: number;
  listingId: number;
  sellerId: number;
  /** The hash of the definition that was written into the buyer's rows. This is
   *  what the listing's published evidence describes, and the only thing a
   *  buyer's edited copy can be compared against. */
  deliveredDefinitionHash: string;
  deliveredVersionNumber: number;
  /** How the delivered version was chosen. `purchase_receipt` means the buyer's
   *  own purchase row names this version; `legacy_current` means the receipt
   *  predates version receipting (migration 029) and the listing's CURRENT
   *  version was handed over instead — which is the one case where a copy can
   *  be a different build than the one money changed hands for. It is reported,
   *  not hidden, and it is not silently treated as a bound delivery. */
  versionBinding: DeliveryBinding;
  stepCount: number;
  meaning: string;
}

interface MaterializeArgs {
  userId: number;
  listing: typeof marketplaceListings.$inferSelect;
  sellerId: number;
  soldVersionId: number;
  versionBinding: DeliveryBinding;
  via: "purchase" | "fork";
  name?: string;
}

/**
 * The one implementation of "write this certified definition into that account".
 * Both doors reach it — a purchase, a public fork, and an imported bundle — so
 * the rules cannot drift between them: the origin account stays attributed as
 * data, the author's provider and agent bindings are dropped rather than
 * inherited, and the copy gets a template and a first immutable version so it is
 * a complete runnable object rather than a pile of rows.
 */
async function writeCopyIntoAccount(args: {
  userId: number;
  listing: { id: number; title: string; description: string | null };
  sellerId: number;
  steps: VersionDefinition["steps"];
  sourceVersionId: number;
  sourceVersionNumber: number;
  via: "purchase" | "fork" | "import";
  name?: string;
}): Promise<{ projectId: number; projectName: string; templateId: number; versionId: number }> {
  const db = getDb();
  const projectName = (args.name ?? `${args.listing.title} (copy)`).slice(0, 200);

  const [insertedProject] = await db.insert(projects).values({
    userId: args.userId,
    name: projectName,
    description: args.listing.description,
    // PROVENANCE AS DATA: the copy is owned and editable by the buyer, and it
    // stays attributed to the account that originally made the work — which is
    // also what refuses a reseller at the publish gate.
    originCreatorId: args.sellerId,
  });
  const projectId = Number((insertedProject as { insertId: number }).insertId);

  // (3) The seller's bindings are dropped, not inherited.
  for (const step of args.steps) {
    await db.insert(pipelineSteps).values({
      projectId,
      stepOrder: step.stepOrder,
      agentId: null,
      stepType: step.stepType ?? "agent",
      name: step.name,
      role: step.role,
      systemPrompt: step.systemPrompt,
      providerId: null,
      model: step.model ?? null,
      temperature: step.temperature ?? "0.7",
      maxTokens: step.maxTokens ?? 4096,
      ifConfig: step.ifConfig ?? null,
      whileConfig: step.whileConfig ?? null,
      isEnabled: true,
    });
  }

  const [insertedTemplate] = await db.insert(pipelineTemplates).values({
    userId: args.userId,
    name: `${projectName} template`.slice(0, 200),
    description: `${args.via === "purchase" ? "Delivered" : args.via === "fork" ? "Forked" : "Imported"} from marketplace listing ${args.listing.id} (workflow version ${args.sourceVersionNumber})`,
    isAuto: false,
    sourceProjectId: projectId,
    steps: args.steps.map((s) => ({
      name: s.name,
      role: s.role,
      systemPrompt: s.systemPrompt,
      stepType: s.stepType ?? "agent",
      ifConfig: s.ifConfig ?? null,
      whileConfig: s.whileConfig ?? null,
      providerId: null,
      model: s.model ?? null,
      temperature: s.temperature ?? "0.7",
      maxTokens: s.maxTokens ?? 4096,
    })),
  });
  const templateId = Number((insertedTemplate as { insertId: number }).insertId);
  await db.update(projects).set({ pipelineTemplateId: templateId }).where(eq(projects.id, projectId));

  // The copy gets a version row of its own, parented to the certified one, so
  // the seller's account survives in lineage and the buyer's edits start from a
  // known hash rather than from nothing.
  const { versionId } = await captureVersionFromProject(args.userId, projectId, {
    parentVersionId: args.sourceVersionId > 0 ? args.sourceVersionId : null,
  });
  return { projectId, projectName, templateId, versionId };
}

/**
 * The one materializer behind both doors: it writes a listing's certified
 * workflow version into the recipient's OWN account — a project they own, steps
 * they can edit, a template so the copy is a complete runnable object, and a
 * first immutable version carrying the origin account in its lineage. Whether
 * the recipient earned that copy by purchase or by the listing being public is
 * decided by the caller, never here.
 */
async function materializeCertifiedVersion(args: MaterializeArgs): Promise<DeliveredCopy> {
  const { userId, listing, sellerId } = args;

  const { version, definition } = await loadVersionDefinition(args.soldVersionId);
  if (version.ownerId !== sellerId || version.id !== args.soldVersionId) {
    throw new PipelineDeliveryError(
      "version_unavailable",
      "the version named for this handover no longer belongs to the listing",
    );
  }
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
    throw new PipelineDeliveryError("nothing_to_deliver", "the certified version has no steps to copy");
  }

  // (2) Integrity, over exactly what is about to be written.
  const recomputed = createHash("sha256").update(stableJson(definition)).digest("hex");
  const storedHash = String(version.definitionHash);
  if (recomputed !== storedHash) {
    logger.error("Refusing delivery: version row no longer matches its own hash", {
      userId,
      listingId: listing.id,
      versionId: version.id,
      storedHash,
    });
    throw new PipelineDeliveryError(
      "definition_hash_mismatch",
      "the published version no longer matches the hash recorded with it, so no copy of it can be certified as delivered",
    );
  }

  const written = await writeCopyIntoAccount({
    userId, listing, sellerId, steps: definition.steps,
    sourceVersionId: args.soldVersionId, sourceVersionNumber: Number(version.versionNumber),
    via: args.via, name: args.name,
  });
  const { projectId, projectName, templateId } = written;
  const recipientVersionId = written.versionId;

  logger.info("Marketplace copy handed over", {
    userId,
    via: args.via,
    listingId: listing.id,
    sellerId,
    soldVersionId: args.soldVersionId,
    projectId,
    definitionHash: storedHash,
  });

  const bindingNote = args.versionBinding === "legacy_current"
    // A pre-migration receipt names no version, so this is the listing's current
    // one — which a seller may have changed after the sale. Say so, in the record
    // the buyer keeps, rather than letting the hash imply a promise nobody made.
    ? ` Your receipt predates version receipting, so what you received is the listing's CURRENT version (${version.versionNumber}, hash ${storedHash}) rather than a version your purchase names — check that hash against the evidence before you rely on it.`
    : "";

  return {
    projectId,
    projectName,
    templateId,
    workflowVersionId: recipientVersionId,
    listingId: listing.id,
    sellerId,
    deliveredDefinitionHash: storedHash,
    deliveredVersionNumber: Number(version.versionNumber),
    versionBinding: args.versionBinding,
    stepCount: definition.steps.length,
    meaning: `This copy is yours to edit and to run, and it is billed to your own keys — the origin account's provider and agent bindings were deliberately not carried over. It arrived as workflow version ${version.versionNumber} of listing ${listing.id}, definition hash ${storedHash}. The evidence published for that listing describes THAT hash: edit the copy and it stops describing yours, and nothing on our side will tell you when. ${args.via === "fork"
      ? "It is attributed to the account that made it, the way a fork on GitHub is — that attribution travels with the copy."
      : "A copy can be shared; that is what receiving one means here, and this product does not claim to prevent it."}${bindingNote}`,
  };
}

/** Door 1: the buyer of a listing takes delivery of what they bought. */
export async function deliverPurchasedCopy(
  buyerId: number,
  input: z.infer<typeof deliverPurchasedCopyInputSchema>,
): Promise<DeliveredCopy> {
  // Entitlement is the protected-run authority, so "you bought it" means one
  // thing in this codebase and cannot drift between the ways a buyer is served.
  const right = await resolveProtectedExecutionRight({
    buyerId,
    listingId: input.listingId,
    purpose: "buyer_execution",
  });
  return materializeCertifiedVersion({
    userId: buyerId, listing: right.listing, sellerId: right.sellerId,
    soldVersionId: right.soldVersionId, versionBinding: right.versionBinding,
    via: "purchase", name: input.name,
  });
}

export const forkPublicListingInputSchema = z.object({
  listingId: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
});

/**
 * Door 2: a public listing is forkable by anyone, with no purchase and no
 * entitlement — but only because it paid the entry fee first. A listing reaches
 * `published` through the evidence boundary, which requires a benchmark run with
 * a three-judge panel, so "is there a published evidence record for exactly this
 * version" IS the quality gate. No evidence, no fork: the refusal says so rather
 * than handing over an unverified pipeline.
 */
export async function forkPublicListing(
  userId: number,
  input: z.infer<typeof forkPublicListingInputSchema>,
): Promise<DeliveredCopy> {
  const db = getDb();
  const [listing] = await db.select().from(marketplaceListings)
    .where(eq(marketplaceListings.id, input.listingId)).limit(1);
  // A missing listing and an unpublished one answer identically: nothing here
  // may be probed for existence.
  if (!listing || listing.status !== "published") {
    throw new PipelineDeliveryError("not_available", "this pipeline is not published for sharing");
  }
  const [v2] = await db.select().from(marketplaceListingV2)
    .where(eq(marketplaceListingV2.listingId, listing.id)).limit(1);
  if (v2?.publicationMode !== "v2" || !v2.currentWorkflowVersionId) {
    throw new PipelineDeliveryError(
      "no_certified_version",
      "this listing has no certified workflow version, so there is nothing verified to fork",
    );
  }
  if (!v2.currentEvidencePublicationId) {
    throw new PipelineDeliveryError(
      "no_published_evidence",
      "this listing's benchmark evidence is not published, so it cannot be forked — the shared copy must come with its inputs, outputs and judging prompts",
    );
  }
  // Forking your own listing is just a copy of your own work; allowed, but it is
  // the same materializer with the same attribution rules.
  return materializeCertifiedVersion({
    userId, listing, sellerId: listing.creatorId,
    soldVersionId: v2.currentWorkflowVersionId, versionBinding: "public_fork",
    via: "fork", name: input.name,
  });
}

/**
 * The file a share actually is: the certified definition, who made it, and the
 * signed evidence record proving the benchmark ran against THIS version. Built
 * from the platform's own rows, so the hash and the attestation cannot drift
 * from what was published.
 *
 * Two kinds of caller may ask for it. An entitled buyer, because a purchase
 * entitles them to the artifact they paid for. Anyone, when the listing is
 * published with evidence — that is what "shared" means here.
 */
export async function exportListingBundle(
  userId: number,
  listingId: number,
): Promise<PipelineBundle> {
  const db = getDb();
  const [listing] = await db.select().from(marketplaceListings)
    .where(eq(marketplaceListings.id, listingId)).limit(1);
  const [v2] = await db.select().from(marketplaceListingV2)
    .where(eq(marketplaceListingV2.listingId, listingId)).limit(1);

  const entitled = await resolveProtectedExecutionRight({
    buyerId: userId, listingId, purpose: "buyer_execution",
  }).catch(() => null);
  const isPublic = Boolean(
    listing && listing.status === "published" && v2
    && v2.publicationMode === "v2" && v2.currentWorkflowVersionId && v2.currentEvidencePublicationId,
  );
  // A listing that is neither yours by right nor published for sharing answers
  // the same way a nonexistent one does: nothing may be probed for what exists.
  if (!entitled && !isPublic) {
    throw new PipelineDeliveryError(
      "not_available",
      "this pipeline is not published with evidence and you hold no right to it, so there is no bundle to hand over",
    );
  }

  const versionId = entitled?.soldVersionId ?? v2!.currentWorkflowVersionId!;
  const sellerId = listing!.creatorId;
  const { version, definition } = await loadVersionDefinition(versionId);
  const [author] = await db.select({ name: users.name }).from(users).where(eq(users.id, sellerId)).limit(1);

  let manifestHash: string | null = null;
  let attestation: EvidenceAttestation | null = null;
  if (v2?.currentEvidencePublicationId) {
    const [pub] = await db.select({
      manifestHash: evidencePublications.manifestHash,
      publicManifest: evidencePublications.publicManifest,
    }).from(evidencePublications)
      .where(eq(evidencePublications.id, v2.currentEvidencePublicationId)).limit(1);
    if (pub) {
      manifestHash = pub.manifestHash;
      try {
        attestation = (JSON.parse(String(pub.publicManifest)) as { attestation?: EvidenceAttestation }).attestation ?? null;
      } catch {
        // A stored manifest that will not parse is reported by its absence: the
        // bundle still carries the work, and the evidence section says there is
        // nothing verified to attach.
        attestation = null;
      }
    }
  }

  return buildPipelineBundle({
    pipelineName: listing!.title,
    pipelineDescription: listing!.description ?? null,
    steps: definition.steps.map((st) => ({
      stepOrder: st.stepOrder,
      name: st.name,
      role: st.role,
      systemPrompt: st.systemPrompt,
      stepType: st.stepType,
      model: st.model ?? null,
      temperature: st.temperature ?? null,
      maxTokens: st.maxTokens ?? null,
      ifConfig: st.ifConfig ?? null,
      whileConfig: st.whileConfig ?? null,
    })),
    listingId: listing!.id,
    workflowVersionId: version.id,
    schemaVersion: Number(definition.schemaVersion ?? 1),
    pipelineConfig: definition.pipelineConfig ?? null,
    originCreatorId: sellerId,
    originAccountName: author?.name ?? null,
    workflowVersionNumber: Number(version.versionNumber),
    definitionHash: String(version.definitionHash),
    bundleHash: bundleIntegrityHash({
      steps: definition.steps.map((st) => ({
        stepOrder: st.stepOrder, name: st.name, role: st.role, systemPrompt: st.systemPrompt,
        stepType: st.stepType, model: st.model ?? null, temperature: st.temperature ?? null,
        maxTokens: st.maxTokens ?? null, ifConfig: st.ifConfig ?? null, whileConfig: st.whileConfig ?? null,
      })),
      schemaVersion: Number(definition.schemaVersion ?? 1),
      pipelineConfig: definition.pipelineConfig ?? null,
    }),
    manifestHash,
    attestation,
  });
}

export const importPipelineBundleInputSchema = z.object({
  bundle: z.unknown(),
  name: z.string().trim().min(1).max(200).optional(),
});

/**
 * Bring a bundle home: verify it against the platform's own key, then write it
 * into the importer's account with the same rules a fork follows. An intact but
 * unsigned bundle still imports — it is somebody's pipeline, and refusing to
 * move their own work would be worse — but the answer says the benchmark claim
 * is unproven.
 */
export async function importPipelineBundle(
  userId: number,
  input: { bundle: unknown; name?: string },
): Promise<{ projectId: number; projectName: string; verification: ReturnType<typeof verifyPipelineBundle>; meaning: string }> {
  const candidate = input.bundle as PipelineBundle;
  const pinned = signingPublicKeyPem();
  const verification = verifyPipelineBundle(candidate, pinned ?? undefined);
  if (!verification.valid) {
    throw new PipelineDeliveryError(
      `bundle_${verification.reason}`,
      "the bundle was not imported: " + verification.reason,
    );
  }
  const p = candidate.provenance;
  const written = await writeCopyIntoAccount({
    userId,
    listing: { id: p.listingId ?? 0, title: candidate.pipeline.name, description: candidate.pipeline.description ?? null },
    sellerId: p.originCreatorId,
    steps: candidate.pipeline.steps as unknown as VersionDefinition["steps"],
    sourceVersionId: p.workflowVersionId ?? 0,
    sourceVersionNumber: p.workflowVersionNumber ?? 0,
    via: "import",
    name: input.name,
  });
  const meaning = verification.evidenceState === "verified"
    ? `Imported and attributed to ${p.originAccountName ?? "account " + p.originCreatorId}. The published benchmark evidence verifies against the platform's signing key and names this exact definition hash (${verification.definitionHash}) — edit the steps and it stops describing your copy.`
    : `Imported. The file is intact and hashes to ${verification.definitionHash}, but its benchmark claim is ${verification.evidenceState}: nothing here proves DeeWaanAI issued it. Treat the scores as the author's assertion, not as verified evidence.`;
  return { ...written, verification, meaning };
}
