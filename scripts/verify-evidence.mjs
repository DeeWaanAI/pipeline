#!/usr/bin/env node
// verify-evidence.mjs — check a DeeWaanAI evidence record on YOUR OWN machine.
//
// Why this exists as a separate file: the moment execution leaves the platform,
// evidence is an artifact a stranger re-checks. If the only way to check it is to
// ask the platform that issued it, the check proves nothing. So this runs on node
// with no database, no login, and no network.
//
// What "verified" means here, and what it does not:
//   · The signature covers the manifest hash AND the listing / workflow version /
//     definition hash / author. So a real signature cannot be moved onto a
//     different listing's evidence.
//   · The public key travels inside the record, because verification must not need
//     a server. That is CONVENIENCE, not trust: anyone can mint a key pair and
//     ship a self-consistent record. Trust comes from --pin (or --fingerprint):
//     you compare against a value you got from somewhere you already trust.
//   · Without a pin the answer is deliberately not PASS. It is UNPINNED, exit 3:
//     "not edited, signed by this key, now go confirm the key".
//
// Usage:
//   node scripts/verify-evidence.mjs <manifest.json> --hash <64-hex> [--pin <pubkey.pem> | --fingerprint <pairs>]
//
// Exit codes: 0 verified and signer pinned · 3 signature valid, signer unpinned ·
//             1 verification failed · 2 could not read the inputs.

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Canonical JSON: keys sorted recursively, arrays left in order.
 *
 * MUST MATCH `stableJson` in api/services/benchmark/versionService.ts, which is
 * what the server signs with. This is a deliberate second copy: the verifier runs
 * where the server's code cannot. Drift is not silent — a mismatch makes the
 * payload comparison fail and the tool reports INVALID, and
 * `evidenceSigning.test.ts` execs this file against a manifest the production
 * signer just produced, so a divergence fails a test rather than a buyer.
 */
export function canonicalize(value) {
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sortDeep(value));
}

export function fingerprintOf(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return hex.match(/.{1,4}/g).join(":");
}

/** Re-derive the bytes the signature must cover, from what the reader holds. */
export function payloadFor(attestation, expected) {
  return canonicalize({
    kind: attestation.kind,
    signer: attestation.signer,
    algorithm: attestation.algorithm,
    manifestHash: expected.manifestHash,
    hashExcludes: attestation.hashExcludes,
    listingId: expected.listingId,
    workflowVersionId: expected.workflowVersionId,
    definitionHash: expected.definitionHash,
    authorId: expected.authorId,
    issuedAt: attestation.issuedAt,
    keyId: attestation.keyId,
  });
}

export function verify({ manifest, attestation, manifestHash, pinnedPem = null, pinnedFingerprint = null }) {
  const identity = attestation.identity ?? {};
  const version = manifest?.versionIdentity ?? {};

  // Cross-check the attestation against the manifest it claims to describe, so a
  // record carrying two different stories is refused before any crypto is tried.
  for (const [a, m] of [["listingId", version.listingId], ["workflowVersionId", version.workflowVersionId], ["definitionHash", version.definitionHash]]) {
    if (m !== undefined && a in identity && identity[a] !== null && String(identity[a]) !== String(m)) {
      return { code: 1, verdict: "INVALID", reason: `attestation.${a} disagrees with the manifest's versionIdentity` };
    }
  }
  if (attestation.manifestHash !== manifestHash) {
    return { code: 1, verdict: "INVALID", reason: "attestation names a different manifest hash than the one you supplied" };
  }

  const expectedIdentity = {
    manifestHash,
    listingId: identity.listingId ?? null,
    workflowVersionId: identity.workflowVersionId ?? null,
    definitionHash: identity.definitionHash ?? null,
    authorId: identity.authorId,
  };
  if (payloadFor(attestation, expectedIdentity) !== attestation.signedPayload) {
    return { code: 1, verdict: "INVALID", reason: "the signed bytes do not describe this artifact (edited, or moved from another record)" };
  }

  let presented;
  try {
    presented = createPublicKey(attestation.publicKeyPem);
  } catch {
    return { code: 1, verdict: "INVALID", reason: "the record's public key is not readable" };
  }
  const fingerprint = fingerprintOf(attestation.publicKeyPem);

  if (pinnedPem || pinnedFingerprint) {
    let matches = false;
    try {
      if (pinnedPem) {
        matches = createPublicKey(pinnedPem).export({ type: "spki", format: "der" }).toString("hex")
          === presented.export({ type: "spki", format: "der" }).toString("hex");
      } else {
        matches = fingerprint === pinnedFingerprint.toLowerCase();
      }
    } catch {
      return { code: 2, verdict: "INPUT ERROR", reason: "the pinned key you supplied is not a readable public key" };
    }
    if (!matches) {
      return { code: 1, verdict: "INVALID", reason: `signed by a key that is NOT the one you pinned (presented ${fingerprint})` };
    }
  }

  let ok = false;
  try {
    ok = edVerify(null, Buffer.from(attestation.signedPayload, "utf8"), presented, Buffer.from(attestation.signature, "base64"));
  } catch (err) {
    return { code: 1, verdict: "INVALID", reason: `signature could not be checked: ${err.message}` };
  }
  if (!ok) return { code: 1, verdict: "INVALID", reason: "signature does not verify" };

  if (!pinnedPem && !pinnedFingerprint) {
    return {
      code: 3,
      verdict: "UNPINNED",
      reason: "unedited since it was signed, and signed by a key that matches it — but nothing here tells you the key is DeeWaanAI's",
      fingerprint,
      keyId: attestation.keyId,
    };
  }
  return { code: 0, verdict: "VERIFIED", reason: "signed by the key you pinned, and bound to this exact artifact", fingerprint, keyId: attestation.keyId };
}

// ─── CLI ────────────────────────────────────────────────────────────
const main = async () => {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1];
  };

  const file = positional[0];
  const manifestHash = flag("hash");
  if (!file || !manifestHash) {
    console.error("usage: node scripts/verify-evidence.mjs <manifest.json> --hash <64-hex> [--pin <pubkey.pem> | --fingerprint <aaaa:bbbb:...>]");
    process.exit(2);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`cannot read ${file}: ${err.message}`);
    process.exit(2);
  }
  const attestation = raw.attestation ?? raw;
  if (!attestation?.signature || !attestation?.publicKeyPem) {
    console.log("UNSIGNED — this evidence carries no attestation. It may be genuine; nothing here can tell you, and no signature can be checked.");
    process.exit(1);
  }

  let pinnedPem = null;
  const pinArg = flag("pin");
  if (pinArg) {
    try {
      pinnedPem = pinArg.includes("-----BEGIN") ? pinArg : readFileSync(pinArg, "utf8");
    } catch (err) {
      console.error(`cannot read --pin ${pinArg}: ${err.message}`);
      process.exit(2);
    }
  }

  const result = verify({
    manifest: raw.attestation ? raw : {},
    attestation,
    manifestHash: manifestHash.trim(),
    pinnedPem,
    pinnedFingerprint: flag("fingerprint"),
  });

  console.log(`${result.verdict} · key ${result.keyId ?? "?"} · ${result.reason}`);
  if (result.fingerprint) console.log(`  fingerprint: ${result.fingerprint}`);
  console.log(`  identity: listing ${attestation.identity?.listingId ?? "—"}, version ${attestation.identity?.workflowVersionId ?? "—"}, author ${attestation.identity?.authorId ?? "—"}`);
  console.log(`  definition hash: ${attestation.identity?.definitionHash ?? "—"}`);
  if (result.code === 3) console.log("  → to get VERIFIED, pass --pin or --fingerprint with the platform key from a channel you already trust.");
  process.exit(result.code);
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) await main();
