import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const dbAccess = vi.hoisted(() => vi.fn(() => { throw new Error("Unexpected database access"); }));
vi.mock("../queries/connection", () => ({ getDb: dbAccess }));

import {
  EXTERNAL_CONSENT_VERSION, previewExternalInputSchema, reportExternalInputSchema,
  getExternalInputSchema, listExternalInputSchema, withdrawExternalInputSchema,
  previewExternal, reportExternal, getExternal, listExternal,
} from "./externalEvidenceService";
import { EXTERNAL_EVIDENCE_TOOLS } from "../mcp/tools/externalEvidenceTools";
import { communityEvidenceRouter, evidenceRouter } from "../routers/evidence";

const valid = {
  listingId: 1, declaredInputs: "input", declaredOutputs: "output", consentVersion: EXTERNAL_CONSENT_VERSION,
} as const;

const malformed = [
  null, [], "report", {},
  { ...valid, listingId: "1" }, { ...valid, listingId: 0 },
  { ...valid, listingId: 1.5 }, { ...valid, listingId: 2_147_483_648 },
  { ...valid, listingId: Infinity }, { ...valid, workflowVersionId: -1 },
  { ...valid, declaredInputs: {} }, { ...valid, declaredInputs: " \r\n\t" },
  { ...valid, declaredOutputs: null }, { ...valid, declaredInputs: "x".repeat(32_001) },
  { ...valid, declaredOutputs: "x".repeat(32_001) },
  { ...valid, declaredModel: "x".repeat(201) }, { ...valid, declaredDate: "x".repeat(41) },
  { ...valid, declaredRubric: "x".repeat(8_001) }, { ...valid, notes: "x".repeat(8_001) },
  { ...valid, notes: "\u0000" }, { ...valid, notes: "\ud800" },
  { ...valid, consentVersion: undefined }, { ...valid, consentVersion: "unsupported" },
  { ...valid, attachments: [] }, { ...valid, attachments: [{ ref: "https://example.test/file" }] },
  { ...valid, attachmentUrl: "http://localhost/private" },
  { ...valid, userId: 123 }, { ...valid, authorId: 123 },
  { ...valid, provenance: "platform_recorded" }, { ...valid, benchmarkId: 1 },
  { ...valid, score: 100 }, { ...valid, testedAt: "2026-01-01" },
];

describe("external evidence malformed inputs (no database or network)", () => {
  it.each(malformed.map((input, index) => ({ input, index })))("rejects malformed input $index at the service boundary", async ({ input }) => {
    expect(previewExternalInputSchema.safeParse(input).success).toBe(false);
    await expect(previewExternal(1, input)).rejects.toBeInstanceOf(z.ZodError);
    await expect(reportExternal(1, input)).rejects.toBeInstanceOf(z.ZodError);
    expect(dbAccess).not.toHaveBeenCalled();
  });

  it("requires explicit consent and a lowercase SHA-256 hash", async () => {
    const publish = { ...valid, previewHash: "a".repeat(64), publishConsent: true };
    expect(reportExternalInputSchema.safeParse(publish).success).toBe(true);
    for (const patch of [
      { publishConsent: undefined }, { publishConsent: false }, { publishConsent: "true" },
      { previewHash: undefined }, { previewHash: "z".repeat(64) }, { previewHash: "A".repeat(64) },
      { consentVersion: undefined }, { consentVersion: "" },
    ]) {
      await expect(reportExternal(1, { ...publish, ...patch })).rejects.toBeInstanceOf(z.ZodError);
    }
    await expect(previewExternal(0, valid)).rejects.toBeInstanceOf(z.ZodError);
    await expect(reportExternal(0, publish)).rejects.toBeInstanceOf(z.ZodError);
    expect(dbAccess).not.toHaveBeenCalled();
  });

  it("normalizes bounded text while leaving date declarations uninterpreted", () => {
    const normalized = previewExternalInputSchema.parse({
      ...valid, declaredInputs: "  cafe\u0301\r\nline\rthird  ", declaredDate: "sometime last winter", notes: "valid \u{1d400}",
    });
    expect(normalized.declaredInputs).toBe("café\nline\nthird");
    expect(normalized.declaredDate).toBe("sometime last winter");
    expect(previewExternalInputSchema.parse(normalized)).toEqual(normalized);
    expect(previewExternalInputSchema.safeParse({ ...valid, declaredInputs: "x".repeat(32_000) }).success).toBe(true);
  });

  it("bounds read IDs and pagination before touching storage", async () => {
    for (const input of [{ reportId: 0 }, { reportId: "1" }, { reportId: 1, private: true }]) {
      expect(getExternalInputSchema.safeParse(input).success).toBe(false);
      await expect(getExternal(input)).rejects.toBeInstanceOf(z.ZodError);
    }
    for (const input of [{ listingId: 0 }, { listingId: 1, limit: 0 }, { listingId: 1, limit: 51 }, { listingId: 1, beforeId: -1 }]) {
      expect(listExternalInputSchema.safeParse(input).success).toBe(false);
      await expect(listExternal(input)).rejects.toBeInstanceOf(z.ZodError);
    }
    expect(dbAccess).not.toHaveBeenCalled();
  });

  it("exports transport-compatible shared schemas and only community procedures", async () => {
    expect(EXTERNAL_EVIDENCE_TOOLS.map((tool) => tool.inputSchema)).toEqual([
      previewExternalInputSchema, reportExternalInputSchema, getExternalInputSchema, listExternalInputSchema,
      withdrawExternalInputSchema,
    ]);
    for (const tool of EXTERNAL_EVIDENCE_TOOLS) {
      const json = z.toJSONSchema(tool.inputSchema, { io: "input" });
      expect(json.type).toBe("object");
      expect(json.additionalProperties).toBe(false);
    }
    expect(EXTERNAL_EVIDENCE_TOOLS[1].requiredScopes).toEqual(["mcp:write"]);
    expect(EXTERNAL_EVIDENCE_TOOLS[1].featureFlag).toBe("v2Publication");
    for (const name of ["previewExternal", "reportExternal", "getExternal", "listExternal", "withdrawExternal"]) {
      expect(communityEvidenceRouter._def.procedures).toHaveProperty(name);
      expect(evidenceRouter._def.procedures).not.toHaveProperty(name);
    }
    const caller = communityEvidenceRouter.createCaller({ user: null } as Parameters<typeof communityEvidenceRouter.createCaller>[0]);
    await expect(caller.previewExternal(valid)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(dbAccess).not.toHaveBeenCalled();
  });
});
