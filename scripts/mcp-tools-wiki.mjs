// Renderer for DeeWaanAI-Next/MCP-TOOLS-WIKI.md: tool metadata JSON on stdin,
// markdown on stdout. Reads no application code, so it runs under plain node —
// the registry is dumped into it by api/mcp/tools/wikiDump.test.ts.
//
//   MCP_TOOLS_WIKI=1 npx vitest run api/mcp/tools/wikiDump.test.ts

const tools = JSON.parse(await new Response(process.stdin).text());
const ORDER = ["Discover", "Run", "Research", "Author", "Evaluate", "Marketplace", "Publish", "Account", "Your data", "Diagnostics"];

const GROUP_INTRO = {
  Discover: "Read-only orientation: what you own, what a pipeline contains, what is on the marketplace, and what the project remembers. Nothing here spends or writes.",
  Run: "Execute a workflow and steer it while it runs.",
  Research: "Batch execution and evidence export — the multi-run half of the workbench, plus a single run's full granular history.",
  Author: "Build and edit pipelines, including the auto-designer that writes the workflow for you.",
  Evaluate: "Private evaluation (offering redesign v2, P2). The whole journey is behind the `v2Benchmarks` flag: draft, rubric, cases, quote, approve spend, start, watch, cancel, resume.",
  Marketplace: "Buy, sell and certify. Includes the blind-reviewer pair that performs the human half of certification.",
  Publish: "Evidence publication and protected marketplace execution (v2 P3): what becomes public, exactly which version was tested, and what it is like to run a purchased workflow under your own credentials.",
  Account: "Your own tenancy: providers and keys, default model, tier, notifications.",
  "Your data": "Persistent project memory that survives across conversations.",
  Diagnostics: "Connectivity probes, one per direction of the transport.",
};

const FLAG_NOTE = {
  v2DesignJobs: "durable background design jobs",
  v2Benchmarks: "private evaluation",
  v2Publication: "evidence publication",
  v2ProtectedExecution: "protected marketplace execution",
  batch_mode: "batch research runs",
  mcp_sampling: "server-initiated sampling",
};

function typeOf(p) {
  if (p.anyOf) return p.anyOf.map((s) => typeOf(s)).join(" \\| ");
  if (p.allOf) return p.allOf.map((s) => typeOf(s)).join(" \\| ");
  if (p.enum) return `${p.type ?? "string"}: ${p.enum.map((e) => `\`${e}\``).join(" \\| ")}`;
  if (p.type === "array") {
    const item = p.items ? typeOf(p.items) : "any";
    return `array<${item.replace(/`/g, "")}>`;
  }
  if (p.type === "object") return "object";
  return p.type ?? "any";
}

function constraints(p) {
  const bits = [];
  if (p.minimum !== undefined && p.minimum !== -9007199254740991) bits.push(`≥ ${p.minimum}`);
  if (p.maximum !== undefined && p.maximum !== 9007199254740991) bits.push(`≤ ${p.maximum}`);
  if (p.exclusiveMinimum !== undefined) bits.push(`> ${p.exclusiveMinimum}`);
  if (p.exclusiveMaximum !== undefined) bits.push(`< ${p.exclusiveMaximum}`);
  if (p.minLength !== undefined) bits.push(`length ≥ ${p.minLength}`);
  if (p.maxLength !== undefined) bits.push(`length ≤ ${p.maxLength}`);
  if (p.pattern) bits.push(`matches /${p.pattern}/`);
  if (p.default !== undefined) bits.push(`default \`${JSON.stringify(p.default)}\``);
  return bits.join(", ");
}

function flatten(prefix, node, requiredSet, out, depth) {
  for (const [n, p] of Object.entries(node?.properties ?? {})) {
    const name = prefix ? `${prefix}.${n}` : n;
    const isReq = (node.required ?? []).includes(n);
    const nested = p.type === "object" && p.properties
      ? p
      : (p.type === "array" && p.items?.type === "object" && p.items.properties
        ? { ...p.items, required: p.items.required ?? [] }
        : null);
    if (nested && depth < 2) {
      out.push({ name, type: p.type === "array" ? `array<${nested.type ?? "object"}>` : "object", req: isReq, note: (p.description ?? "").trim() });
      flatten(`${name}${p.type === "array" ? "[]" : ""}`, nested, null, out, depth + 1);
      continue;
    }
    const bits = [constraints(p), (p.description ?? "").trim()].filter(Boolean);
    out.push({ name, type: typeOf(p), req: isReq, note: bits.join(" — ") });
  }
  return out;
}

function argsTable(schema) {
  const rows = flatten("", schema, null, [], 0);
  if (!rows.length) return "_No arguments._\n";
  const head = "| Argument | Type | Required | Constraints and meaning |\n| --- | --- | --- | --- |";
  const body = rows.map((r) => `| \`${r.name}\` | ${r.type} | ${r.req ? "**required**" : "optional"} | ${(r.note || "—").replace(/\|/g, "\\|").replace(/\n+/g, " ")} |`);
  return `${head}\n${body.join("\n")}\n`;
}

function toolSection(t) {
  const gates = [];
  gates.push(`Scopes \`${t.scopes.join("`, `")}\``);
  if (t.featureFlag) gates.push(`flag \`${t.featureFlag}\` (${FLAG_NOTE[t.featureFlag] ?? "gated"}; hidden from \`tools/list\` and rejected as an unknown tool when off)`);
  if (t.capability) gates.push(`tier capability \`${t.capability}\``);
  gates.push(t.readOnly ? "annotated read-only" : "not read-only — it writes, spends or changes state");
  const example = t.example ? `\n> Say something like: ${t.example}\n` : "";
  return `### \`${t.name}\`\n\n${t.description}\n${example}\n**${gates.join(" · ")}**\n\n${argsTable(t.schema)}\n`;
}

const out = [];
out.push(`# DeeWaanAI MCP tools — the workbench reference

> Owner decision **D9** (\`DeeWaanAI-Next/OFFERING-REDESIGN-TECH-SPECS.md\` §1.1) makes MCP the
> primary interface for the workbench, not a side door: every capability has to be reachable
> **and readable** from a chat client. This page is that contract in one place — for a human
> deciding what to build, and for the desktop client driving the tools.
>
> Source of truth is the code, not this file. Every tool section below is rendered from
> \`api/mcp/tools/index.ts\` joined with \`api/mcp/tools/helpContent.ts\`;
> \`api/mcp/tools/registry.test.ts\` pins the two together in both directions. To refresh it after
> adding or changing a tool:
>
> \`\`\`bash
> MCP_TOOLS_WIKI=1 npx vitest run api/mcp/tools/wikiDump.test.ts
> \`\`\`
>
> If a tool is missing here, it was added without a help entry and the test suite should be
> failing. Prose between the generated blocks is hand-written; the generator owns this file
> (\`scripts/mcp-tools-wiki.mjs\`), so edit it there or the next run will overwrite the edit.
`);

out.push(`## ${tools.length} tools, ${ORDER.length} groups

| Group | What it is for |
| --- | --- |
${ORDER.map((g) => `| [${g}](#${g.toLowerCase().replace(/ /g, "-")}) | ${GROUP_INTRO[g]} |`).join("\n")}
`);

out.push(`## Connecting

\`/mcp\` is a streamable-HTTP MCP endpoint speaking JSON-RPC 2.0, mounted by \`api/mcp/register.ts\`
alongside the OAuth 2.1 machinery that protects it.

| | |
| --- | --- |
| Endpoint | \`POST /mcp\` (also \`GET\` for the server-initiated stream, \`DELETE\` to close a session) |
| Protected-resource metadata | \`GET /.well-known/oauth-protected-resource\` (RFC 9728) |
| Authorization server metadata | \`GET /.well-known/oauth-authorization-server\` (RFC 8414) |
| Client registration | \`POST /oauth/register\` — dynamic registration, no secret (\`token_endpoint_auth_method: none\`) |
| Authorization | \`GET /oauth/authorize\` → consent screen at the SPA route \`/oauth/consent\` → \`POST /oauth/authorize/confirm\` |
| Tokens | \`POST /oauth/token\`, \`grant_types: authorization_code \\| refresh_token\` |
| Legacy transport | \`GET /mcp/sse\` + \`POST /mcp/messages\` for clients that predate streamable HTTP |

A confidential-client secret does not exist here on purpose: MCP desktop clients are installed on
someone else's machine, so the spec's answer is public clients plus **PKCE with \`S256\` only** —
\`plain\` and a missing challenge are both rejected (\`api/mcp/auth.ts\`). Authorization codes are
single-use, stored as a SHA-256 hash, and live 10 minutes. Access tokens are HS256 JWTs derived from
\`APP_SECRET\`, valid **1 hour**; refresh tokens are opaque, hashed at rest, valid 30 days and rotate
on use (the old one stops working).

**Requests without a Bearer token get 401 with a \`WWW-Authenticate: Bearer resource_metadata=...\`
challenge** pointing at the discovery document — that is the healthy state for an unauthenticated
\`/mcp\`, and the standard MCP client uses it to start the sign-in dance. The challenge is built from
the request's own origin (\`requestOrigin\`), so a local \`http://\` server is reachable by the client
instead of being told to go to an \`https://\` host that does not exist.

### The four gates between a token and a tool result

1. **Bearer token** — verified per request in \`api/mcp/context.ts\`; a bad token is a uniform 401.
2. **Rate limit** — \`api/mcp/register.ts\` applies the caller's **per-customer tier** budget
   (\`resolveCustomerTier\` → \`checkCustomerRateLimit\`) *after* auth, so an anonymous caller spends
   nobody's budget. 429 carries \`Retry-After\`. The limiter **fails open** if it errors itself,
   consistent with the rest of the app's degradation policy.
3. **Feature flag** — \`api/mcp/server.ts\` registers a flagged tool only when
   \`isFeatureEnabled(flag, userId)\` says yes **for this session**. A hidden tool is absent from
   \`tools/list\` *and* rejected as an unknown tool on call, and a flag check that throws hides the
   tool rather than exposing it (fail closed). Building a fresh \`McpServer\` per session is what
   makes this per-user rather than per-process.
4. **Scope** — inside the call, \`tool.requiredScopes\` are matched against the token's scopes;
   missing ones raise a localized \`insufficient_scope\` error naming exactly what to ask for.

Beyond those four, the tool's handler still authorizes the *data*: every v2 service entry point
takes \`userId\` from the auth context and re-checks ownership, so a desktop client cannot reach a
benchmark, listing or run it was not given — and cannot bypass a plan hash, a spend approval or a
consent gate by calling the service directly.

\`deewaanai_help\` answers the same questions from inside the conversation, filtered to what the
caller can actually see; the registry test keeps it from advertising an unregistered tool or hiding
a live one.

### Running it locally

\`npm run dev\` serves \`/mcp\`. That is not what it used to do, and the reason matters if you are
debugging a transport failure: the streamable-HTTP handler gives the MCP SDK the raw node
request/response, so it needs Hono's \`c.env.incoming\`/\`c.env.outgoing\`. \`@hono/node-server\`
supplies those bindings as the **second** argument of its fetch callback, but
\`@hono/vite-dev-server\` declares \`async (request) => …\`, drops that argument, and calls
\`app.fetch(request, {})\` — so \`initialize\` 500'd on an undefined \`outgoing\` and the only way to
test MCP locally was to build and run the node server separately. \`vite.config.ts\` now mounts a
\`mcp-node-bindings\` middleware in front of the dev adapter that re-attaches the bindings for
\`/mcp\` and nothing else. The in-process pipeline/design/benchmark workers start on boot too
(\`START_WORKER\` only disables them when set to exactly \`false\`), so one command is the whole stack:

\`\`\`bash
docker compose -f docker-compose.v2.yml up -d   # mysql 3307, redis 6380
npm run dev                                     # http://localhost:3000/mcp
\`\`\`

- \`V2_NODE_SERVE=true node dist/boot.js\` still exists for checking the **production** boot path,
  which is also the only path that serves the built \`dist/public\` SPA. It is no longer how you
  reach the MCP server in development.
- \`vite.config.ts\` exempts \`/mcp\`, \`/oauth/authorize*\`, \`/oauth/token\`, \`/oauth/register\` and
  \`.well-known/*\` from the SPA fallback by **prefix, not exact path** — anchoring those patterns is
  what previously swallowed \`/oauth/consent\` (a React route) or stranded \`/oauth/authorize/confirm\`.
- A healthy unauthenticated probe is \`curl -i localhost:3000/mcp\` answering **401 with a
  \`WWW-Authenticate\` challenge**. A \`200\` returning HTML means the SPA fallback ate the route.

Two hazards that cost real money or real data: \`scripts/mcp-call.mjs\` and
\`scripts/oauth-test-client.mjs\` are hardcoded against the **production** deployment — never run
them to test a local change. The local equivalents are \`scripts/smoke-mcp-authoring.mjs\` and
\`scripts/smoke-mcp-help-settings.mjs\`, which take \`DATABASE_URL\`/\`APP_SECRET\`/\`PORT\` from the
environment and do insert fixture rows wherever they point, so aim them at a throwaway schema.
And never start this app with \`NODE_ENV=production\` against a development \`.env\`: the flag
activates whatever live payment and email credentials the file holds.

## Reading the tables

- **Scope** is what the *token* must carry. \`mcp:read\` / \`mcp:write\` / \`mcp:run\` are the only
  scopes an OAuth consent can grant (\`MCP_SCOPES\` in \`api/mcp/auth.ts\`).
- **Flag** is what the *deployment* must enable for this user. Defaults are OFF for every
  \`v2*\` flag: the offering-redesign surface ships dark.
- **Capability** is the account *tier* gate (\`pipeline:autodesign\`, \`marketplace:publish\`),
  enforced inside the service rather than at registration, so the failure is a refusal with a
  reason — not a vanished tool.
- **read-only** is the MCP client annotation. Trust it as a hint about intent, not as a permission:
  \`quote_benchmark\` is read-only and writes nothing, while \`benchmark_status\` is read-only but
  still costs a database read on someone's evidence.
- Arguments come from the tool's own zod schema, so the constraints column is what the server will
  actually enforce. One caveat worth knowing: a zod object **strips** keys it does not declare, so a
  misspelled argument is silently dropped rather than rejected — read the result, not the request.

## Cross-cutting rules a chat client has to respect

These are not per-tool quirks; they are the parts of the spec that only hold if the interface keeps
them visible.

- **UNKNOWN is never zero, and an estimate is never an invoice.** Where a model has no retrievable
  rate, cost is reported as unknown. Rates come from the serving provider's published list where
  possible, falling back to the platform vector, and each figure records which one (\`cost_basis\`)
  and when (\`cost_pricing_as_of\`). List prices cannot see promotional, committed-use or
  cached-input discounts.
- **A plan hash binds the approval to what the user was shown.** \`approve_benchmark_spend\`
  recomputes the hash server-side and a single edit since the quote turns the next call into
  \`plan_changed\` — so "approve" cannot mean "approve whatever runs next".
- **Completed is a count, not a verdict.** A finished benchmark means every planned output and
  judgment exists. No confidence interval, no significance, no ranking beyond the tested
  conditions, no certification wording — and a grade-only result carries no winning-model field.
- **Completion never publishes.** Nothing becomes public without an explicit consent step against a
  preview hash of the exact bytes. Published evidence is immutable: a correction is a new row that
  supersedes the old and preserves the original \`testedAt\`.
- **A protected run never shows its workings to the buyer.** Steps execute from an authorized
  snapshot, not the seller's mutable project; intermediates, prompts, provider error text and
  exports are withheld; the buyer's own credential is the only billable route.
- **Retries append.** Ledger attempts are never overwritten, an uncertain outcome stays visible
  rather than being recorded as a failure, and a cancelled plan keeps its spent calls.
`);

for (const g of ORDER) {
  const inGroup = tools.filter((t) => t.group === g);
  out.push(`## ${g}\n\n_${inGroup.length} tools._ ${GROUP_INTRO[g]}\n`);
  out.push(`| Tool | One line | Scopes | Gate |\n| --- | --- | --- | --- |`);
  for (const t of inGroup) {
    out.push(`| [\`${t.name}\`](#${t.name}) | ${(t.summary ?? t.description).split(". ")[0]} | ${t.scopes.map((s) => `\`${s}\``).join(" ")} | ${t.featureFlag ? `\`${t.featureFlag}\`` : t.capability ? `\`${t.capability}\`` : "—"} |`);
  }
  out.push("");
  for (const t of inGroup) out.push(toolSection(t));
}

process.stdout.write(out.join("\n"));
