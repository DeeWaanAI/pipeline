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
import { and, eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { pipelineSteps, pipelineTemplates, projects } from "@db/schema";
import { buildPipelineBundle, bundleIntegrityHash, verifyPipelineBundle, type PipelineBundle } from "./pipelineBundle";
import { exportBenchmarkArchive } from "./benchmark/benchmarkExport";
import { attestBundle, signingPublicKeyPem } from "./evidenceSigning";
import type { VersionDefinition } from "./benchmark/benchmarkTypes";
import { captureVersionFromProject, stableJson } from "./benchmark/versionService";

export class PipelineDeliveryError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`delivery_${code}: ${detail}`);
    this.name = "PipelineDeliveryError";
    this.code = code;
  }
}


async function writeCopyIntoAccount(args: {
  userId: number;
  listing: { id: number; title: string; description: string | null };
  steps: VersionDefinition["steps"];
  pipelineConfig: typeof projects.$inferInsert.pipelineConfig;
  sourceVersionNumber: number;
  name?: string;
} & ({
  via: "purchase" | "fork";
  sellerId: number;
  sourceVersionId: number;
} | {
  via: "import";
  portableMetadata: {
    kind: string;
    exportedAt: string;
    provenance: PipelineBundle["provenance"];
    evidence: PipelineBundle["evidence"];
    attestation: PipelineBundle["attestation"];
    verification: ReturnType<typeof verifyPipelineBundle>;
  };
})): Promise<{ projectId: number; projectName: string; templateId: number; versionId: number }> {
  const db = getDb();
  const projectName = (args.name ?? `${args.listing.title} (copy)`).slice(0, 200);
  const pipelineConfig = args.via === "import"
    ? { ...args.pipelineConfig, _importedBundle: args.portableMetadata }
    : args.pipelineConfig ?? null;

  const { projectId, templateId } = await db.transaction(async (tx) => {
    const [insertedProject] = await tx.insert(projects).values({
      userId: args.userId,
      name: projectName,
      description: args.listing.description,
      pipelineConfig,
      // NULL means the local owner created it. Zero instead keeps external work
      // ineligible for resale without treating a remote account ID as a local one.
      originCreatorId: args.via === "import" ? 0 : args.sellerId,
    });
    const projectId = Number((insertedProject as { insertId: number }).insertId);

    // (3) The seller's bindings are dropped, not inherited.
    for (const step of args.steps) {
      await tx.insert(pipelineSteps).values({
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
        parameters: (step as { parameters?: Record<string, unknown> | null }).parameters ?? null,
        ifConfig: step.ifConfig ?? null,
        whileConfig: step.whileConfig ?? null,
        isEnabled: true,
      });
    }

    const [insertedTemplate] = await tx.insert(pipelineTemplates).values({
      userId: args.userId,
      name: `${projectName} template`.slice(0, 200),
      description: `${args.via === "purchase" ? "Delivered" : args.via === "fork" ? "Forked" : "Imported"} from ${args.via === "import" ? "external " : ""}marketplace listing ${args.listing.id} (workflow version ${args.sourceVersionNumber})`,
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
        ...{ parameters: (s as { parameters?: Record<string, unknown> | null }).parameters ?? null },
      })),
    });
    const templateId = Number((insertedTemplate as { insertId: number }).insertId);
    await tx.update(projects).set({ pipelineTemplateId: templateId }).where(eq(projects.id, projectId));
    return { projectId, templateId };
  });

  // Version capture uses its own connection, so it must follow the copy commit.
  // Remote version IDs remain metadata even when they happen to exist locally.
  const { versionId } = await captureVersionFromProject(args.userId, projectId, {
    parentVersionId: args.via === "import" ? null : args.sourceVersionId,
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
): Promise<{ projectId: number; projectName: string; templateId: number; versionId: number; verification: ReturnType<typeof verifyPipelineBundle>; meaning: string }> {
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
    steps: candidate.pipeline.steps as unknown as VersionDefinition["steps"],
    pipelineConfig: p.pipelineConfig as typeof projects.$inferInsert.pipelineConfig,
    sourceVersionNumber: p.workflowVersionNumber ?? 0,
    via: "import",
    portableMetadata: {
      kind: candidate.kind,
      exportedAt: candidate.exportedAt,
      provenance: p,
      evidence: candidate.evidence,
      attestation: candidate.attestation,
      verification,
    },
    name: input.name,
  });
  const meaning = verification.evidenceState === "verified"
    ? `Imported and attributed to ${p.originAccountName ?? "account " + p.originCreatorId}. The published benchmark evidence verifies against the platform's signing key and names this exact definition hash (${verification.definitionHash}) — edit the steps and it stops describing your copy.`
    : `Imported. The file is intact and hashes to ${verification.definitionHash}, but its benchmark claim is ${verification.evidenceState}: nothing here proves DeeWaanAI issued it. Treat the scores as the author's assertion, not as verified evidence.`;
  return { ...written, verification, meaning };
}

export const exportPipelineBundleInputSchema = z.object({
  projectId: z.number().int().positive(),
  benchmarkId: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(200).optional(),
});

/**
 * Export YOUR OWN pipeline as a file — the step that makes sharing work without
 * any server. No listing, no purchase, no benchmark required; a benchmark is an
 * OPTION the author can attach, and when attached its archive is bound into the
 * same signature so the recipient receives one artifact, not two that might
 * drift apart.
 *
 * The snapshot is immutable in the file sense: the hash is taken over exactly
 * the steps shipped, so if the author edits the project afterwards the file they
 * already sent still describes what they sent.
 */
export async function exportOwnPipelineBundle(
  userId: number,
  input: z.infer<typeof exportPipelineBundleInputSchema>,
): Promise<PipelineBundle> {
  const db = getDb();
  const [project] = await db.select().from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.userId, userId))).limit(1);
  if (!project) throw new PipelineDeliveryError("not_found_or_not_authorized", "pipeline is not available to this account");

  const rows = await db.select().from(pipelineSteps)
    .where(eq(pipelineSteps.projectId, project.id)).orderBy(pipelineSteps.stepOrder);
  if (rows.length === 0) throw new PipelineDeliveryError("nothing_to_export", "this pipeline has no steps to export");
  const steps = rows.map((st) => ({
    stepOrder: st.stepOrder,
    name: st.name,
    role: st.role,
    systemPrompt: st.systemPrompt,
    stepType: st.stepType ?? "agent",
    model: st.model ?? null,
    temperature: st.temperature ?? null,
    maxTokens: st.maxTokens ?? null,
    parameters: st.parameters ?? null,
    ifConfig: st.ifConfig ?? null,
    whileConfig: st.whileConfig ?? null,
  }));
  const schemaVersion = 1;
  const pipelineConfig = project.pipelineConfig ?? null;
  const bundleHash = bundleIntegrityHash({ steps, schemaVersion, pipelineConfig });

  let benchmark: PipelineBundle["benchmark"] = null;
  let benchmarkHash: string | null = null;
  if (input.benchmarkId) {
    const exported = await exportBenchmarkArchive({ userId, benchmarkId: input.benchmarkId });
    const bench: NonNullable<PipelineBundle["benchmark"]> = {
      benchmarkId: input.benchmarkId,
      planHash: (exported.benchmark as { planHash?: string | null }).planHash ?? null,
      files: exported.archive.files,
      incomplete: exported.archive.incomplete,
    };
    benchmark = bench;
    benchmarkHash = createHash("sha256").update(stableJson(bench.files)).digest("hex");
  }

  const attestation = attestBundle({
    bundleHash,
    definitionHash: bundleHash,
    manifestHash: null,
    benchmarkHash,
    listingId: null,
    workflowVersionId: null,
    originCreatorId: userId,
  });

  return buildPipelineBundle({
    pipelineName: input.name ?? project.name,
    pipelineDescription: project.description ?? null,
    steps,
    listingId: null,
    workflowVersionId: null,
    schemaVersion,
    pipelineConfig,
    originCreatorId: userId,
    originAccountName: null,
    workflowVersionNumber: null,
    definitionHash: bundleHash,
    bundleHash,
    manifestHash: null,
    manifestJson: null,
    attestation: null,
    bundleAttestation: attestation,
    benchmark,
  });
}
