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
import { pipelineSteps, pipelineTemplates, projects } from "@db/schema";
import { logger } from "../lib/logger";
import { resolveProtectedExecutionRight } from "./executionRight";
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
  versionBinding: "purchase_receipt" | "grant" | "legacy_current";
  stepCount: number;
  meaning: string;
}

/**
 * Hand the entitled buyer their own copy of a listing's certified workflow
 * version: a project they own, steps they can edit, a template so the copy is a
 * complete runnable object, and a first immutable version of their own carrying
 * the seller in its lineage.
 */
export async function deliverPurchasedCopy(
  buyerId: number,
  input: z.infer<typeof deliverPurchasedCopyInputSchema>,
): Promise<DeliveredCopy> {
  // (1) Entitlement. Deliberately the protected-run authority, so "you bought
  // it" means one thing in this codebase and cannot drift between the two ways
  // a buyer receives value.
  const right = await resolveProtectedExecutionRight({
    buyerId,
    listingId: input.listingId,
    purpose: "buyer_execution",
  });
  const listing = right.listing;

  const { version, definition } = await loadVersionDefinition(right.soldVersionId);
  if (version.ownerId !== right.sellerId || version.id !== right.soldVersionId) {
    throw new PipelineDeliveryError(
      "version_unavailable",
      "the version this purchase was receipted against no longer belongs to the listing",
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
      buyerId,
      listingId: listing.id,
      versionId: version.id,
      storedHash,
    });
    throw new PipelineDeliveryError(
      "definition_hash_mismatch",
      "the published version no longer matches the hash recorded with it, so no copy of it can be certified as delivered",
    );
  }

  const db = getDb();
  const projectName = (input.name ?? `${listing.title} (copy)`).slice(0, 200);

  const [insertedProject] = await db.insert(projects).values({
    userId: buyerId,
    name: projectName,
    description: listing.description,
    // PROVENANCE AS DATA: the copy is owned and editable by the buyer, and it
    // stays attributed to the account that originally made the work — which is
    // also what refuses a reseller at the publish gate.
    originCreatorId: right.sellerId,
  });
  const projectId = Number((insertedProject as { insertId: number }).insertId);

  // (3) The seller's bindings are dropped, not inherited.
  for (const step of definition.steps) {
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
    userId: buyerId,
    name: `${projectName} template`.slice(0, 200),
    description: `Delivered from marketplace listing ${listing.id} (workflow version ${version.versionNumber})`,
    isAuto: false,
    sourceProjectId: projectId,
    steps: definition.steps.map((s) => ({
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
  const { versionId: buyerVersionId } = await captureVersionFromProject(buyerId, projectId, {
    parentVersionId: right.soldVersionId,
  });

  logger.info("Marketplace copy delivered", {
    buyerId,
    listingId: listing.id,
    sellerId: right.sellerId,
    soldVersionId: right.soldVersionId,
    projectId,
    definitionHash: storedHash,
  });

  const bindingNote = right.versionBinding === "legacy_current"
    // A pre-migration receipt names no version, so this is the listing's current
    // one — which a seller may have changed after the sale. Say so, in the record
    // the buyer keeps, rather than letting the hash imply a promise nobody made.
    ? ` Your receipt predates version receipting, so what you received is the listing's CURRENT version (${version.versionNumber}, hash ${storedHash}) rather than a version your purchase names — check that hash against the evidence before you rely on it.`
    : "";

  return {
    projectId,
    projectName,
    templateId,
    workflowVersionId: buyerVersionId,
    listingId: listing.id,
    sellerId: right.sellerId,
    deliveredDefinitionHash: storedHash,
    deliveredVersionNumber: Number(version.versionNumber),
    versionBinding: right.versionBinding,
    stepCount: definition.steps.length,
    meaning: `This copy is yours to edit and to run, and it is billed to your own keys — the seller's provider and agent bindings were deliberately not carried over. It arrived as workflow version ${version.versionNumber} of listing ${listing.id}, definition hash ${storedHash}. The evidence published for that listing describes THAT hash: edit the copy and it stops describing yours, and nothing on our side will tell you when. A copy can be shared; that is what buying one means here, and this product does not claim to prevent it.${bindingNote}`,
  };
}
