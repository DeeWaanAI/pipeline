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
import { stableJson } from "./benchmark/versionService";
import { verifyEvidenceAttestation, type EvidenceAttestation } from "./evidenceSigning";

export const PIPELINE_BUNDLE_KIND = "deewaanai-pipeline-bundle-v1";

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
    attestation: EvidenceAttestation | null;
  } | null;
  note: string;
}

export interface BundleVerification {
  valid: boolean;
  reason: string;
  definitionHash: string;
  /** Whether the benchmark claim on this file can be trusted, separately from
   *  whether the file is intact. `unsigned` means intact and unproven. */
  evidenceState: "verified" | "unsigned" | "invalid" | "absent" | "signer_unpinned";
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
  attestation: EvidenceAttestation | null;
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
      ? { manifestHash: args.manifestHash, attestation: args.attestation }
      : null,
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
  const base = { definitionHash: "" };
  if (!bundle || bundle.kind !== PIPELINE_BUNDLE_KIND) {
    return { ...base, valid: false, reason: "not_a_pipeline_bundle", evidenceState: "absent" };
  }
  const steps = bundle.pipeline?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ...base, valid: false, reason: "no_steps", evidenceState: "absent" };
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
    };
  }
  const ok: BundleVerification = {
    definitionHash: recomputed, valid: true, reason: "intact", evidenceState: "absent",
  };

  if (!bundle.evidence) return { ...ok, evidenceState: "absent", reason: "intact_but_no_evidence_record" };
  const { manifestHash, attestation } = bundle.evidence;
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
  return {
    ...ok,
    evidenceState: verdict.signerPinned ? "verified" : "signer_unpinned",
    reason: verdict.signerPinned
      ? "intact_and_evidence_signed_by_the_pinned_platform_key"
      : "intact; signature valid against the key inside the file, which is not proof of who issued it",
    fingerprint: verdict.fingerprint,
    keyId: verdict.keyId,
  };
}
