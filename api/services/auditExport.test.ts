// Pure-function tests for the audit export service (Phase 3).
// Covers: canonical JSON determinism, HMAC sign/verify round-trip,
// tamper rejection, and RFC 4180 CSV quoting.
// No DB/network: AuditLedger fixtures are constructed in-memory
// (buildAuditLedger itself requires a database and is NOT tested here).

import { describe, it, expect, vi } from "vitest";
import {
  canonicalJson,
  signLedger,
  verifyLedgerSignature,
  toCsv,
  ledgerToCsvFiles,
  SECTION_CSV_HEADERS,
  AUDIT_EXPORT_RATE_LIMIT,
  type AuditLedger,
  type AuditLedgerSection,
} from "./auditExport";

function makeLedger(overrides: Partial<AuditLedger> = {}): AuditLedger {
  return {
    version: 1,
    generatedAt: "2026-07-13T12:00:00.000Z",
    range: { from: null, to: null },
    counts: {
      runs: 1,
      approvals: 0,
      entitlements: 0,
      subscriptions: 0,
      mcpAuditLog: 0,
      oauthClients: 0,
      oauthRefreshTokens: 0,
      users: 0,
    },
    sections: {
      runs: [
        {
          id: 1,
          projectId: 10,
          userId: 42,
          status: "completed",
          currentStep: null,
          pipelineVersion: "v3",
          isTestRun: false,
          totalTokensUsed: 1234,
          totalLatencyMs: 5678,
          hasError: false,
          startedAt: new Date("2026-07-13T10:00:00.000Z"),
          completedAt: new Date("2026-07-13T10:01:00.000Z"),
        },
      ],
      approvals: [],
      entitlements: [],
      subscriptions: [],
      mcpAuditLog: [],
      oauthClients: [],
      oauthRefreshTokens: [],
      users: [],
    },
    ...overrides,
  };
}

describe("canonicalJson", () => {
  it("is stable regardless of key insertion order", () => {
    const a = canonicalJson({ b: 2, a: 1, c: { z: 26, y: 25 } });
    const b = canonicalJson({ c: { y: 25, z: 26 }, a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2,"c":{"y":25,"z":26}}');
  });

  it("normalizes Dates to ISO strings", () => {
    expect(canonicalJson({ at: new Date("2026-07-13T10:00:00.000Z") })).toBe(
      '{"at":"2026-07-13T10:00:00.000Z"}',
    );
  });

  it("drops undefined properties and stringifies bigint", () => {
    expect(canonicalJson({ keep: 1, drop: undefined, big: 9007199254740993n })).toBe(
      '{"big":"9007199254740993","keep":1}',
    );
  });

  it("sorts keys inside arrays of objects but preserves array order", () => {
    expect(canonicalJson([{ b: 2, a: 1 }, { a: 3, b: 4 }])).toBe(
      '[{"a":1,"b":2},{"a":3,"b":4}]',
    );
  });
});

describe("signLedger / verifyLedgerSignature", () => {
  it("round-trips: a signed ledger verifies", () => {
    const signed = signLedger(makeLedger());
    expect(signed.algorithm).toBe("HMAC-SHA256");
    expect(signed.keyId).toBe("app-secret");
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyLedgerSignature(signed)).toBe(true);
  });

  it("signs with the dedicated AUDIT_EXPORT_KEY when configured", async () => {
    vi.stubEnv("AUDIT_EXPORT_KEY", "test-audit-key");
    vi.resetModules();
    try {
      const mod = await import("./auditExport");
      const signed = mod.signLedger(makeLedger());
      expect(signed.keyId).toBe("audit-export-key");
      expect(mod.verifyLedgerSignature(signed)).toBe(true);
      // A ledger signed with the dedicated key must NOT verify against the
      // default app-secret key (different secret → different signature).
      expect(verifyLedgerSignature(signed)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("still verifies legacy app-secret exports after AUDIT_EXPORT_KEY is set (rotation)", async () => {
    const legacy = signLedger(makeLedger()); // signed with app-secret (no key set)
    expect(legacy.keyId).toBe("app-secret");
    vi.stubEnv("AUDIT_EXPORT_KEY", "test-audit-key");
    vi.resetModules();
    try {
      const mod = await import("./auditExport");
      // The rotation scenario: new exports use the dedicated key, but
      // historical app-secret exports must remain verifiable.
      expect(mod.verifyLedgerSignature(legacy)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("produces identical signatures for identical payloads", () => {
    const a = signLedger(makeLedger());
    const b = signLedger(makeLedger());
    expect(a.signature).toBe(b.signature);
  });

  it("rejects a tampered payload", () => {
    const signed = signLedger(makeLedger());
    signed.payload.sections.runs[0].userId = 999;
    expect(verifyLedgerSignature(signed)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const signed = signLedger(makeLedger());
    // Flip the last hex character.
    const last = signed.signature.at(-1) === "0" ? "1" : "0";
    signed.signature = signed.signature.slice(0, -1) + last;
    expect(verifyLedgerSignature(signed)).toBe(false);
  });

  it("rejects wrong algorithm or keyId metadata", () => {
    const signed = signLedger(makeLedger());
    expect(
      verifyLedgerSignature({ ...signed, algorithm: "HMAC-SHA1" as never }),
    ).toBe(false);
    expect(
      verifyLedgerSignature({ ...signed, keyId: "other-key" as never }),
    ).toBe(false);
  });

  it("rejects a garbage/short signature without throwing", () => {
    const signed = signLedger(makeLedger());
    expect(verifyLedgerSignature({ ...signed, signature: "deadbeef" })).toBe(false);
  });
});

describe("toCsv", () => {
  it("emits the header row and uses CRLF line endings", () => {
    const csv = toCsv([{ id: 1, name: "alpha" }], ["id", "name"]);
    expect(csv).toBe("id,name\r\n1,alpha");
  });

  it("emits only the header row when there are no rows", () => {
    expect(toCsv([], ["id", "name"])).toBe("id,name");
  });

  it("quotes fields containing commas, quotes, or newlines (RFC 4180)", () => {
    const csv = toCsv(
      [{ a: "x,y", b: 'say "hi"', c: "line1\nline2" }],
      ["a", "b", "c"],
    );
    expect(csv).toBe('a,b,c\r\n"x,y","say ""hi""","line1\nline2"');
  });

  it("renders null/undefined as empty and Dates as ISO", () => {
    const csv = toCsv(
      [{ a: null, b: undefined, c: new Date("2026-07-13T10:00:00.000Z") }],
      ["a", "b", "c"],
    );
    expect(csv).toBe("a,b,c\r\n,,2026-07-13T10:00:00.000Z");
  });

  it("appends extra row keys (sorted) after explicit headers", () => {
    const csv = toCsv([{ id: 1, zeta: "z", beta: "b" }], ["id"]);
    expect(csv).toBe("id,beta,zeta\r\n1,b,z");
  });

  it("serializes object values as canonical JSON", () => {
    const csv = toCsv([{ scopes: ["mcp:read", "mcp:run"] }], ["scopes"]);
    expect(csv).toBe('scopes\r\n"[""mcp:read"",""mcp:run""]"');
  });
});

describe("ledgerToCsvFiles", () => {
  it("renders every section with its declared headers, even when empty", () => {
    const files = ledgerToCsvFiles(makeLedger());
    const sections = Object.keys(files) as AuditLedgerSection[];
    expect(sections).toEqual(Object.keys(SECTION_CSV_HEADERS));
    for (const section of sections) {
      const firstLine = files[section].split("\r\n")[0];
      expect(firstLine).toBe(SECTION_CSV_HEADERS[section].join(","));
    }
    expect(files.runs.split("\r\n")).toHaveLength(2); // header + 1 row
  });
});

describe("AUDIT_EXPORT_RATE_LIMIT", () => {
  it("is a generous admin budget of 30 exports per hour", () => {
    expect(AUDIT_EXPORT_RATE_LIMIT.maxTokens).toBe(30);
    expect(AUDIT_EXPORT_RATE_LIMIT.windowMs).toBe(3_600_000);
    expect(AUDIT_EXPORT_RATE_LIMIT.refillRate).toBeCloseTo(30 / 3600, 10);
  });
});
