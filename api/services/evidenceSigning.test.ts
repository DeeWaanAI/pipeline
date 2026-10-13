// Evidence attestation — the crypto contract, no database.
//
// The claim under test is the one Class A rests on: a signature proves WHO issued a
// record, and it must not be movable. A SHA-256 already proved the file was not
// edited after writing — that was never provenance. And every other signature in
// this repo is symmetric (HMAC in auditExport, HS256 in tokenService), which cannot
// attest anything to a stranger: whoever can verify it can also forge it.
//
// `env` is read once, at module load, so a case that needs a different key must
// re-import the module rather than poke process.env. That is what `loadWith` is,
// and it is also how a real deployment behaves: you set the key and restart.
//
// Each failure below is a DIFFERENT attack, so the expected reason string is
// asserted rather than just "false" — a test that cannot tell "moved to another
// listing" from "signature edited" is not testing anything.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Signing = typeof import("./evidenceSigning");

const MANIFEST_HASH = "a".repeat(64);
const IDENTITY = {
  listingId: 41,
  workflowVersionId: 7,
  definitionHash: "b".repeat(64),
  authorId: 900,
};

const keyA = generateKeyPairSync("ed25519");
const PEM_A = keyA.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUB_A = keyA.publicKey.export({ type: "spki", format: "pem" }).toString();
const keyB = generateKeyPairSync("ed25519");
const PEM_B = keyB.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUB_B = keyB.publicKey.export({ type: "spki", format: "pem" }).toString();

/** The PEM with real newlines, or escaped, or base64 of it — hosts disagree. */
const asEscaped = (pem: string) => pem.replace(/\n/g, "\\n");

async function loadWith(privateKey: string | null, keyId = "unit-test-key-1"): Promise<Signing> {
  vi.resetModules();
  if (privateKey === null) delete process.env.EVIDENCE_SIGNING_PRIVATE_KEY;
  else process.env.EVIDENCE_SIGNING_PRIVATE_KEY = privateKey;
  process.env.EVIDENCE_SIGNING_KEY_ID = keyId;
  return await import("./evidenceSigning");
}

let m: Signing;
beforeEach(async () => { m = await loadWith(asEscaped(PEM_A)); });

const attest = (mod = m) => mod.attestEvidenceManifest({ manifestHash: MANIFEST_HASH, ...IDENTITY });
const asExpected = (over: Partial<typeof IDENTITY> = {}) => ({ manifestHash: MANIFEST_HASH, ...IDENTITY, ...over });

const expectReason = (
  attestation: NonNullable<ReturnType<Signing["attestEvidenceManifest"]>>,
  expected: Parameters<Signing["verifyEvidenceAttestation"]>[1],
  pinned: string | undefined,
  reason: string,
) => {
  const verdict = m.verifyEvidenceAttestation(attestation, expected, pinned);
  expect(verdict.valid, reason).toBe(false);
  expect(verdict.reason).toBe(reason);
};

describe("evidence attestation (pure crypto, no database)", () => {
  it("signs a manifest, and the signature covers the identity as well as the hash", () => {
    const att = attest()!;
    expect(att.keyId).toBe("unit-test-key-1");
    expect(att.algorithm).toBe("ed25519");
    expect(att.hashExcludes).toEqual(["attestation"]);
    expect(att.identity).toEqual(IDENTITY);

    const verdict = m.verifyEvidenceAttestation(att, asExpected(), PUB_A);
    expect(verdict.valid).toBe(true);
    expect(verdict.signerPinned).toBe(true);
    expect(verdict.reason).toContain("pinned_platform_key");
    expect(verdict.fingerprint).toBe(m.publicKeyFingerprint(PUB_A));
  });

  it("the public half is derivable, and the private half never appears in any output", () => {
    expect(m.signingKeyConfigured()).toBe(true);
    expect(m.signingPublicKeyPem()).toBe(PUB_A);
    const att = attest()!;
    expect(att.publicKeyPem).toBe(PUB_A);
    expect(JSON.stringify(att)).not.toContain("PRIVATE KEY");
  });

  it("refuses a signature pasted onto ANOTHER LISTING's evidence", () => {
    // The reason the identity is inside the signed bytes rather than beside them:
    // sign the hash alone and one valid signature serves every listing in the
    // marketplace.
    expectReason(attest()!, asExpected({ listingId: 999 }), PUB_A, "attestation_does_not_describe_this_artifact");
  });

  it("refuses a different workflow version, definition hash, or author — each on its own", () => {
    const att = attest()!;
    for (const over of [{ workflowVersionId: 8 }, { definitionHash: "c".repeat(64) }, { authorId: 901 }]) {
      expectReason(att, asExpected(over), PUB_A, "attestation_does_not_describe_this_artifact");
    }
  });

  it("refuses a reader holding different bytes than the attestation names", () => {
    // Distinct signal from a moved identity: here the record is intact and the
    // artifact is not.
    expectReason(attest()!, { ...asExpected(), manifestHash: "d".repeat(64) }, PUB_A, "manifest_hash_mismatch");
  });

  it("refuses an edited signature, and says something different from a moved one", () => {
    const att = attest()!;
    expectReason(
      { ...att, signature: Buffer.from("not a signature").toString("base64") },
      asExpected(), PUB_A, "signature_invalid",
    );
  });

  it("without a pin the answer is honest: not edited, but WHO signed it is unconfirmed", () => {
    const verdict = m.verifyEvidenceAttestation(attest()!, asExpected());
    expect(verdict.valid).toBe(true);
    expect(verdict.signerPinned).toBe(false);
    expect(verdict.reason).toContain("signer_unverified");
    expect(verdict.fingerprint).toMatch(/^[0-9a-f]{4}(:[0-9a-f]{4}){7}$/);
  });

  it("a foreign key pair, self-consistent in every way, is refused once you pin", async () => {
    // This is the whole reason pinning exists: substitution is invisible to the
    // crypto, so "verified" without a pin would be the dishonest answer.
    const attacker = await loadWith(asEscaped(PEM_B), "attacker-key");
    const forged = attacker.attestEvidenceManifest({ manifestHash: MANIFEST_HASH, ...IDENTITY })!;
    expect(forged.publicKeyPem).toBe(PUB_B);
    expect(forged.publicKeyPem).not.toBe(PUB_A);

    expect(attacker.verifyEvidenceAttestation(forged, asExpected()).valid).toBe(true);
    expect(attacker.verifyEvidenceAttestation(forged, asExpected(), PUB_A).valid).toBe(false);
    expect(attacker.verifyEvidenceAttestation(forged, asExpected(), PUB_A).reason)
      .toBe("signer_key_not_the_pinned_platform_key");
  });

  it("no key configured: publication is not broken, and there is simply no attestation", async () => {
    // No key exists in any .env today, by owner policy. Refusing to publish would
    // take the evidence product down over configuration; faking one would be a lie.
    const none = await loadWith(null);
    expect(none.signingKeyConfigured()).toBe(false);
    expect(none.attestEvidenceManifest({ manifestHash: MANIFEST_HASH, ...IDENTITY })).toBeNull();
    expect(none.signingPublicKeyPem()).toBeNull();
  });

  it("a key present but unreadable declines loudly instead of throwing at publish time", async () => {
    const broken = await loadWith("definitely-not-a-pem");
    expect(broken.signingKeyConfigured()).toBe(true);
    expect(broken.signingPublicKeyPem()).toBeNull();
    expect(broken.attestEvidenceManifest({ manifestHash: MANIFEST_HASH, ...IDENTITY })).toBeNull();
  });

  it("accepts base64 of the PEM as well as an escaped PEM", async () => {
    const b64 = await loadWith(Buffer.from(PEM_A).toString("base64"));
    const att = b64.attestEvidenceManifest({ manifestHash: MANIFEST_HASH, ...IDENTITY })!;
    expect(b64.verifyEvidenceAttestation(att, asExpected(), PUB_A).valid).toBe(true);
  });

  it("a mislabelled key id is caught by the pin, not by the label", async () => {
    // `signing_key_id` exists so an operator can query for evidence signed under a
    // retired key. It is a label for the database, never the basis of trust —
    // changing it breaks the signed bytes, which is the point.
    const att = attest()!;
    expectReason({ ...att, keyId: "some-other-key" }, asExpected(), PUB_A, "attestation_does_not_describe_this_artifact");
  });

  it("the OFFLINE verifier a buyer runs agrees with the server's own verifier", async () => {
    // scripts/verify-evidence.mjs carries a SECOND copy of the canonical
    // serialization because it must run where server code cannot — no env, no
    // database, no network. Two implementations of one rule will drift unless
    // something forces them to agree, so this execs the real script against a
    // manifest the production signer just produced and checks all three verdicts.
    const dir = mkdtempSync(join(tmpdir(), "evidence-verify-"));
    const manifestFile = join(dir, "manifest.json");
    writeFileSync(manifestFile, JSON.stringify({
      schemaVersion: 1,
      versionIdentity: {
        listingId: IDENTITY.listingId,
        workflowVersionId: IDENTITY.workflowVersionId,
        definitionHash: IDENTITY.definitionHash,
      },
      attestation: attest()!,
    }, null, 2));
    const pinFile = join(dir, "platform.pem");
    writeFileSync(pinFile, PUB_A);

    const code = (extra: string[]) => {
      try {
        execFileSync("node", ["scripts/verify-evidence.mjs", manifestFile, "--hash", MANIFEST_HASH, ...extra], { stdio: "pipe" });
        return 0;
      } catch (err) {
        return (err as { status?: number }).status ?? -1;
      }
    };

    expect(code(["--pin", pinFile])).toBe(0);   // VERIFIED — pinned, bound to this artifact
    expect(code([])).toBe(3);                   // UNPINNED — signature fine, issuer unconfirmed
    expect(code(["--fingerprint", "0000:0000:0000:0000:0000:0000:0000:0000"])).toBe(1); // wrong pin
  });
});
