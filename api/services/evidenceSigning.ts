// ═══════════════════════════════════════════════════════════════════
//  EVIDENCE ATTESTATION — provenance, not just integrity (v3)
// ═══════════════════════════════════════════════════════════════════
// A SHA-256 over an archive proves nobody edited it after it was written. It says
// nothing about who wrote it — which is the exact hole the Class A decision
// cannot live with, because the marketplace no longer observes the run: evidence
// becomes an artifact a stranger re-checks on their own machine.
//
// So this signs with an asymmetric key. Every signature already in this repo is
// symmetric (HMAC in auditExport, HS256 in tokenService), and a symmetric scheme
// cannot attest anything to a third party: anyone who can verify it can also
// forge it.
//
// What is signed is deliberately small and deliberately specific: the manifest
// hash PLUS the listing, workflow version, definition hash and author it belongs
// to. Signing the hash alone would let one valid signature be pasted onto a
// different listing's evidence and still verify.
//
// Key handling, because there are no users to hurt yet and no key to lose:
//  · The private key comes from env only. It is never stored, never logged, and
//    never read into a database row.
//  · When it is absent, publication still works and the record is labelled
//    `unsigned`. A silently unsigned evidence page would be the dishonest
//    option; a loud one is not.
//  · The public key travels inside the attestation so verification needs no
//    server. That is convenience, NOT trust: a forger can substitute their own
//    key pair. Trust comes from the reader PINNING the platform fingerprint and
//    refusing a mismatch — which is why `verify` reports the fingerprint either
//    way, and returns a distinct reason when a pin is not matched.

import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { stableJson } from "./benchmark/versionService";

export const EVIDENCE_ATTESTATION_KIND = "deewaanai-evidence-attestation-v1";
export const EVIDENCE_SIGNER_PLATFORM = "platform";
export const EVIDENCE_ALGORITHM_ED25519 = "ed25519";
/** The manifest hash covers the evidence, not the statement made about it. Any
 *  verifier that silently used a different rule would accept a different artifact,
 *  so the rule lives here and inside the signed bytes — nowhere else. */
export const EVIDENCE_HASH_EXCLUDES = ["attestation"];

/** What a reader needs to re-derive the signed bytes, in the manifest. */
export interface EvidenceAttestation {
  kind: string;
  signer: string;
  algorithm: string;
  keyId: string;
  issuedAt: string;
  manifestHash: string;
  /** Which members are NOT part of the hashed content. Pinned INSIDE the signed
   *  bytes, so a reader cannot be talked into a different hash rule. */
  hashExcludes: string[];
  identity: {
    listingId: number | null;
    workflowVersionId: number | null;
    definitionHash: string | null;
    authorId: number;
  };
  /** The exact canonical bytes the signature covers. Kept in the record so a
   *  verifier re-derives them from what IT has and compares, rather than trusting
   *  this field to have been produced honestly. */
  signedPayload: string;
  signature: string; // base64
  publicKeyPem: string;
}

export interface VerifyResult {
  valid: boolean;
  reason: string;
  keyId: string;
  /** First bytes of the SHA-256 of the presented public key, in pairs — the thing
   *  a buyer compares against a published fingerprint. */
  fingerprint: string;
  signerPinned: boolean;
}

/** PEM with escaped newlines, or base64 of the PEM. Env cannot hold a raw PEM. */
function decodePrivateKey(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed.replace(/\\n/g, "\n");
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    return decoded.includes("-----BEGIN") ? decoded : null;
  } catch {
    return null;
  }
}

export function signingKeyConfigured(): boolean {
  return env.evidenceSigningPrivateKey.length > 0;
}

export function signingKeyId(): string {
  return env.evidenceSigningKeyId;
}

/** The public half of the configured signing key, or null when unconfigured. */
export function signingPublicKeyPem(): string | null {
  const pem = decodePrivateKey(env.evidenceSigningPrivateKey);
  if (!pem) return null;
  try {
    return createPublicKey(createPrivateKey({ key: pem, format: "pem" })).export({ type: "spki", format: "pem" }).toString();
  } catch (err) {
    logger.error("Evidence signing key is present but unreadable", { error: (err as Error).message });
    return null;
  }
}

/** Human-comparable fingerprint of a public key — what to publish for pinning. */
export function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return (hex.match(/.{1,4}/g) ?? []).join(":");
}

/** The canonical bytes a signature must cover. Built from the identity the reader
 *  presents, never from the attestation being checked. */
export function attestationPayload(opts: {
  manifestHash: string;
  listingId: number | null;
  workflowVersionId: number | null;
  definitionHash: string | null;
  authorId: number;
  issuedAt: string;
  keyId: string;
}): string {
  return stableJson({
    kind: EVIDENCE_ATTESTATION_KIND,
    signer: EVIDENCE_SIGNER_PLATFORM,
    algorithm: EVIDENCE_ALGORITHM_ED25519,
    manifestHash: opts.manifestHash,
    hashExcludes: EVIDENCE_HASH_EXCLUDES,
    listingId: opts.listingId,
    workflowVersionId: opts.workflowVersionId,
    definitionHash: opts.definitionHash,
    authorId: opts.authorId,
    issuedAt: opts.issuedAt,
    keyId: opts.keyId,
  });
}

/**
 * Sign one published manifest. Returns null when no key is configured — the
 * caller must then label the record unsigned rather than pretend.
 */
export function attestEvidenceManifest(opts: {
  manifestHash: string;
  listingId: number | null;
  workflowVersionId: number | null;
  definitionHash: string | null;
  authorId: number;
  issuedAt?: Date;
}): EvidenceAttestation | null {
  const pem = decodePrivateKey(env.evidenceSigningPrivateKey);
  if (!pem) return null;
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: pem, format: "pem" });
  } catch (err) {
    logger.error("Refusing to publish signed evidence: signing key unreadable", { error: (err as Error).message });
    return null;
  }
  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const keyId = signingKeyId();
  const issuedAt = (opts.issuedAt ?? new Date()).toISOString();
  const signedPayload = attestationPayload({ ...opts, issuedAt, keyId });
  const signature = edSign(null, Buffer.from(signedPayload, "utf8"), privateKey).toString("base64");

  return {
    kind: EVIDENCE_ATTESTATION_KIND,
    signer: EVIDENCE_SIGNER_PLATFORM,
    algorithm: EVIDENCE_ALGORITHM_ED25519,
    keyId,
    issuedAt,
    manifestHash: opts.manifestHash,
    hashExcludes: EVIDENCE_HASH_EXCLUDES,
    identity: {
      listingId: opts.listingId,
      workflowVersionId: opts.workflowVersionId,
      definitionHash: opts.definitionHash,
      authorId: opts.authorId,
    },
    signedPayload,
    signature,
    publicKeyPem,
  };
}

/**
 * Verify an attestation against the artifact the reader actually holds.
 * `pinnedPublicKeyPem` is optional but decisive: without it the answer is
 * "internally consistent, signed by key X — now go confirm X out of band".
 */
export function verifyEvidenceAttestation(
  attestation: EvidenceAttestation,
  expected: {
    manifestHash: string;
    listingId: number | null;
    workflowVersionId: number | null;
    definitionHash: string | null;
    authorId: number;
  },
  pinnedPublicKeyPem?: string,
): VerifyResult {
  const fingerprint = (() => {
    try {
      return publicKeyFingerprint(attestation.publicKeyPem);
    } catch {
      return "unreadable-public-key";
    }
  })();
  const fail = (reason: string): VerifyResult => ({
    valid: false, reason, keyId: attestation?.keyId ?? "unknown", fingerprint, signerPinned: false,
  });

  if (!attestation || typeof attestation !== "object") return fail("no_attestation");
  if (attestation.algorithm !== EVIDENCE_ALGORITHM_ED25519) return fail(`unknown_algorithm:${attestation.algorithm}`);

  // 1a. The hash the reader holds must be the hash the record was issued for.
  // Checked BEFORE the payload comparison so the reason a reader sees is "you are
  // holding different bytes", not the vaguer "this does not describe the artifact"
  // the payload check would also produce. Ordering matches scripts/verify-evidence.mjs,
  // which must not disagree with the server about what failed.
  if (attestation.manifestHash !== expected.manifestHash) return fail("manifest_hash_mismatch");

  // 1b. The signed bytes must describe the identity in hand, not itself.
  const recomputed = attestationPayload({
    manifestHash: expected.manifestHash,
    listingId: expected.listingId,
    workflowVersionId: expected.workflowVersionId,
    definitionHash: expected.definitionHash,
    authorId: expected.authorId,
    issuedAt: attestation.issuedAt,
    keyId: attestation.keyId,
  });
  if (recomputed !== attestation.signedPayload) {
    return fail("attestation_does_not_describe_this_artifact");
  }

  // 2. The pin decides WHO, before the crypto decides WHETHER IT WAS EDITED.
  if (pinnedPublicKeyPem) {
    try {
      const a = createPublicKey(pinnedPublicKeyPem).export({ type: "spki", format: "der" }).toString("hex");
      const b = createPublicKey(attestation.publicKeyPem).export({ type: "spki", format: "der" }).toString("hex");
      if (a !== b) return { ...fail("signer_key_not_the_pinned_platform_key"), fingerprint };
    } catch {
      return fail("pinned_key_unreadable");
    }
  }

  // 3. Signature over the canonical bytes.
  try {
    const ok = edVerify(
      null,
      Buffer.from(attestation.signedPayload, "utf8"),
      createPublicKey(attestation.publicKeyPem),
      Buffer.from(attestation.signature, "base64"),
    );
    if (!ok) return fail("signature_invalid");
  } catch (err) {
    return fail(`verify_threw:${(err as Error).message}`);
  }

  return {
    valid: true,
    reason: pinnedPublicKeyPem
      ? "signed_by_the_pinned_platform_key_and_matches_this_artifact"
      : "signature_valid_but_signer_unverified_no_pinned_key",
    keyId: attestation.keyId,
    fingerprint,
    signerPinned: Boolean(pinnedPublicKeyPem),
  };
}
