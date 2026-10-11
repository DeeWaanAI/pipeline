// MCP registry ↔ help-catalog parity (owner decision D9 makes MCP the primary
// interface, so the guide must never advertise a tool that is not registered,
// and must never hide a capability the caller actually has). Pure: no DB.

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOLS } from "./index";
import { BENCHMARK_TOOLS } from "./benchmarkTools";
import { HELP_CATALOG, buildHelp } from "./helpContent";

const ALL_SCOPES = ["mcp:read", "mcp:write", "mcp:run"];

describe("MCP tool registry", () => {
  it("offers explicit, write-scoped application of a durable design candidate", async () => {
    const tool = TOOLS.find((t) => t.name === "apply_design_job");
    expect(tool).toBeDefined();
    expect(tool?.requiredScopes).toEqual(["mcp:write"]);
    expect(tool?.featureFlag).toBe("v2DesignJobs");
    expect(tool?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    const ctx = { userId: 1, scopes: new Set(["mcp:write"]), clientId: "c", requestId: "r", locale: "en" as const };
    await expect(tool!.handler({ jobId: -1 }, ctx)).rejects.toThrow();
    const base = { capabilities: [], scopes: ["mcp:read", "mcp:write"], hasProvider: true, samplingSupported: null };
    for (const enabled of [false, true]) {
      const help = buildHelp({ ...base, flags: { v2DesignJobs: enabled } });
      expect(help.sections.flatMap((s) => s.tools).some((t) => t.name === "apply_design_job")).toBe(enabled);
    }
  });

  it("lists every tool through the SDK, including feature-gated schemas", async () => {
    const server = new McpServer({ name: "registry-test", version: "1" });
    const client = new Client({ name: "registry-client", version: "1" });
    for (const tool of TOOLS) {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      }, async () => ({ content: [] }));
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
      for (const tool of result.tools) expect(tool.inputSchema.type).toBe("object");
    } finally {
      await client.close();
      await server.close();
    }
  });

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

  it("a flag the guide shows as locked is a flag the server actually enforces", () => {
    // The mirror of the test above, and the half that was missing when
    // `run_batch` & friends were listed in tools/list for every account while
    // the guide hid them behind `batch_mode`: the guide's `flag` field is a
    // promise that the server gates the tool, so an entry that carries a flag
    // the tool does not declare is a lie in the other direction.
    const byName = new Map(TOOLS.map((t) => [t.name, t]));
    for (const entry of HELP_CATALOG.filter((e) => e.flag)) {
      const tool = byName.get(entry.name);
      expect(tool, `${entry.name} is in the guide but not registered`).toBeDefined();
      expect(tool?.featureFlag, `${entry.name} is advertised as gated on ${entry.flag} but the server never checks that flag`).toBe(entry.flag);
    }
  });

  it("help and the registry agree in BOTH directions", () => {
    const registered = new Set(TOOLS.map((t) => t.name));
    const advertised = new Set(HELP_CATALOG.map((e) => e.name));
    // The guide must not advertise a tool that no longer exists...
    expect(HELP_CATALOG.filter((e) => !registered.has(e.name)).map((e) => e.name)).toEqual([]);
    // ...and must not hide one that does: D9 makes MCP the primary interface, so
    // a capability reachable only by guessing a tool name is a capability no
    // caller has. This direction was unpinned until the reviewer pair exposed it.
    expect(TOOLS.map((t) => t.name).filter((n) => !advertised.has(n))).toEqual([]);
  });
});

describe("private evaluation MCP surface (D9 workbench)", () => {
  it("exposes the full journey and gates all of it on v2Benchmarks", () => {
    expect(BENCHMARK_TOOLS).toHaveLength(12);
    for (const t of BENCHMARK_TOOLS) {
      expect(t.featureFlag).toBe("v2Benchmarks");
      expect(t.annotations.readOnlyHint).toBe(["quote_benchmark", "benchmark_status", "list_benchmarks", "get_judge_prompts"].includes(t.name));
      expect(t.requiredScopes.length).toBeGreaterThan(0);
      expect(TOOLS).toContain(t); // registered, not just defined
    }
    expect(BENCHMARK_TOOLS.map((t) => t.name)).toEqual([
      "create_benchmark", "prepare_benchmark_rubric", "prepare_benchmark_cases", "quote_benchmark",
      "approve_benchmark_spend", "start_benchmark", "benchmark_status", "list_benchmarks",
      "cancel_benchmark", "resume_benchmark", "get_judge_prompts", "save_judge_prompts",
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
