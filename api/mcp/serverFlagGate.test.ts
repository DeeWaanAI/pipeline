// The rendered MCP surface, not the declarations: D9 finding 6 was exactly the
// gap between "the guide says this tool is gated" and "the server actually
// hides and refuses it". registry.test.ts compares names and flags between two
// lists; nothing compared the live `tools/list` until this file.

import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const flags = vi.hoisted(() => ({ enabled: new Set<string>() }));
vi.mock("../plugins/featureFlags", () => ({
  isFeatureEnabled: async (flag: string) => flags.enabled.has(flag),
}));
vi.mock("../queries/connection", () => ({
  getDb: () => ({ insert: () => ({ values: async () => undefined }) }),
}));

import { createMcpServer } from "./server";
import { TOOLS } from "./tools/index";
import type { McpAuthContext } from "./types";

// The gate is demonstrated on a SURVIVING gated tool (the benchmark workbench
// behind v2Benchmarks). The batch tools it used to use were deleted in the v3
// cut, and their absence is asserted below rather than gated.
const GATED = ["list_benchmarks"];
const GATED_FLAG = "v2Benchmarks";
const CUT_AWAY = ["run_batch", "batch_status", "resume_batch", "export_batch_results"];

const auth: McpAuthContext = {
  userId: 1,
  clientId: "flag-gate-test",
  requestId: "req-1",
  locale: "en",
  scopes: new Set(["mcp:read", "mcp:write", "mcp:run"]),
};

async function liveSurface() {
  const server = createMcpServer(auth);
  const client = new Client({ name: "flag-gate-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const names = (await client.listTools()).tools.map((t) => t.name);
  return { client, names };
}

describe("MCP feature-flag gate on the live server", () => {
  it("hides a gated tool from tools/list and refuses it by name when the flag is off", async () => {
    flags.enabled = new Set();
    const { client, names } = await liveSurface();
    try {
      for (const name of GATED) expect(names, `${name} is callable while ${GATED_FLAG} is off`).not.toContain(name);
      for (const name of CUT_AWAY) expect(names, `${name} survived the v3 cut`).not.toContain(name);
      // Ungated tools are unaffected, and the gated ones really are declared.
      expect(names).toContain("get_settings");
      for (const name of GATED) {
        expect(TOOLS.find((t) => t.name === name)?.featureFlag).toBe(GATED_FLAG);
      }
      // A hidden tool is not merely absent from the list: calling it by name
      // never reaches its handler. The SDK reports that as an error RESULT
      // rather than a rejected promise, which is what a chat client renders.
      const called = await client.callTool({ name: "run_batch", arguments: { projectId: 1, inputs: [] } });
      expect(called.isError).toBe(true);
      expect(JSON.stringify(called.content)).toContain("Tool run_batch not found");
    } finally {
      await client.close();
    }
  });

  it("shows the same tools once the flag is enabled for this user", async () => {
    flags.enabled = new Set([GATED_FLAG]);
    const { client, names } = await liveSurface();
    try {
      for (const name of GATED) expect(names).toContain(name);
      for (const name of CUT_AWAY) expect(names).not.toContain(name);
    } finally {
      await client.close();
    }
  });
});
