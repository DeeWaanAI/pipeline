#!/usr/bin/env node
// Verify the signed evidence in these examples, offline.
//
// What this checks, for each example folder:
//   1. The manifest body (everything except `attestation`) hashes to the
//      `manifestHash` the attestation claims — so the file was not edited after
//      signing.
//   2. The Ed25519 signature verifies against the public key carried inside the
//      attestation.
//   3. The signed payload's identity (listing, version, definition hash) matches
//      the identity written in the manifest.
//
// It does NOT prove the key is DeeWaanAI's: the key travels inside the file, so a
// forger can ship a self-consistent record. Pass a pinned key to check that too:
//   node verify-examples.mjs --pin platform.pub
// (The fingerprint printed for each key is what you compare against a published
// value. Same rule as `scripts/verify-evidence.mjs` in the main repo.)
//
// Usage: node verify-examples.mjs [--pin <public-key.pem>]

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Canonical JSON: keys sorted at every depth, as the platform signs it. */
function canonical(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

const args = process.argv.slice(2);
const pinIndex = args.indexOf("--pin");
const pinnedPem = pinIndex >= 0 ? readFileSync(args[pinIndex + 1], "utf8") : null;
const fingerprint = (pem) => {
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 32).match(/.{1,4}/g).join(":");
};

let failures = 0;
for (const entry of readdirSync(here, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = join(here, entry.name, "evidence.manifest.json");
  if (!existsSync(file)) continue;

  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const attestation = manifest.attestation;
  const fail = (why) => { failures++; console.log(`✗ ${entry.name}: ${why}`); };
  if (!attestation) { fail("no attestation"); continue; }

  const body = Object.fromEntries(Object.entries(manifest).filter(([k]) => k !== "attestation"));
  const bodyHash = createHash("sha256").update(canonical(body)).digest("hex");
  if (bodyHash !== attestation.manifestHash) { fail(`body hash ${bodyHash.slice(0, 12)} ≠ claimed ${attestation.manifestHash.slice(0, 12)}`); continue; }
  if (attestation.signedPayload?.includes(attestation.manifestHash) !== true) { fail("signed payload does not name this manifest hash"); continue; }

  let signed;
  try { signed = JSON.parse(attestation.signedPayload); } catch { fail("signedPayload is not JSON"); continue; }
  const identity = manifest.versionIdentity ?? {};
  if (signed.definitionHash !== identity.definitionHash || signed.workflowVersionId !== identity.workflowVersionId) {
    fail("signed identity does not match the manifest's versionIdentity"); continue;
  }

  const presented = createPublicKey(attestation.publicKeyPem);
  if (pinnedPem) {
    const a = createPublicKey(pinnedPem).export({ type: "spki", format: "der" }).toString("hex");
    const b = presented.export({ type: "spki", format: "der" }).toString("hex");
    if (a !== b) { fail("signed by a key that is not the pinned platform key"); continue; }
  }
  const ok = edVerify(null, Buffer.from(attestation.signedPayload, "utf8"), presented,
    Buffer.from(attestation.signature, "base64"));
  if (!ok) { fail("signature does not verify"); continue; }
  console.log(`✓ ${entry.name}: intact, signed by ${attestation.keyId} (${fingerprint(attestation.publicKeyPem)})${pinnedPem ? ", key pinned" : ""}`);
}

if (failures) { console.log(`\n${failures} example(s) failed verification`); process.exit(1); }
console.log("\nAll examples verified.");
