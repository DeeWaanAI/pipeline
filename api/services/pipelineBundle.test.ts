// The bundle is the artifact that leaves the platform, so its two refusals are
// the whole trust story for sharing: the steps must hash to what the file
// declares, and the evidence signature must be about THIS file. Both are tested
// against bundles built by the production builders, not hand-written JSON.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

let bundle: typeof import("./pipelineBundle");
let signing: typeof import("./evidenceSigning");

const key = generateKeyPairSync("ed25519");
const PUBLIC_PEM = key.publicKey.export({ type: "spki", format: "pem" }).toString();
const MANIFEST_HASH = "a".repeat(64);

const STEPS = [
  {
    stepOrder: 1, name: "Draft", role: "builder", systemPrompt: "draft the clause",
    stepType: "agent", model: "generator-model", temperature: "0.7", maxTokens: 1024,
    ifConfig: null, whileConfig: null,
  },
  {
    stepOrder: 2, name: "Review", role: "polisher", systemPrompt: "tighten it",
    stepType: "agent", model: "generator-model", temperature: "0.3", maxTokens: 512,
    ifConfig: null, whileConfig: null,
  },
];

const PROVENANCE = {
  pipelineName: "Contract Redliner",
  pipelineDescription: "redlines an agreement",
  listingId: 41,
  workflowVersionId: 7,
  originCreatorId: 900,
  originAccountName: "author",
  workflowVersionNumber: 3,
};

const VERSION_HASH = "c".repeat(64);

async function makeBundle(over: { attestation?: unknown | null; manifestHash?: string | null } = {}) {
  const shape = { steps: STEPS, schemaVersion: 1, pipelineConfig: null };
  const bundleHash = bundle.bundleIntegrityHash(shape);
  const attestation = over?.attestation === undefined
    ? signing.attestEvidenceManifest({
      manifestHash: over.manifestHash ?? MANIFEST_HASH,
      listingId: PROVENANCE.listingId,
      workflowVersionId: PROVENANCE.workflowVersionId,
      definitionHash: VERSION_HASH,
      authorId: PROVENANCE.originCreatorId,
    })
    : over.attestation;
  return bundle.buildPipelineBundle({
    ...PROVENANCE,
    ...shape,
    definitionHash: VERSION_HASH,
    bundleHash,
    manifestHash: over.manifestHash === undefined ? MANIFEST_HASH : over.manifestHash,
    attestation: attestation as never,
  });
}

beforeAll(async () => {
  vi.resetModules();
  process.env.EVIDENCE_SIGNING_PRIVATE_KEY = key.privateKey
    .export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n");
  process.env.EVIDENCE_SIGNING_KEY_ID = "bundle-test-key";
  signing = await import("./evidenceSigning");
  bundle = await import("./pipelineBundle");
});

describe("pipeline bundle", () => {
  it("round-trips: a bundle the builders made verifies against the pinned key", async () => {
    const b = await makeBundle();
    const v = bundle.verifyPipelineBundle(b, PUBLIC_PEM);
    expect(v.valid).toBe(true);
    expect(v.evidenceState).toBe("verified");
    expect(v.definitionHash).toBe(b.provenance.bundleHash);
    // Nothing in a shared file may carry the author's database wiring.
    const text = JSON.stringify(b);
    for (const forbidden of ["providerId", "agentId", '"projectId"', '"userId"', '"id":']) {
      expect(text.includes(forbidden), text.slice(0, 80)).toBe(false);
    }
  });

  it("refuses a bundle whose steps were edited after it was written", async () => {
    const b = await makeBundle();
    const tampered = { ...b, pipeline: { ...b.pipeline, steps: [{ ...b.pipeline.steps[0], systemPrompt: "EVIL PROMPT" }, ...b.pipeline.steps.slice(1)] } };
    const v = bundle.verifyPipelineBundle(tampered, PUBLIC_PEM);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("steps_do_not_match_the_declared_hash");
    // And the hash it reports is the one the EDITED steps produce, so a client can
    // tell the user which build they are actually holding.
    expect(v.definitionHash).not.toBe(b.provenance.bundleHash);
  });

  it("refuses an attestation moved from another pipeline's bundle", async () => {
    const other = await makeBundle();
    const target = await makeBundle();
    const swapped = {
      ...target,
      provenance: { ...target.provenance, listingId: 999 },
    };
    const v = bundle.verifyPipelineBundle(swapped, PUBLIC_PEM);
    expect(v.valid).toBe(false);
    expect(v.evidenceState).toBe("invalid");
    expect(v.reason).toContain("attestation_does_not_describe_this_artifact");
    expect(other.provenance.listingId).toBe(41);
  });

  it("an unsigned bundle is reported as unsigned, not as valid evidence", async () => {
    const b = await makeBundle({ attestation: null });
    const v = bundle.verifyPipelineBundle(b, PUBLIC_PEM);
    expect(v.valid).toBe(true);          // the work itself is intact
    expect(v.evidenceState).toBe("unsigned");
    expect(v.reason).toBe("intact_evidence_unsigned");
  });

  it("a bundle with no evidence record says so", async () => {
    const b = await makeBundle({ manifestHash: null });
    expect(b.evidence).toBeNull();
    const v = bundle.verifyPipelineBundle(b, PUBLIC_PEM);
    expect(v.valid).toBe(true);
    expect(v.evidenceState).toBe("absent");
  });

  it("without a pinned key the answer is not VERIFIED", async () => {
    const b = await makeBundle();
    const v = bundle.verifyPipelineBundle(b);
    expect(v.valid).toBe(true);
    expect(v.evidenceState).toBe("signer_unpinned");
    expect(v.reason).toContain("not proof of who issued it");
    expect(v.fingerprint).toBeTruthy();
  });

  it("a foreign key pair, self-consistent, fails once the platform key is pinned", async () => {
    const attacker = generateKeyPairSync("ed25519");
    vi.resetModules();
    process.env.EVIDENCE_SIGNING_PRIVATE_KEY = attacker.privateKey
      .export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n");
    const forgedSigning = await import("./evidenceSigning");
    const shape = { steps: STEPS, schemaVersion: 1, pipelineConfig: null };
    const attestation = forgedSigning.attestEvidenceManifest({
      manifestHash: MANIFEST_HASH, listingId: PROVENANCE.listingId,
      workflowVersionId: PROVENANCE.workflowVersionId, definitionHash: VERSION_HASH,
      authorId: PROVENANCE.originCreatorId,
    })!;
    const forged = bundle.buildPipelineBundle({
      ...PROVENANCE, ...shape, definitionHash: VERSION_HASH,
      bundleHash: bundle.bundleIntegrityHash(shape), manifestHash: MANIFEST_HASH, attestation,
    });
    expect(bundle.verifyPipelineBundle(forged).evidenceState).toBe("signer_unpinned");
    const checked = bundle.verifyPipelineBundle(forged, PUBLIC_PEM);
    expect(checked.valid).toBe(false);
    expect(checked.reason).toContain("signer_key_not_the_pinned_platform_key");
  });

  it("rejects anything that is not a pipeline bundle", () => {
    expect(bundle.verifyPipelineBundle({ kind: "other" } as never).reason).toBe("not_a_pipeline_bundle");
    expect(bundle.verifyPipelineBundle({
      kind: "deewaanai-pipeline-bundle-v1", pipeline: { name: "x", description: null, steps: [] },
    } as never).reason).toBe("no_steps");
  });
});
