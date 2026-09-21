// Regenerates DeeWaanAI-Next/MCP-TOOLS-WIKI.md from the live registry. Skipped in
// a normal run — the suite must not write files as a side effect:
//
//   MCP_TOOLS_WIKI=1 npx vitest run api/mcp/tools/wikiDump.test.ts
//
// It exists because a hand-copied tool reference rots within one increment, and
// D9 makes this surface the product's primary interface. Every fact about a tool
// here is read from the code that serves it: the description the client receives,
// the zod schema that validates its arguments, and the help entry the parity test
// in registry.test.ts pins to it.

import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TOOLS } from "./index";
import { HELP_CATALOG } from "./helpContent";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WIKI = "DeeWaanAI-Next/MCP-TOOLS-WIKI.md";

it("renders the MCP tools wiki from the registry", { skip: !process.env.MCP_TOOLS_WIKI }, () => {
  const rows = TOOLS.map((t) => {
    const h = HELP_CATALOG.find((c) => c.name === t.name);
    return {
      name: t.name,
      description: t.description,
      scopes: t.requiredScopes,
      featureFlag: t.featureFlag ?? null,
      readOnly: t.annotations?.readOnlyHint ?? null,
      group: h?.group ?? null,
      summary: h?.summary ?? null,
      example: h?.example ?? null,
      capability: h?.capability ?? null,
      schema: JSON.parse(JSON.stringify(z.toJSONSchema(t.inputSchema as never, { io: "input" } as never))),
    };
  });
  // z.toJSONSchema is the same conversion the transport performs, so a schema
  // the client could not render (a Date, say) fails here instead of at connect.
  expect(rows.filter((r) => !r.schema?.type).map((r) => r.name)).toEqual([]);
  expect(rows.filter((r) => !r.group).map((r) => r.name)).toEqual([]);

  const markdown = execFileSync("node", ["scripts/mcp-tools-wiki.mjs"], {
    input: JSON.stringify(rows), cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  expect(markdown).toContain("# DeeWaanAI MCP tools");
  if (existsSync(ROOT + WIKI) && readFileSync(ROOT + WIKI, "utf8") === markdown) return;
  writeFileSync(ROOT + WIKI, markdown);
  console.log(`wrote ${WIKI}: ${rows.length} tools, ${markdown.length} bytes`);
});
