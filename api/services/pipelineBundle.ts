// ═══════════════════════════════════════════════════════════════════
//  PIPELINE BUNDLE — a shared pipeline that leaves the platform (v3)
// ═══════════════════════════════════════════════════════════════════
// A shared pipeline is only genuinely shared if the recipient can take it home:
// write it to their own folder, open it in the desktop app they already use, and
// run it on their own keys. Nothing in this file needs the platform to be
// reachable at the moment of verification — that is the point of signing the
// evidence rather than pointing at a URL.
//
// What a bundle carries, and why each piece is there:
//   pipeline   — the work itself: ordered steps, prompts, per-step model and
//                limits. No database row ids, no provider references: a
//                `providerId` from the author's account cannot be honoured by
//                anyone else and would only invite a broken import.
//   provenance — who made it, which listing, which version, and the definition
//                hash the evidence describes. This is the "forked from X" that
//                travels with the file once the file has left.
//   evidence   — the published manifest hash and the platform's attestation over
//                it, so a reader can check offline that DeeWaanAI issued the
//                claim, and that it is a claim about THIS pipeline.
//
// Two refusals are the whole security story:
//   1. The shipped steps must hash to `provenance.bundleHash`. Corruption and
//      casual editing are caught and the bundle is rejected rather than silently
//      imported. What this CANNOT do is prove the shipped steps are the certified
//      ones: the platform's version hash covers the author's provider bindings,
//      which a portable file must not carry, so the two hashes are different
//      objects. Closing that needs the platform to sign the sanitized form — see
//      the note in BundleVerification.
//   2. The attestation must verify against the pinned platform key AND name this
//      exact manifest hash, listing and version. A valid signature copied from
//      another pipeline's bundle does not ride along: the identity is inside the
//      signed bytes.
//
// An absent attestation is reported, not hidden. A bundle can still be imported
// when the platform had no signing key configured — it is the author's own
// pipeline, and refusing to let people move their own work would be worse than
// letting them move it unlabelled — but the import says plainly that nothing
// proves the benchmark claims.

import { createHash } from "node:crypto";
import { z } from "zod";
import { stableJson } from "./benchmark/versionService";
import { verifyBundleAttestation, verifyEvidenceAttestation, type BundleAttestation, type EvidenceAttestation } from "./evidenceSigning";

export const PIPELINE_BUNDLE_KIND = "deewaanai-pipeline-bundle-v1";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.number().int().positive();
const signatureSchema = z.object({
  kind: z.string(), algorithm: z.literal("ed25519"), keyId: z.string().min(1),
  issuedAt: z.string().datetime(), signedPayload: z.string().min(1),
  signature: z.string().min(1), publicKeyPem: z.string().min(1),
});
const bundleSchema = z.object({
  kind: z.literal(PIPELINE_BUNDLE_KIND),
  exportedAt: z.string().datetime(),
  pipeline: z.object({
    name: z.string().min(1).max(200), description: z.string().nullable(),
    steps: z.array(z.object({
      stepOrder: idSchema, name: z.string().min(1).max(100), role: z.string().min(1).max(50),
      systemPrompt: z.string(), stepType: z.enum(["agent", "if", "while", "approval"]),
      model: z.string().max(100).nullable(), temperature: z.string().max(10).nullable(),
      maxTokens: idSchema.nullable(),
      ifConfig: z.object({ options: z.array(z.string()), mappings: z.record(z.string(), idSchema) }).strict().nullable(),
      whileConfig: z.object({ targetStep: idSchema, maxIterations: idSchema }).strict().nullable(),
    }).strict()).min(1),
  }).strict(),
  provenance: z.object({
    listingId: idSchema.nullable(), workflowVersionId: idSchema.nullable(),
    originCreatorId: idSchema, originAccountName: z.string().nullable(),
    workflowVersionNumber: idSchema.nullable(), definitionHash: hashSchema,
    bundleHash: hashSchema, schemaVersion: z.literal(1), pipelineConfig: z.json(),
  }).strict(),
  evidence: z.object({
    manifestHash: hashSchema,
    manifestJson: z.string().min(1).nullable(),
    attestation: signatureSchema.extend({
      signer: z.literal("platform"), manifestHash: hashSchema,
      hashExcludes: z.tuple([z.literal("attestation")]),
      identity: z.object({ listingId: idSchema.nullable(), workflowVersionId: idSchema.nullable(),
        definitionHash: hashSchema.nullable(), authorId: idSchema }).strict(),
    }).strict().nullable(),
  }).strict().nullable(),
  benchmark: z.object({
    benchmarkId: idSchema,
    planHash: hashSchema.nullable(),
    files: z.array(z.object({
      path: z.string().min(1), content: z.string(), bytes: z.number().int().nonnegative(), sha256: hashSchema,
    }).strict()),
    incomplete: z.array(z.object({ path: z.string(), reason: z.string() }).strict()),
  }).strict().nullable(),
  attestation: signatureSchema.extend({
    bundleHash: hashSchema, definitionHash: hashSchema, manifestHash: hashSchema.nullable(),
    benchmarkHash: hashSchema.nullable(),
    listingId: idSchema.nullable(), workflowVersionId: idSchema.nullable(), originCreatorId: idSchema,
  }).strict().nullable(),
  note: z.string(),
}).strict();

export interface BundleStep {
  stepOrder: number;
  name: string;
  role: string;
  systemPrompt: string;
  stepType: string;
  model: string | null;
  temperature: string | null;
  maxTokens: number | null;
  ifConfig: unknown;
  whileConfig: unknown;
}

export interface PipelineBundle {
  kind: string;
  exportedAt: string;
  pipeline: { name: string; description: string | null; steps: BundleStep[] };
  provenance: {
    listingId: number | null;
    /** The platform's version ROW id. It is inside the signed bytes, so a bundle
     *  that omitted it could not be verified — the signature would be checked
     *  against an identity the file never claimed. */
    workflowVersionId: number | null;
    originCreatorId: number;
    originAccountName: string | null;
    workflowVersionNumber: number | null;
    /** The platform's hash of the CERTIFIED version — the one the evidence
     *  attestation names. It cannot be recomputed from this file, because the
     *  published definition carries the author's `providerId` and a portable file
     *  must not. What it proves is which version the signature is about. */
    definitionHash: string;
    /** sha256 over the canonical form of the definition AS SHIPPED here (steps
     *  without provider bindings). Detects corruption and casual editing; see the
     *  note on `verifyPipelineBundle` for the limit of what that can claim. */
    bundleHash: string;
    schemaVersion: number;
    pipelineConfig: unknown;
  };
  evidence: {
    manifestHash: string;
    manifestJson: string | null;
    attestation: EvidenceAttestation | null;
  } | null;
  /** The author's benchmark for this pipeline, exported with it. The archive is
   *  self-verifying per file, and its hash is inside the signed payload below, so
   *  pipeline and evidence travel as one attested artifact. */
  benchmark: {
    benchmarkId: number;
    planHash: string | null;
    files: Array<{ path: string; content: string; bytes: number; sha256: string }>;
    incomplete: Array<{ path: string; reason: string }>;
  } | null;
  /** The platform's signature over the file AS SHIPPED. This is what makes the
   *  integrity hash more than a checksum: an editor who recomputes
   *  `provenance.bundleHash` still cannot reproduce it. */
  attestation: BundleAttestation | null;
  note: string;
}

export interface BundleVerification {
  valid: boolean;
  reason: string;
  definitionHash: string;
  /** Whether the benchmark claim on this file can be trusted, separately from
   *  whether the file is intact. `unsigned` means intact and unproven. */
  evidenceState: "verified" | "unsigned" | "invalid" | "absent" | "signer_unpinned";
  /** Whether the shipped file is provably what the platform released. `unsigned`
   *  means the file is intact but nothing binds these steps to that release. */
  provenanceState: "signed" | "unsigned" | "invalid" | "signer_unpinned";
  fingerprint?: string;
  keyId?: string;
}

export interface BundleDefinitionShape {
  steps: BundleStep[];
  schemaVersion: number;
  pipelineConfig: unknown;
}

/**
 * Integrity hash over the shipped definition. Deliberately NOT the platform's
 * version hash: the certified version records which provider row each step used,
 * and a file that leaves the platform must not carry that. So the two hashes
 * answer two different questions — `definitionHash` says which version the
 * signature describes, `bundleHash` says this file was not mangled — and neither
 * one alone proves the shipped steps are the certified steps.
 */

/**
 * The hash a bundle must carry: the same canonical serialization the platform
 * used for the workflow version. `stableJson` sorts keys recursively, so the
 * object is rebuilt here in whatever field order the file happens to use.
 */
export function bundleIntegrityHash(d: BundleDefinitionShape): string {
  return createHash("sha256").update(stableJson({
    schemaVersion: d.schemaVersion,
    steps: d.steps,
    pipelineConfig: d.pipelineConfig ?? null,
  })).digest("hex");
}

export function buildPipelineBundle(args: {
  pipelineName: string;
  pipelineDescription: string | null;
  steps: BundleStep[];
  listingId: number | null;
  workflowVersionId: number | null;
  originCreatorId: number;
  originAccountName: string | null;
  workflowVersionNumber: number | null;
  definitionHash: string;
  bundleHash: string;
  schemaVersion: number;
  pipelineConfig: unknown;
  manifestHash: string | null;
  manifestJson: string | null;
  attestation: EvidenceAttestation | null;
  bundleAttestation: BundleAttestation | null;
  benchmark: PipelineBundle["benchmark"];
}): PipelineBundle {
  return {
    kind: PIPELINE_BUNDLE_KIND,
    exportedAt: new Date().toISOString(),
    pipeline: {
      name: args.pipelineName,
      description: args.pipelineDescription,
      steps: args.steps,
    },
    provenance: {
      listingId: args.listingId,
      workflowVersionId: args.workflowVersionId,
      schemaVersion: args.schemaVersion,
      pipelineConfig: args.pipelineConfig ?? null,
      bundleHash: args.bundleHash,
      originCreatorId: args.originCreatorId,
      originAccountName: args.originAccountName,
      workflowVersionNumber: args.workflowVersionNumber,
      definitionHash: args.definitionHash,
    },
    evidence: args.manifestHash
      ? { manifestHash: args.manifestHash, manifestJson: args.manifestJson, attestation: args.attestation }
      : null,
    attestation: args.bundleAttestation,
    benchmark: args.benchmark,
    note: "Put this file in your own folder and import it whenever you like — it is yours to read, edit and run. provenance.bundleHash covers the steps as shipped; provenance.definitionHash is the certified version the signed evidence describes. They are different hashes on purpose, because the certified version records the author's provider bindings and this file must not.",
  };
}

/**
 * Verify a bundle the reader is holding. `pinnedPlatformKeyPem` is optional and
 * decisive: without it a self-consistent forgery by any key pair passes, so the
 * answer is `signer_unpinned`, not `verified`.
 */
export function verifyPipelineBundle(
  bundle: PipelineBundle,
  pinnedPlatformKeyPem?: string,
): BundleVerification {
  const base = { definitionHash: "", provenanceState: "unsigned" as const };
  if (!bundle || bundle.kind !== PIPELINE_BUNDLE_KIND) {
    return { ...base, valid: false, reason: "not_a_pipeline_bundle", evidenceState: "absent" };
  }
  const steps = bundle.pipeline?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ...base, valid: false, reason: "no_steps", evidenceState: "absent" };
  }
  if (!bundleSchema.safeParse(bundle).success) {
    return { ...base, valid: false, reason: "invalid_bundle_shape", evidenceState: "invalid" };
  }
  const orders = new Set(steps.map((step) => step.stepOrder));
  if (orders.size !== steps.length || steps.some((step) =>
    (step.whileConfig != null && !orders.has((step.whileConfig as { targetStep: number }).targetStep)) ||
    (step.ifConfig != null && Object.values((step.ifConfig as { mappings: Record<string, number> }).mappings)
      .some((target) => !orders.has(target))))) {
    return { ...base, valid: false, reason: "invalid_step_references", evidenceState: "invalid" };
  }
  const recomputed = bundleIntegrityHash({
    steps,
    schemaVersion: bundle.provenance.schemaVersion,
    pipelineConfig: bundle.provenance.pipelineConfig,
  });
  if (recomputed !== bundle.provenance?.bundleHash) {
    return {
      definitionHash: recomputed, valid: false,
      reason: "steps_do_not_match_the_declared_hash", evidenceState: "absent",
      provenanceState: "invalid",
    };
  }
  const ok: BundleVerification = {
    definitionHash: recomputed, valid: true, reason: "intact",
    evidenceState: "absent", provenanceState: "unsigned",
  };

  // The file's own signature is checked against the hash recomputed HERE, from
  // the steps in hand — so recomputing `provenance.bundleHash` to match an edit
  // defeats the checksum and nothing else.
  const benchmarkHash = bundle.benchmark
    ? createHash("sha256").update(stableJson(bundle.benchmark.files)).digest("hex")
    : null;
  if (bundle.attestation) {
    const pv = verifyBundleAttestation(bundle.attestation, {
      bundleHash: recomputed,
      benchmarkHash,
      definitionHash: bundle.provenance.definitionHash,
      manifestHash: bundle.evidence?.manifestHash ?? null,
      listingId: bundle.provenance.listingId,
      workflowVersionId: bundle.provenance.workflowVersionId,
      originCreatorId: bundle.provenance.originCreatorId,
    }, pinnedPlatformKeyPem);
    if (!pv.valid) {
      return {
        ...ok, valid: false, evidenceState: "invalid", provenanceState: "invalid",
        reason: `bundle_${pv.reason}`, fingerprint: pv.fingerprint, keyId: pv.keyId,
      };
    }
    ok.provenanceState = pv.signerPinned ? "signed" : "signer_unpinned";
    ok.fingerprint = pv.fingerprint;
    ok.keyId = pv.keyId;
  }

  if (!bundle.evidence) return { ...ok, evidenceState: "absent", reason: "intact_but_no_evidence_record" };
  const { manifestHash, manifestJson, attestation } = bundle.evidence;
  if (manifestJson === null) {
    return { ...ok, evidenceState: "absent", reason: "evidence_content_missing" };
  }
  if (createHash("sha256").update(manifestJson, "utf8").digest("hex") !== manifestHash) {
    return { ...ok, valid: false, evidenceState: "invalid", reason: "evidence_content_hash_mismatch" };
  }
  try {
    const identity = JSON.parse(manifestJson).versionIdentity;
    if (!identity || identity.listingId !== bundle.provenance.listingId ||
      identity.workflowVersionId !== bundle.provenance.workflowVersionId ||
      identity.definitionHash !== bundle.provenance.definitionHash) {
      return { ...ok, valid: false, evidenceState: "invalid", reason: "evidence_identity_mismatch" };
    }
  } catch {
    return { ...ok, valid: false, evidenceState: "invalid", reason: "evidence_content_invalid" };
  }
  if (!attestation) return { ...ok, evidenceState: "unsigned", reason: "intact_evidence_unsigned" };

  const verdict = verifyEvidenceAttestation(
    attestation,
    {
      manifestHash,
      listingId: bundle.provenance.listingId,
      workflowVersionId: bundle.provenance.workflowVersionId,
      definitionHash: bundle.provenance.definitionHash,
      authorId: bundle.provenance.originCreatorId,
    },
    pinnedPlatformKeyPem,
  );
  if (!verdict.valid) {
    return { ...ok, valid: false, evidenceState: "invalid", reason: `evidence_${verdict.reason}`, fingerprint: verdict.fingerprint, keyId: verdict.keyId };
  }
  if (ok.provenanceState === "unsigned") {
    return { ...ok, evidenceState: "unsigned", reason: "evidence_not_bound_to_shipped_pipeline" };
  }
  return {
    ...ok,
    evidenceState: verdict.signerPinned && ok.provenanceState === "signed" ? "verified" : "signer_unpinned",
    reason: verdict.signerPinned
      ? "intact_and_evidence_signed_by_the_pinned_platform_key"
      : "intact; signature valid against the key inside the file, which is not proof of who issued it",
    fingerprint: verdict.fingerprint,
    keyId: verdict.keyId,
  };
}
