// MCP registry ↔ help-catalog parity (owner decision D9 makes MCP the primary
// interface, so the guide must never advertise a tool that is not registered,
// and must never hide a capability the caller actually has). Pure: no DB.

import { describe, expect, it } from "vitest";
import { TOOLS } from "./index";
import { BENCHMARK_TOOLS } from "./benchmarkTools";
import { HELP_CATALOG, buildHelp } from "./helpContent";

const ALL_SCOPES = ["mcp:read", "mcp:write", "mcp:run", "team:read", "team:write"];

describe("MCP tool registry", () => {
  it("registers unique, well-formed tools", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.inputSchema).toBeDefined();
      expect(t.requiredScopes.length).toBeGreaterThan(0);
      expect(typeof t.handler).toBe("function");
    }
  });

  it("every gated tool has a help entry with the SAME flag", () => {
    const byName = new Map(HELP_CATALOG.map((e) => [e.name, e]));
    for (const t of TOOLS.filter((x) => x.featureFlag)) {
      const entry = byName.get(t.name);
      expect(entry, `help catalog is missing the gated tool ${t.name}`).toBeDefined();
      expect(entry?.flag, `${t.name} help entry must carry flag ${t.featureFlag}`).toBe(t.featureFlag);
    }
  });

  it("no help entry advertises an unregistered tool", () => {
    const registered = new Set(TOOLS.map((t) => t.name));
    const stale = HELP_CATALOG.filter((e) => !registered.has(e.name)).map((e) => e.name);
    expect(stale).toEqual([]);
  });
});

describe("private evaluation MCP surface (D9 workbench)", () => {
  it("exposes the full journey and gates all of it on v2Benchmarks", () => {
    expect(BENCHMARK_TOOLS).toHaveLength(10);
    for (const t of BENCHMARK_TOOLS) {
      expect(t.featureFlag).toBe("v2Benchmarks");
      expect(t.annotations.readOnlyHint).toBe(["quote_benchmark", "benchmark_status", "list_benchmarks"].includes(t.name));
      expect(t.requiredScopes.length).toBeGreaterThan(0);
      expect(TOOLS).toContain(t); // registered, not just defined
    }
    expect(BENCHMARK_TOOLS.map((t) => t.name)).toEqual([
      "create_benchmark", "prepare_benchmark_rubric", "prepare_benchmark_cases", "quote_benchmark",
      "approve_benchmark_spend", "start_benchmark", "benchmark_status", "list_benchmarks",
      "cancel_benchmark", "resume_benchmark",
    ]);
  });

  it("help hides the evaluation group while the flag is off and shows it when on", () => {
    const base = {
      tier: "pro_auto", capabilities: [], scopes: ALL_SCOPES, hasProvider: true, samplingSupported: null,
    };
    const off = buildHelp({ ...base, flags: { v2Benchmarks: false } });
    expect(off.sections.some((s) => s.group === "Evaluate")).toBe(false);
    expect(off.sections.some((s) => s.tools.some((t) => t.name.startsWith("benchmark") || t.name.endsWith("_benchmark")))).toBe(false);

    const on = buildHelp({ ...base, flags: { v2Benchmarks: true } });
    const evaluate = on.sections.find((s) => s.group === "Evaluate");
    expect(evaluate?.tools.map((t) => t.name)).toEqual(BENCHMARK_TOOLS.map((t) => t.name));
  });

  it("rejects malformed input before touching any service (no silent defaults)", async () => {
    const quote = BENCHMARK_TOOLS.find((t) => t.name === "quote_benchmark")!;
    await expect(quote.handler({}, { userId: 1, scopes: new Set(["mcp:read"]), clientId: "c", requestId: "r", locale: "en" }))
      .rejects.toThrow();
    await expect(quote.handler({ benchmarkId: -5 }, { userId: 1, scopes: new Set(["mcp:read"]), clientId: "c", requestId: "r", locale: "en" }))
      .rejects.toThrow();

    const start = BENCHMARK_TOOLS.find((t) => t.name === "start_benchmark")!;
    // A truncated hash is a typo waiting to spend the wrong plan's approval.
    await expect(start.handler({ benchmarkId: 1, planHash: "abc", spendApprovalId: 1 },
      { userId: 1, scopes: new Set(["mcp:write"]), clientId: "c", requestId: "r", locale: "en" }))
      .rejects.toThrow();
  });
});
