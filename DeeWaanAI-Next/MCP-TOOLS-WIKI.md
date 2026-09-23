# DeeWaanAI MCP tools — the workbench reference

> Owner decision **D9** (`DeeWaanAI-Next/OFFERING-REDESIGN-TECH-SPECS.md` §1.1) makes MCP the
> primary interface for the workbench, not a side door: every capability has to be reachable
> **and readable** from a chat client. This page is that contract in one place — for a human
> deciding what to build, and for the desktop client driving the tools.
>
> Source of truth is the code, not this file. Every tool section below is rendered from
> `api/mcp/tools/index.ts` joined with `api/mcp/tools/helpContent.ts`;
> `api/mcp/tools/registry.test.ts` pins the two together in both directions. To refresh it after
> adding or changing a tool:
>
> ```bash
> MCP_TOOLS_WIKI=1 npx vitest run api/mcp/tools/wikiDump.test.ts
> ```
>
> If a tool is missing here, it was added without a help entry and the test suite should be
> failing. Prose between the generated blocks is hand-written; the generator owns this file
> (`scripts/mcp-tools-wiki.mjs`), so edit it there or the next run will overwrite the edit.

## 77 tools, 10 groups

| Group | What it is for |
| --- | --- |
| [Discover](#discover) | Read-only orientation: what you own, what a pipeline contains, what is on the marketplace, and what the project remembers. Nothing here spends or writes. |
| [Run](#run) | Execute a workflow and steer it while it runs. |
| [Research](#research) | Batch execution and evidence export — the multi-run half of the workbench, plus a single run's full granular history. |
| [Author](#author) | Build and edit pipelines, including the auto-designer that writes the workflow for you. |
| [Evaluate](#evaluate) | Private evaluation (offering redesign v2, P2). The whole journey is behind the `v2Benchmarks` flag: draft, rubric, cases, quote, approve spend, start, watch, cancel, resume. |
| [Marketplace](#marketplace) | Buy, sell and certify. Includes the blind-reviewer pair that performs the human half of certification. |
| [Publish](#publish) | Evidence publication and protected marketplace execution (v2 P3): what becomes public, exactly which version was tested, and what it is like to run a purchased workflow under your own credentials. |
| [Account](#account) | Your own tenancy: providers and keys, default model, notifications. |
| [Your data](#your-data) | What stays yours: persistent project memory, and getting your own work off our servers — hand over one bundle, then sweep the server's copy once your client has written it. |
| [Diagnostics](#diagnostics) | Connectivity probes, one per direction of the transport. |

## Connecting

`/mcp` is a streamable-HTTP MCP endpoint speaking JSON-RPC 2.0, mounted by `api/mcp/register.ts`
alongside the OAuth 2.1 machinery that protects it.

| | |
| --- | --- |
| Endpoint | `POST /mcp` (also `GET` for the server-initiated stream, `DELETE` to close a session) |
| Protected-resource metadata | `GET /.well-known/oauth-protected-resource` (RFC 9728) |
| Authorization server metadata | `GET /.well-known/oauth-authorization-server` (RFC 8414) |
| Client registration | `POST /oauth/register` — dynamic registration, no secret (`token_endpoint_auth_method: none`) |
| Authorization | `GET /oauth/authorize` → consent screen at the SPA route `/oauth/consent` → `POST /oauth/authorize/confirm` |
| Tokens | `POST /oauth/token`, `grant_types: authorization_code \| refresh_token` |
| Legacy transport | `GET /mcp/sse` + `POST /mcp/messages` for clients that predate streamable HTTP |

A confidential-client secret does not exist here on purpose: MCP desktop clients are installed on
someone else's machine, so the spec's answer is public clients plus **PKCE with `S256` only** —
`plain` and a missing challenge are both rejected (`api/mcp/auth.ts`). Authorization codes are
single-use, stored as a SHA-256 hash, and live 10 minutes. Access tokens are HS256 JWTs derived from
`APP_SECRET`, valid **1 hour**; refresh tokens are opaque, hashed at rest, valid 30 days and rotate
on use (the old one stops working).

**Requests without a Bearer token get 401 with a `WWW-Authenticate: Bearer resource_metadata=...`
challenge** pointing at the discovery document — that is the healthy state for an unauthenticated
`/mcp`, and the standard MCP client uses it to start the sign-in dance. The challenge is built from
the request's own origin (`requestOrigin`), so a local `http://` server is reachable by the client
instead of being told to go to an `https://` host that does not exist.

### The four gates between a token and a tool result

1. **Bearer token** — verified per request in `api/mcp/context.ts`; a bad token is a uniform 401.
2. **Rate limit** — `api/mcp/register.ts` applies the caller's **per-customer tier** budget
   (`resolveCustomerTier` → `checkCustomerRateLimit`) *after* auth, so an anonymous caller spends
   nobody's budget. 429 carries `Retry-After`. The limiter **fails open** if it errors itself,
   consistent with the rest of the app's degradation policy.
3. **Feature flag** — `api/mcp/server.ts` registers a flagged tool only when
   `isFeatureEnabled(flag, userId)` says yes **for this session**. A hidden tool is absent from
   `tools/list` *and* rejected as an unknown tool on call, and a flag check that throws hides the
   tool rather than exposing it (fail closed). Building a fresh `McpServer` per session is what
   makes this per-user rather than per-process.
4. **Scope** — inside the call, `tool.requiredScopes` are matched against the token's scopes;
   missing ones raise a localized `insufficient_scope` error naming exactly what to ask for.

Beyond those four, the tool's handler still authorizes the *data*: every v2 service entry point
takes `userId` from the auth context and re-checks ownership, so a desktop client cannot reach a
benchmark, listing or run it was not given — and cannot bypass a plan hash, a spend approval or a
consent gate by calling the service directly.

`deewaanai_help` answers the same questions from inside the conversation, filtered to what the
caller can actually see; the registry test keeps it from advertising an unregistered tool or hiding
a live one.

### Running it locally

`npm run dev` serves `/mcp`. That is not what it used to do, and the reason matters if you are
debugging a transport failure: the streamable-HTTP handler gives the MCP SDK the raw node
request/response, so it needs Hono's `c.env.incoming`/`c.env.outgoing`. `@hono/node-server`
supplies those bindings as the **second** argument of its fetch callback, but
`@hono/vite-dev-server` declares `async (request) => …`, drops that argument, and calls
`app.fetch(request, {})` — so `initialize` 500'd on an undefined `outgoing` and the only way to
test MCP locally was to build and run the node server separately. `vite.config.ts` now mounts a
`mcp-node-bindings` middleware in front of the dev adapter that re-attaches the bindings for
`/mcp` and nothing else. The in-process pipeline/design/benchmark workers start on boot too
(`START_WORKER` only disables them when set to exactly `false`), so one command is the whole stack:

```bash
docker compose -f docker-compose.v2.yml up -d   # mysql 3307, redis 6380
npm run dev                                     # http://localhost:3000/mcp
```

- `V2_NODE_SERVE=true node dist/boot.js` still exists for checking the **production** boot path,
  which is also the only path that serves the built `dist/public` SPA. It is no longer how you
  reach the MCP server in development.
- `vite.config.ts` exempts `/mcp`, `/oauth/authorize*`, `/oauth/token`, `/oauth/register` and
  `.well-known/*` from the SPA fallback by **prefix, not exact path** — anchoring those patterns is
  what previously swallowed `/oauth/consent` (a React route) or stranded `/oauth/authorize/confirm`.
- A healthy unauthenticated probe is `curl -i localhost:3000/mcp` answering **401 with a
  `WWW-Authenticate` challenge**. A `200` returning HTML means the SPA fallback ate the route.

Two hazards that cost real money or real data: `scripts/mcp-call.mjs` and
`scripts/oauth-test-client.mjs` are hardcoded against the **production** deployment — never run
them to test a local change. The local equivalents are `scripts/smoke-mcp-authoring.mjs` and
`scripts/smoke-mcp-help-settings.mjs`, which take `DATABASE_URL`/`APP_SECRET`/`PORT` from the
environment and do insert fixture rows wherever they point, so aim them at a throwaway schema.
And never start this app with `NODE_ENV=production` against a development `.env`: the flag
activates whatever live payment and email credentials the file holds.

## Reading the tables

- **Scope** is what the *token* must carry. `mcp:read` / `mcp:write` / `mcp:run` are the only
  scopes an OAuth consent can grant (`MCP_SCOPES` in `api/mcp/auth.ts`).
- **Flag** is what the *deployment* must enable for this user. Defaults are OFF for every
  `v2*` flag: the offering-redesign surface ships dark.
- **Capability** is the account *tier* gate (`pipeline:autodesign`, `marketplace:publish`),
  enforced inside the service rather than at registration, so the failure is a refusal with a
  reason — not a vanished tool.
- **read-only** is the MCP client annotation. Trust it as a hint about intent, not as a permission:
  `quote_benchmark` is read-only and writes nothing, while `benchmark_status` is read-only but
  still costs a database read on someone's evidence.
- Arguments come from the tool's own zod schema, so the constraints column is what the server will
  actually enforce. One caveat worth knowing: a zod object **strips** keys it does not declare, so a
  misspelled argument is silently dropped rather than rejected — read the result, not the request.

## Cross-cutting rules a chat client has to respect

These are not per-tool quirks; they are the parts of the spec that only hold if the interface keeps
them visible.

- **UNKNOWN is never zero, and an estimate is never an invoice.** Where a model has no retrievable
  rate, cost is reported as unknown. Rates come from the serving provider's published list where
  possible, falling back to the platform vector, and each figure records which one (`cost_basis`)
  and when (`cost_pricing_as_of`). List prices cannot see promotional, committed-use or
  cached-input discounts.
- **A plan hash binds the approval to what the user was shown.** `approve_benchmark_spend`
  recomputes the hash server-side and a single edit since the quote turns the next call into
  `plan_changed` — so "approve" cannot mean "approve whatever runs next".
- **Completed is a count, not a verdict.** A finished benchmark means every planned output and
  judgment exists. No confidence interval, no significance, no ranking beyond the tested
  conditions, no certification wording — and a grade-only result carries no winning-model field.
- **Completion never publishes.** Nothing becomes public without an explicit consent step against a
  preview hash of the exact bytes. Published evidence is immutable: a correction is a new row that
  supersedes the old and preserves the original `testedAt`.
- **A protected run never shows its workings to the buyer.** Steps execute from an authorized
  snapshot, not the seller's mutable project; intermediates, prompts, provider error text and
  exports are withheld; the buyer's own credential is the only billable route.
- **Retries append.** Ledger attempts are never overwritten, an uncertain outcome stays visible
  rather than being recorded as a failure, and a cancelled plan keeps its spent calls.

## Discover

_6 tools._ Read-only orientation: what you own, what a pipeline contains, what is on the marketplace, and what the project remembers. Nothing here spends or writes.

| Tool | One line | Scopes | Gate |
| --- | --- | --- | --- |
| [`list_pipelines`](#list_pipelines) | List your pipelines: projects (with step counts), saved templates, and purchased marketplace pipelines. | `mcp:read` | — |
| [`get_pipeline`](#get_pipeline) | Show one pipeline in full: agents, steps, if/while gates, approvals. | `mcp:read` | — |
| [`get_shared_pipeline`](#get_shared_pipeline) | Read a pipeline someone shared with you, at exactly the level your grant allows: a full share returns the real steps with every system prompt, a run_only share returns step order, names, roles and enabled flags only and says what was withheld | `mcp:read` | — |
| [`project_context`](#project_context) | Read a project's working context (goal, state summary, recent decisions). | `mcp:read` | — |
| [`memory_get`](#memory_get) | Read your persistent memory notes for a project. | `mcp:read` | — |
| [`search_marketplace`](#search_marketplace) | Search the marketplace for pre-built pipelines you can purchase and run. | `mcp:read` | — |

### `list_pipelines`

List pipelines available to the caller: their projects (with pipeline step counts), saved pipeline templates, and purchased marketplace pipelines. Compact output suitable for choosing a target for run_pipeline.

> Say something like: "What pipelines do I have?"

**Scopes `mcp:read` · annotated read-only**

_No arguments._


### `get_pipeline`

Get one pipeline project in full: name, description, default model, execution settings (pipeline_config), and its ordered steps (agent/if/while/approval) with prompts and configs. Use before update_pipeline.

> Say something like: "Show me pipeline 12."

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `id` | integer | **required** | ≥ 1 — Project id (from list_pipelines) |


### `get_shared_pipeline`

Read a pipeline that was shared with you, at exactly the level your grant allows. A 'full' share returns the real steps including every system prompt. A 'run_only' share returns step ORDER, NAMES, ROLES AND ENABLED FLAGS ONLY and states what was withheld — no prompts, no models, no provider references. An account with no grant gets 'not found', never 'forbidden'.

> Say something like: "What did Ali share with me?"

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | **required** | > 0 |


### `project_context`

Get a project's Intelligence Card (type, framework, file tree, entities, endpoints, TODOs). When a query is provided, also returns the contents of the up to 3 most relevant files.

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | **required** | > 0 |
| `query` | string | optional | length ≥ 1, length ≤ 2000 |


### `memory_get`

Read a project's episodic memory (recent past interactions) and structured state summary (goal, key decisions, recent activity).

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | **required** | > 0 |


### `search_marketplace`

Search published marketplace pipeline listings by keyword (title/description) and category. Returns compact listings ordered by review grade, best first.

> Say something like: "Find a pipeline for competitive analysis."

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `query` | string | optional | length ≤ 200 |
| `category` | string: `translation` \| `writing` \| `code` \| `analysis` \| `creative` \| `other` | optional | — |
| `limit` | integer | optional | ≥ 1, ≤ 20 |


## Run

_5 tools._ Execute a workflow and steer it while it runs.

| Tool | One line | Scopes | Gate |
| --- | --- | --- | --- |
| [`run_pipeline`](#run_pipeline) | Start a pipeline run against a project, template, or purchased listing | `mcp:run` | — |
| [`run_shared_pipeline`](#run_shared_pipeline) | Run a pipeline that was shared with you, on YOUR provider | `mcp:run` | — |
| [`shared_run_status`](#shared_run_status) | Progress and final output of a run of a shared pipeline: step states, names, tokens and latency plus the answer | `mcp:read` | — |
| [`run_status`](#run_status) | Check a run: current step, agent outputs so far, whether it's waiting on your approval. | `mcp:read` | — |
| [`approve_step`](#approve_step) | Approve or reject a paused human-review step so the run continues. | `mcp:write` | — |

### `run_pipeline`

Start a new AI pipeline run on a project. Creates the run, enqueues it for the pipeline worker, and returns immediately — poll run_status for progress and the final response.

> Say something like: "Run pipeline 12 with input: …"

**Scopes `mcp:run` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | **required** | > 0 |
| `input` | string | **required** | length ≥ 1, length ≤ 20000 |
| `templateId` | integer | optional | > 0 |
| `stateless` | boolean | optional | — |
| `chain` | object | optional | — |
| `chain.targetProjectId` | integer | **required** | > 0 |
| `chain.inputTemplate` | string | optional | length ≤ 500 |


### `run_shared_pipeline`

Run a pipeline that was shared with you. The definition never lands in your own records: an immutable snapshot owned by the account that shared it executes inside a container project of yours, on YOUR provider (you pay for your own calls, and the owner's stored provider is never the route). Under a run_only grant the run is redacted at the write, so no prompt text is ever stored for it; under a full grant you can also read the run normally.

> Say something like: "Run the pipeline Ali shared with me on this text."

**Scopes `mcp:run` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | **required** | > 0 |
| `input` | string | **required** | length ≥ 1, length ≤ 200000 |
| `providerId` | integer | **required** | > 0 — ONE OF YOUR OWN providers — you pay for your own calls, and the owner's stored provider is never the route |
| `idempotencyKey` | string | optional | length ≥ 1, length ≤ 120 |


### `shared_run_status`

Your view of a run of a shared pipeline: status, per-step progress METADATA (step number, name, role, state, tokens, latency), totals, the final output when it completed, and the failure category. Step prompt and context columns are not part of this projection, and on a run_only share the provider's own error text is withheld because it can quote the owner's workflow.

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `swarmRunId` | integer | **required** | > 0 |


### `run_status`

Get the status of a pipeline run: current step, per-step agent progress with token/latency usage, totals, and the final response once completed.

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `runId` | integer | **required** | > 0 |


### `approve_step`

Approve, reject, or modify a paused human-in-the-loop pipeline step and resume the run. For 'modify', include instructions telling the previous agent what to change.

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `runId` | integer | **required** | > 0 |
| `action` | string: `approve` \| `reject` \| `modify` | **required** | — |
| `instructions` | string | optional | length ≤ 5000 |


## Research

_5 tools._ Batch execution and evidence export — the multi-run half of the workbench, plus a single run's full granular history.

| Tool | One line | Scopes | Gate |
| --- | --- | --- | --- |
| [`export_run`](#export_run) | Export one run's full granular history (every step, prompt, token count, and response) as portable JSON. | `mcp:read` | — |
| [`run_batch`](#run_batch) | Start a batch of 1–100 pipeline runs in parallel | `mcp:run` | `batch_mode` |
| [`batch_status`](#batch_status) | Check a batch's progress: queued/running/completed/failed counts and member runs. | `mcp:read` | `batch_mode` |
| [`resume_batch`](#resume_batch) | Resume a paused or partially-failed batch from where it stopped. | `mcp:run` | `batch_mode` |
| [`export_batch_results`](#export_batch_results) | Export all of a batch's run results as CSV for analysis. | `mcp:read` | `batch_mode` |

### `export_run`

Export the full granular execution history of one of your pipeline runs as portable JSON: the run record, every intermediate agent step (role, prompts, context input, tokens used, latency, model and provider), and every agent response (full content). Ownership is verified. Hand the returned JSON to your client's filesystem tools to archive it locally.

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `runId` | integer | **required** | > 0 |


### `run_batch`

Start a research-mode batch run on a project. Creates a batch with 1–100 inputs, enqueues all member runs for the pipeline worker, and returns immediately — poll batch_status for progress. Supports optional chaining to a target project after completion.

**Scopes `mcp:run` · flag `batch_mode` (batch research runs; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | **required** | > 0 |
| `inputs` | array<string> | **required** | — |
| `name` | string | optional | length ≤ 200 |
| `templateId` | integer | optional | > 0 |
| `chain` | object | optional | — |
| `chain.targetProjectId` | integer | **required** | > 0 |
| `chain.inputTemplate` | string | optional | length ≤ 500 |


### `batch_status`

Get the current status of a batch run: overall progress, per-run statuses, and total tokens used. Poll this after calling run_batch.

**Scopes `mcp:read` · flag `batch_mode` (batch research runs; hidden from `tools/list` and rejected as an unknown tool when off) · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `batchId` | integer | **required** | > 0 |


### `resume_batch`

Resume a batch run that was paused due to credit exhaustion or provider outage. Re-enqueues all non-terminal member runs.

**Scopes `mcp:run` · flag `batch_mode` (batch research runs; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `batchId` | integer | **required** | > 0 |


### `export_batch_results`

Export the results of a completed batch run as CSV. Returns a CSV string with columns: run_id, input_preview, status, final_response, total_tokens_used, total_latency_ms.

**Scopes `mcp:read` · flag `batch_mode` (batch research runs; hidden from `tools/list` and rejected as an unknown tool when off) · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `batchId` | integer | **required** | > 0 |


## Author

_12 tools._ Build and edit pipelines, including the auto-designer that writes the workflow for you.

| Tool | One line | Scopes | Gate |
| --- | --- | --- | --- |
| [`create_pipeline`](#create_pipeline) | Create a pipeline step by step: agents run in sequence, and if/while quality gates loop back until the output passes — every step type is open to every account. | `mcp:write` | — |
| [`update_pipeline`](#update_pipeline) | Edit a pipeline you own: rename, reorder steps, change prompts or gate settings. | `mcp:write` | — |
| [`design_pipeline`](#design_pipeline) | Auto-designer: state the objective in plain language and the platform generates the optimal pipeline (agents, prompts, quality gates, approvals) as a new project plus a reusable template | `mcp:write` | — |
| [`start_design_job`](#start_design_job) | Durable auto-design: queues the designer as a background job on your configured provider (no live session needed) and returns a job id | `mcp:write` | `v2DesignJobs` |
| [`design_job_status`](#design_job_status) | Poll a design job: queued → running → succeeded/failed/cancelled, with the retained candidate and per-attempt records. | `mcp:read` | `v2DesignJobs` |
| [`cancel_design_job`](#cancel_design_job) | Cancel a queued or running design job | `mcp:write` | `v2DesignJobs` |
| [`share_pipeline`](#share_pipeline) | Lend ONE pipeline to ONE named account: run_only lets them run it and keep the answer while their reads show step names and states only, full lets them read the definition, and canModify (full only) lets them edit it | `mcp:write` | — |
| [`list_pipeline_shares`](#list_pipeline_shares) | The shares involving your account: what you have lent out (revoked grants included, because the row is the record that access existed) and what is currently lent to you, each naming the original creator of the work so you can see that a shared pipeline is a loan. | `mcp:read` | — |
| [`revoke_pipeline_share`](#revoke_pipeline_share) | Take a share back, owner-only and idempotent | `mcp:write` | — |
| [`update_shared_pipeline`](#update_shared_pipeline) | Edit the steps of a pipeline shared to you as full+canModify | `mcp:write` | — |
| [`clone_shared_pipeline`](#clone_shared_pipeline) | Copy a full-share pipeline into your own project with a template and a first immutable version | `mcp:write` | — |
| [`memory_append`](#memory_append) | Add a note to your persistent project memory (survives across chats). | `mcp:write` | — |

### `create_pipeline`

Create a new pipeline project: name, optional description/model/execution settings, and optionally a full ordered step chain (agents run sequentially; if/while control-flow steps loop or branch until the output passes and are open to every account). Returns the new project id for run_pipeline.

> Say something like: "Create a pipeline that drafts a post, critiques it, and refines it until it passes."

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `name` | string | **required** | length ≥ 1, length ≤ 200 — Pipeline (project) name |
| `description` | string \| null | optional | — |
| `defaultModel` | string \| null | optional | Default LLM model for runs |
| `defaultProviderId` | integer \| null | optional | Which of your configured providers runs the steps (get_settings lists ids). Steps created via MCP have no per-step provider, so without this the run falls back to your first provider regardless of the step model. |
| `pipelineConfig` | object \| null | optional | Execution settings |
| `steps` | array<object> \| null | optional | Ordered agent chain. stepType agent/if/while/approval — every step type is available to every account. |


### `update_pipeline`

Update a pipeline project you own: rename, change description/default model/execution settings, and/or replace the whole step chain (existing steps are replaced atomically per call). IF/WHILE control-flow steps are open to every account. Use get_pipeline first to inspect current state.

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `id` | integer | **required** | ≥ 1 — Project id (from list_pipelines) |
| `name` | string | optional | length ≥ 1, length ≤ 200 |
| `description` | string \| null | optional | — |
| `defaultModel` | string \| null | optional | — |
| `defaultProviderId` | integer \| null | optional | Which of your configured providers runs the steps (get_settings lists ids); null clears it. |
| `pipelineConfig` | object \| null | optional | — |
| `steps` | array<object> \| null | optional | Full replacement step chain (existing steps are deleted first) |


### `design_pipeline`

Auto-design a pipeline from a plain-language objective: the platform designs the optimal agent chain (roles, prompts, if/while quality gates, human approvals), creates the project, agents, steps and a reusable template. Available to every account. Uses your desktop app's own LLM when it supports MCP sampling, otherwise a configured LLM provider you own (Settings) — the calls are billed on your own key.

> Say something like: "Design a pipeline that turns a product idea into a launch plan."

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `name` | string | **required** | length ≥ 1, length ≤ 200 — Name for the new pipeline project |
| `task` | string | **required** | length ≥ 1, length ≤ 5000 — The objective the pipeline should accomplish |
| `description` | string \| null | optional | — |
| `providerId` | integer | optional | ≥ 1 — LLM provider to design with (defaults to the user's first configured provider) |


### `start_design_job`

Start a DURABLE auto-design job: the platform designs the optimal agent pipeline for your objective on a configured LLM provider, without needing a live session. Returns a job id immediately — poll design_job_status, then apply it via the web UI/API when the job succeeds. Replaces the synchronous design_pipeline for background use.

> Say something like: "Start a durable design job for: translate legal contracts from English to Arabic."

**Scopes `mcp:write` · flag `v2DesignJobs` (durable background design jobs; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `name` | string | optional | length ≥ 1, length ≤ 200 — Create a NEW project with this name and design into it |
| `projectId` | integer | optional | > 0 — Design into an existing project you own (alternative to name) |
| `task` | string | **required** | length ≥ 1, length ≤ 5000 — The outcome you want the pipeline to achieve |
| `providerId` | integer | optional | ≥ 1 — Owned LLM provider to design with (default: project/user default) |
| `idempotencyKey` | string | optional | length ≥ 1, length ≤ 120 — Retry with the same key returns the existing job |


### `design_job_status`

Poll a durable auto-design job. States: queued → running → succeeded/failed/cancelled. On success the candidate is retained as a pipeline version — apply it deliberately (design_jobs.apply in the web/API); it is never applied automatically, and a project edited meanwhile yields a retained 'revision_conflict' instead of an overwrite.

**Scopes `mcp:read` · flag `v2DesignJobs` (durable background design jobs; hidden from `tools/list` and rejected as an unknown tool when off) · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `jobId` | integer | **required** | > 0 |


### `cancel_design_job`

Cancel a queued or running auto-design job. Queued jobs cancel immediately; running jobs stop dispatching new work at the next checkpoint — provider calls already incurred are retained in the attempt record and are not refunded.

**Scopes `mcp:write` · flag `v2DesignJobs` (durable background design jobs; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `jobId` | integer | **required** | > 0 |


### `share_pipeline`

Grant ONE named other account access to ONE pipeline you own. mode='run_only' (default) lets them run it and keep the answer while their reads return step names and states only — never the step prompts, system prompts or workflow definition. mode='full' also lets them read the definition; pass canModify only with 'full' to let them edit it. A share is a loan between two accounts, never a transfer: you stay the owner, and publishing stays reserved to the original creator. Sharing the same pipeline with the same account again updates that grant.

> Say something like: "Share my contract pipeline with partner@example.com so they can run it but not read the prompts."

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | **required** | > 0 — A pipeline YOU own |
| `granteeId` | integer | optional | > 0 — The one account to grant access to |
| `granteeEmail` | string | optional | length ≤ 320, matches /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/ — …or name them by their exact account email (must match exactly one account) |
| `mode` | string: `run_only` \| `full` | optional | default `"run_only"` — run_only = they can run it and keep the result, never read the prompts or the definition; full = they can also read the definition |
| `canModify` | boolean | optional | Only with mode='full': lets them edit THIS project. Never implies ownership or a right to publish |
| `note` | string | optional | length ≤ 500 |


### `list_pipeline_shares`

List the pipeline shares involving your account: what you have lent out (including revoked grants, which are kept as the record that access existed) and what is currently lent to you. An incoming row names the ORIGINAL creator of the work, so you can see plainly that a shared pipeline is a loan: running and improving it is yours, publishing it is not.

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | optional | > 0 |


### `revoke_pipeline_share`

Take a share back. Owner-only and idempotent — re-revoking changes nothing and refuses nothing. The grant row is flipped to 'revoked' rather than deleted, and because access is re-read at dispatch a run that was already queued stops before it makes any provider call. Runs the recipient already completed stay theirs.

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `shareId` | integer | **required** | > 0 |


### `update_shared_pipeline`

Edit the steps of a pipeline someone shared with you, and only while their grant says canModify. Refused for a run_only grant and for a read-only full grant. The write lands on the OWNER's project (that is what editing a shared object means) — ownership does not move, and the project's recorded original creator is left exactly as it was, so improving borrowed work can never turn it into work you may sell.

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | **required** | > 0 |
| `steps` | array<object> | **required** | — |
| `steps[].name` | string | **required** | length ≥ 1, length ≤ 100 |
| `steps[].role` | string | **required** | length ≥ 1, length ≤ 50 |
| `steps[].systemPrompt` | string | **required** | length ≥ 1 |
| `steps[].stepType` | string | optional | length ≤ 20 |
| `steps[].model` | string \| null | optional | — |
| `steps[].temperature` | string | optional | length ≤ 10 |
| `steps[].maxTokens` | integer | optional | > 0 |
| `steps[].isEnabled` | boolean | optional | — |
| `steps[].ifConfig` | object \| null | optional | — |
| `steps[].whileConfig` | object \| null | optional | — |


### `clone_shared_pipeline`

Copy a pipeline shared with you in 'full' mode into your own project, with a template and a first immutable version. Your copy runs and reads like yours, and it stays ATTRIBUTED: the new project and version record the account that originally created the work, and publishing remains refused for anyone but that account. Refused for a run_only grant, because you cannot copy what you were never allowed to read.

> Say something like: "Clone the pipeline Ali shared with me so I can adapt it for our Arabic market."

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | **required** | > 0 — A pipeline shared with you in mode 'full' |
| `name` | string | optional | length ≥ 1, length ≤ 200 — Name for your copy (defaults to '<source> (copy)') |


### `memory_append`

Append a note to a project's episodic memory so future pipeline runs and memory_get calls can recall it.

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | **required** | > 0 |
| `note` | string | **required** | length ≥ 1, length ≤ 4000 |


## Evaluate

_10 tools._ Private evaluation (offering redesign v2, P2). The whole journey is behind the `v2Benchmarks` flag: draft, rubric, cases, quote, approve spend, start, watch, cancel, resume.

| Tool | One line | Scopes | Gate |
| --- | --- | --- | --- |
| [`create_benchmark`](#create_benchmark) | Draft a PRIVATE evaluation of one of your workflows: real task inputs, your judging panel, grade_only by default | `mcp:write` | `v2Benchmarks` |
| [`prepare_benchmark_rubric`](#prepare_benchmark_rubric) | Pick a rubric template (generic / translation / code) or supply your own dimensions; weights are normalized server-side | `mcp:write` | `v2Benchmarks` |
| [`prepare_benchmark_cases`](#prepare_benchmark_cases) | Set the case list: trimmed, duplicates reported, stable ids kept so a resume still matches recorded attempts. | `mcp:write` | `v2Benchmarks` |
| [`quote_benchmark`](#quote_benchmark) | The cost preflight before any spend: planned provider calls per candidate, estimated cost (unknown where unpriced, never zero), disclosed upper bounds, and the planHash that binds your approval | `mcp:read` | `v2Benchmarks` |
| [`approve_benchmark_spend`](#approve_benchmark_spend) | Authorize spending on exactly the plan you were quoted, on your own enabled credentials | `mcp:write` | `v2Benchmarks` |
| [`start_benchmark`](#start_benchmark) | Freeze the approved plan and queue it | `mcp:write` | `v2Benchmarks` |
| [`benchmark_status`](#benchmark_status) | Progress and the descriptive summary: counts, spread, judge agreement, failures, observed cost | `mcp:read` | `v2Benchmarks` |
| [`list_benchmarks`](#list_benchmarks) | Your benchmarks, newest first, with state, evidence availability, child progress, best descriptive score and observed cost — the cheap poll | `mcp:read` | `v2Benchmarks` |
| [`cancel_benchmark`](#cancel_benchmark) | Stop a queued or running benchmark | `mcp:write` | `v2Benchmarks` |
| [`resume_benchmark`](#resume_benchmark) | Continue a partial or cancelled plan under its frozen hash | `mcp:write` | `v2Benchmarks` |

### `create_benchmark`

Create a PRIVATE evaluation draft for one of your workflows (nothing publishes and nothing is spent yet). Default mode grade_only scores the workflow as configured — pass candidates[].existingResponseId to grade an output you already have instead of regenerating it. compare_models runs the same frozen workflow on each model you name; compare_frontier_solo adds a direct-answer baseline. Then: prepare_benchmark_rubric / prepare_benchmark_cases to adjust, quote_benchmark, approve_benchmark_spend, start_benchmark.

> Say something like: "Benchmark my Arabic contract pipeline on these 5 real clauses."

**Scopes `mcp:write` · flag `v2Benchmarks` (private evaluation; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | **required** | > 0 — The workflow you own that this evaluates |
| `executionMode` | string: `grade_only` \| `compare_models` \| `compare_frontier_solo` | optional | default `"grade_only"` |
| `cases` | array<object> | **required** | — |
| `cases[].inputText` | string | **required** | length ≥ 1, length ≤ 20000 — An actual task input you would send this workflow |
| `cases[].expectedOutput` | string | optional | length ≤ 20000 — Reference answer, if you have one (shown to the judge as reference material) |
| `cases[].origin` | string: `user` \| `generated` \| `paraphrase` | optional | default `"user"` |
| `cases[].baseCaseId` | string | optional | length ≤ 60 |
| `judges` | array<object> | **required** | The judging panel; one judge is honest, five costs 5x. To publish the result as evidence (D12) it must be EXACTLY 3 judges from 3 different model developers with 3 different prompt variants, none sharing a developer with any generating model — anything less runs privately only, and quote_benchmark says which. |
| `judges[].providerId` | integer | **required** | > 0 — A provider YOU own and have enabled |
| `judges[].model` | string | **required** | length ≥ 1, length ≤ 120 |
| `judges[].variant` | string: `anchored_scale` \| `comment_first` \| `checklist_first` | optional | Prompt variant for this judge (D12). An evidence-grade panel needs 3 judges from 3 different model developers each declaring a DIFFERENT variant — every output is then rated 9 times (3 judges × 3 prompts). Omit for a private evaluation and the panel runs the original single prompt, quoted and billed exactly as before. |
| `candidates` | array<object> | optional | — |
| `candidates[].label` | string | optional | length ≥ 1, length ≤ 60 |
| `candidates[].overrideModel` | string | optional | length ≤ 120 — Run EVERY model-backed step of the frozen workflow on this model |
| `candidates[].overrideProviderId` | integer | optional | > 0 |
| `candidates[].isFrontierSoloBaseline` | boolean | optional | compare_frontier_solo: answer the task directly with one prompt, no workflow |
| `candidates[].baselinePrompt` | string | optional | length ≤ 20000 |
| `candidates[].existingResponseId` | integer | optional | > 0 — Grade THIS owned prior output instead of regenerating (grade_only). Costs no generation call. |
| `generationRepeats` | integer | optional | ≥ 1, ≤ 5 — Independent repetitions per case (1 by default) |
| `judgmentKind` | string: `rubric` \| `pairwise` | optional | pairwise requires exactly two candidates |
| `pairedRepeatIndexes` | array<integer> | optional | — |
| `rubricPreset` | string: `generic` \| `translation` \| `code` | optional | Start from a local template; loading one makes no paid call |


### `prepare_benchmark_rubric`

Set or normalize a draft's rubric: load a local preset (generic / translation / code) or supply your own dimensions. Weights are normalized server-side to sum to 1 and every judgment records the bounds and weights used. Makes NO provider call. Templates are starting points, not validated domain expertise. Changing the rubric invalidates an earlier spend approval, which is intended.

**Scopes `mcp:write` · flag `v2Benchmarks` (private evaluation; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `benchmarkId` | integer | **required** | > 0 |
| `preset` | string: `generic` \| `translation` \| `code` | optional | — |
| `dimensions` | array<object> | optional | — |
| `dimensions[].dimension` | string | **required** | length ≥ 1, length ≤ 60 — Dimension name, e.g. 'accuracy' |
| `dimensions[].weight` | number | **required** | ≤ 100, > 0 — Relative weight; normalized to sum 1 server-side |
| `dimensions[].lowerBound` | number | optional | default `0` — Lowest score the judge may give |
| `dimensions[].upperBound` | number | optional | default `10` — Highest score the judge may give |
| `dimensions[].anchor` | string | optional | length ≤ 500, default `""` — What the top and bottom scores mean |


### `prepare_benchmark_cases`

Replace a draft's case list with your own task inputs: trimmed, duplicates dropped, capped at 50, with stable ids preserved when you edit an existing case so a later resume still matches recorded attempts. Anything dropped is reported, never silently discarded. Makes NO provider call — generated or paraphrased variants cost money and would need their own approval.

**Scopes `mcp:write` · flag `v2Benchmarks` (private evaluation; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `benchmarkId` | integer | **required** | > 0 |
| `cases` | array<object> | **required** | — |
| `cases[].inputText` | string | **required** | length ≥ 1, length ≤ 20000 — An actual task input you would send this workflow |
| `cases[].expectedOutput` | string | optional | length ≤ 20000 — Reference answer, if you have one (shown to the judge as reference material) |
| `cases[].origin` | string: `user` \| `generated` \| `paraphrase` | optional | default `"user"` |
| `cases[].baseCaseId` | string | optional | length ≤ 60 |
| `cases[].stableCaseId` | string | optional | length ≤ 60 — Keep the existing id when editing a case list so recorded attempts still line up |


### `quote_benchmark`

The honest cost preflight before any spend: planned provider calls broken down per candidate, estimated costs (unknown where a model has no approved price entry — never zero), disclosed upper-bound assumptions, and blockingErrors that must be empty before approval is possible. Read-only: it writes nothing. Returns the planHash used by approve_benchmark_spend and start_benchmark. Show this table to the user before asking them to approve.

> Say something like: "What will that benchmark cost before I approve it?"

**Scopes `mcp:read` · flag `v2Benchmarks` (private evaluation; hidden from `tools/list` and rejected as an unknown tool when off) · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `benchmarkId` | integer | **required** | > 0 |


### `approve_benchmark_spend`

Authorize spending on the exact plan whose hash the user was quoted, using THEIR OWN enabled provider credentials (owner-funded private evaluation). The hash is recomputed server-side, so approving a plan the caller never saw is not possible. Approvals expire and are consumed exactly once; any later edit invalidates them.

**Scopes `mcp:write` · flag `v2Benchmarks` (private evaluation; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `benchmarkId` | integer | **required** | > 0 |
| `planHash` | string | **required** | length ≥ 64, length ≤ 64 — planHash exactly as quote_benchmark returned it |
| `ceilingUsd` | number | optional | ≤ 1000, > 0 — Optional spend ceiling; best-effort where billing data is incomplete |


### `start_benchmark`

Freeze the approved plan and queue it: your workflow is captured as an immutable version, every candidate runs against that snapshot (never your mutable project), and one child is planned per case × candidate × repeat. If anything changed since the quote this is REFUSED with plan_changed — re-quote and re-approve. Progress via benchmark_status; completion never publishes anything.

**Scopes `mcp:write` · flag `v2Benchmarks` (private evaluation; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `benchmarkId` | integer | **required** | > 0 |
| `planHash` | string | **required** | length ≥ 64, length ≤ 64 |
| `spendApprovalId` | integer | **required** | > 0 |
| `idempotencyKey` | string | optional | length ≥ 1, length ≤ 120 — Retrying with the same key returns the existing started plan |


### `benchmark_status`

One benchmark: state, child progress, the SHAPE of the frozen plan it runs (counts, judges, rubric, planHash — not every case text; pass includePlan:true for the full plan), observed cost with its completeness, and the descriptive summary once final. 'completed' means every planned output and judgment exists — it is NOT a quality verdict, and no confidence interval, ranking or certification language is produced. Grade-only results carry no winning-model field at all.

**Scopes `mcp:read` · flag `v2Benchmarks` (private evaluation; hidden from `tools/list` and rejected as an unknown tool when off) · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `benchmarkId` | integer | **required** | > 0 |
| `includePlan` | boolean | optional | default `false` — Return the entire frozen plan, case texts included. Off by default: the plan is already on `preview_evidence`, and a poll should not re-send it. |


### `list_benchmarks`

Your own benchmarks, newest first: state, evidence availability, child progress (completed/failed/pending/running of the planned children), the best descriptive score under its own rubric, and observed cost with its completeness — so 'how is it going and what has it cost' has one cheap answer. Private to you.

**Scopes `mcp:read` · flag `v2Benchmarks` (private evaluation; hidden from `tools/list` and rejected as an unknown tool when off) · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `limit` | integer | optional | ≥ 1, ≤ 50, default `20` |


### `cancel_benchmark`

Cancel a draft, queued or running benchmark. Running plans stop dispatching new work at the next checkpoint; provider calls already incurred stay recorded in the attempt ledger and are not refunded. Finished children, judgments and cost records are retained — nothing is deleted, and a cancelled plan can be resumed later.

**Scopes `mcp:write` · flag `v2Benchmarks` (private evaluation; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `benchmarkId` | integer | **required** | > 0 |


### `resume_benchmark`

Continue a cancelled/partial/failed benchmark under its FROZEN plan. Completed children and recorded judgments are never re-run and call_attempts are never rewritten — a retry APPENDS a new attempt. Because resuming spends again it needs a fresh approval for the same planHash (quote_benchmark → approve_benchmark_spend). Refuses with nothing_left_to_do rather than consuming an approval.

**Scopes `mcp:write` · flag `v2Benchmarks` (private evaluation; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `benchmarkId` | integer | **required** | > 0 |
| `spendApprovalId` | integer | **required** | > 0 — A FRESH approval for the frozen planHash — resuming spends again |
| `retryFailed` | boolean | optional | Set only to re-run children that failed; unfinished children always continue |


## Marketplace

_11 tools._ Buy, sell and certify. Includes the blind-reviewer pair that performs the human half of certification.

| Tool | One line | Scopes | Gate |
| --- | --- | --- | --- |
| [`start_protected_run`](#start_protected_run) | Run a pipeline you bought WITHOUT getting its definition | `mcp:run` | `v2ProtectedExecution` |
| [`marketplace_execution_right`](#marketplace_execution_right) | Whether you may run a listing and which version your purchase or grant covers | `mcp:read` | `v2ProtectedExecution` |
| [`protected_run_status`](#protected_run_status) | Progress and final output of a protected run: step states, names, tokens and latency plus the answer — never the workflow's prompts or intermediate content. | `mcp:read` | `v2ProtectedExecution` |
| [`enroll_reviewer`](#enroll_reviewer) | Join the marketplace reviewer pool | `mcp:write` | — |
| [`get_next_review_task`](#get_next_review_task) | Claim the next blind review task as an enrolled reviewer: one anonymized input/output pair plus the rubric, with the listing's identity never revealed | `mcp:write` | — |
| [`submit_review_task`](#submit_review_task) | Return your 1–5 scores for a claimed blind task and earn reviewer points | `mcp:write` | — |
| [`publish_to_marketplace`](#publish_to_marketplace) | Create a marketplace listing from a pipeline project | `mcp:write` | — |
| [`submit_for_review`](#submit_for_review) | Submit a draft marketplace listing for certification | `mcp:write` | — |
| [`get_listing_status`](#get_listing_status) | Check a marketplace listing's certification stage: generating test data, pending review, in blind review, certifying, rejected, or published. | `mcp:read` | — |
| [`my_marketplace_listings`](#my_marketplace_listings) | List all marketplace listings you have created (drafts, in review, published, rejected). | `mcp:read` | — |
| [`my_purchases`](#my_purchases) | List marketplace pipelines you have purchased | `mcp:read` | — |

### `start_protected_run`

Run a purchased v2 listing server-side WITHOUT ever receiving its definition. The seller's immutable published version is loaded inside a restricted context: no seller prompts, files, memory, repo tokens or tools are reachable, the buyer's own approved provider is the only billable route, and the endpoint must be on the approved list. Returns immediately with a run id and the protection class + provider logging disclosure that applies to it — read them, an approved provider may still log your requests.

> Say something like: "Run listing 3 on this text using my OpenAI provider."

**Scopes `mcp:run` · flag `v2ProtectedExecution` (protected marketplace execution; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `listingId` | integer | **required** | > 0 — A v2 listing you are entitled to run |
| `input` | string | **required** | length ≥ 1, length ≤ 200000 — The text you would send this pipeline |
| `providerId` | integer | **required** | > 0 — ONE OF YOUR OWN enabled providers — you pay for your own calls |
| `purpose` | string: `buyer_execution` \| `trial` | optional | default `"buyer_execution"` |
| `idempotencyKey` | string | optional | length ≥ 1, length ≤ 120 — Retry with the same key returns the run it already made — nothing is billed twice |


### `marketplace_execution_right`

Whether you may run a listing and the version your purchase or grant covers. Delisting stops new sales, not existing purchased access. A version-bound right keeps its original version instead of inheriting a later version's evidence.

**Scopes `mcp:read` · flag `v2ProtectedExecution` (protected marketplace execution; hidden from `tools/list` and rejected as an unknown tool when off) · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `listingId` | integer | **required** | > 0 |


### `protected_run_status`

The buyer's view of a protected run: status, per-step progress METADATA (step number, name, role, state, tokens, latency), totals, the final output when complete, and the error text when it fails. Step prompt/context columns are deliberately not part of this projection.

**Scopes `mcp:read` · flag `v2ProtectedExecution` (protected marketplace execution; hidden from `tools/list` and rejected as an unknown tool when off) · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `swarmRunId` | integer | **required** | > 0 |


### `enroll_reviewer`

Join the marketplace reviewer pool. Reviewers evaluate pipeline test outputs and earn points redeemable for subscription days. Once enrolled, you will be auto-assigned to pending marketplace listings.

> Say something like: "Enroll me as a reviewer."

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

_No arguments._


### `get_next_review_task`

Pull the next blind marketplace review task. You must be an enrolled, active reviewer (see enroll_reviewer). Returns one anonymized test input/output pair plus the scoring rubric — the listing's identity is never revealed. Review it, then submit scores with submit_review_task.

> Say something like: "Give me my next review task."

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

_No arguments._


### `submit_review_task`

Submit 1-5 scores for a blind review task you claimed via get_next_review_task. Awards reviewer points. When a listing reaches the reviewer quorum, certification is decided automatically (published or rejected).

> Say something like: "Score task 12: accuracy 4, completeness 4, clarity 5."

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `taskId` | integer | **required** | > 0 |
| `accuracy` | number | **required** | ≥ 1, ≤ 5 |
| `completeness` | number | **required** | ≥ 1, ≤ 5 |
| `clarity` | number | **required** | ≥ 1, ≤ 5 |
| `tokenEfficiency` | number | **required** | ≥ 1, ≤ 5 |
| `speed` | number | **required** | ≥ 1, ≤ 5 |
| `consistency` | number | **required** | ≥ 1, ≤ 5 |
| `reviewTime` | number | **required** | ≥ 1 |


### `publish_to_marketplace`

Create a marketplace listing from a pipeline project. Sets price and description. The listing starts as a draft — call submit_for_review when ready.

> Say something like: "Publish my pipeline 'Contract Redliner' to the marketplace at $4.99."

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | **required** | > 0 |
| `title` | string | **required** | length ≥ 3, length ≤ 200 |
| `description` | string | optional | length ≤ 2000 |
| `category` | string: `translation` \| `writing` \| `code` \| `analysis` \| `creative` \| `other` | optional | default `"other"` |
| `price` | number | **required** | ≥ 0, ≤ 9999 |
| `isSubscription` | boolean | optional | — |
| `subscriptionPrice` | number | optional | ≥ 0 |


### `submit_for_review`

Submit a marketplace listing for certification. Runs the trust flow: deterministic security scan → background test-data generation (uses your configured LLM provider) → platform AI triage (non-gating feedback) → 'certifying' (visible, not buyable) → blind human review decides buyability.

> Say something like: "Submit listing 1 for certification."

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `listingId` | integer | **required** | > 0 |


### `get_listing_status`

Track a marketplace listing's certification progress: status, review completion percentage, grade, and publish state.

> Say something like: "What's the status of listing 1?"

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `listingId` | integer | **required** | > 0 |


### `my_marketplace_listings`

List all marketplace listings you created with their current status.

> Say something like: "Show my marketplace listings."

**Scopes `mcp:read` · annotated read-only**

_No arguments._


### `my_purchases`

List marketplace pipelines you purchased and can run.

> Say something like: "Show my purchased pipelines."

**Scopes `mcp:read` · annotated read-only**

_No arguments._


## Publish

_15 tools._ Evidence publication and protected marketplace execution (v2 P3): what becomes public, exactly which version was tested, and what it is like to run a purchased workflow under your own credentials.

| Tool | One line | Scopes | Gate |
| --- | --- | --- | --- |
| [`preview_evidence`](#preview_evidence) | See EXACTLY what would become public before anything is: the tested version, every case and judgment, the rubric and weights, all attempts and costs, and the validators recorded as disabled | `mcp:read` | `v2Publication` |
| [`publish_evidence_version`](#publish_evidence_version) | Publish your listing's evidence AND the exact workflow version it was measured on, together | `mcp:write` | `v2Publication` |
| [`publish_community_evidence`](#publish_community_evidence) | Publish your own measured report about a workflow | `mcp:write` | `v2Publication` |
| [`supersede_evidence`](#supersede_evidence) | Replace published evidence with a new measurement: a NEW immutable row that records what it supersedes, with the original test date preserved | `mcp:write` | `v2Publication` |
| [`withdraw_evidence`](#withdraw_evidence) | Withdraw a publication you authored, with a logged reason | `mcp:write` | `v2Publication` |
| [`listing_publication_state`](#listing_publication_state) | Which version a listing sells, which evidence backs it, whether it is legacy or v2, and the revision number to send so you cannot clobber a concurrent change. | `mcp:read` | `v2Publication` |
| [`get_public_evidence`](#get_public_evidence) | Read evidence by listing, publication id or manifest hash, including standalone community reports | `mcp:read` | — |
| [`preview_external_evidence`](#preview_external_evidence) | Preview a user-declared community report about a public v2 listing without writing anything: the exact disclosure, its consent hash, and any credential it would leak | `mcp:read` | `v2Publication` |
| [`report_external_evidence`](#report_external_evidence) | Publish the exact previewed external report after the user consents to its hash | `mcp:write` | `v2Publication` |
| [`get_external_evidence`](#get_external_evidence) | Read one user-declared community report by id: declared inputs/outputs/model/date, the conspicuous not-verified notice, and when it was submitted (which is NOT when anything was tested). | `mcp:read` | — |
| [`list_external_evidence`](#list_external_evidence) | List a listing's community reports, newest first, separately labelled from seller evidence | `mcp:read` | — |
| [`withdraw_external_evidence`](#withdraw_external_evidence) | Withdraw a community report you authored, with a logged reason | `mcp:write` | — |
| [`model_retest_suggestions`](#model_retest_suggestions) | Your model-freshness suggestions from admin-reviewed release events | `mcp:read` | `v2Publication` |
| [`respond_retest_suggestion`](#respond_retest_suggestion) | Dismiss, snooze, or note that you intend to retest | `mcp:write` | `v2Publication` |
| [`listing_model_freshness`](#listing_model_freshness) | Which provider/model/version a listing's published evidence was tested on and when, whether the provider has since deprecated it, and the reviewed successor — explicit lineage, never a name match. | `mcp:read` | `v2Publication` |

### `preview_evidence`

Build the public disclosure manifest for one of your completed benchmarks and hash it, WITHOUT publishing. This is the full §7.3 disclosure: tested version identity, every case (or a labelled withholding), the exact judging template for EVERY prompt variant the panel ran, weights, every judgment including failures, all attempts, observed cost with unknowns as unknown, and the deterministic validators recorded as disabled. Also returns eligibilityIssues — what would stop a seller publication — secretFindings, and panelIssues: under decision D12 a panel that is not 3 judges from 3 different model developers × 3 prompt variants, disjoint from every generating model, cannot be published as evidence by EITHER boundary; its result stays a private evaluation.

> Say something like: "Preview the evidence for benchmark 3 as seller evidence."

**Scopes `mcp:read` · flag `v2Publication` (evidence publication; hidden from `tools/list` and rejected as an unknown tool when off) · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `benchmarkId` | integer | **required** | > 0 — A COMPLETED benchmark you own — completion alone never publishes anything |
| `listingId` | integer | optional | > 0 — Seller evidence: the listing this would be published against |
| `publicationKind` | string: `seller` \| `community` | optional | default `"community"` — seller = your own listing's required evidence (stricter gate); community = independently measured report |
| `consentVersion` | string | optional | length ≥ 1, length ≤ 40, default `"consent-v1"` |
| `withholdInputs` | boolean | optional | Withhold case text and reference material. Allowed for a clearly labelled limited report; it can then NEVER be seller evidence (§7.3) |
| `withheldReason` | string | optional | length ≥ 3, length ≤ 500 |


### `publish_evidence_version`

The SOLE seller publication boundary: links immutable public evidence to the exact workflow version being sold, in one transaction, and makes the listing published (v2 listings never enter the legacy `certifying` state). Refused unless the preview hash matches byte-for-byte, the evidence is eligible (completed plan, platform-recorded execution, full disclosure), no credential appears in it, and the version you name is the version that was tested. A stale expectedListingRevision fails instead of overwriting.

> Say something like: "Publish benchmark 3's evidence for listing 1, version 4, hash abc123…"

**Scopes `mcp:write` · flag `v2Publication` (evidence publication; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `benchmarkId` | integer | **required** | > 0 — A COMPLETED benchmark you own — completion alone never publishes anything |
| `listingId` | integer | **required** | > 0 |
| `publicationKind` | string: `seller` \| `community` | optional | default `"community"` — seller = your own listing's required evidence (stricter gate); community = independently measured report |
| `consentVersion` | string | optional | length ≥ 1, length ≤ 40, default `"consent-v1"` |
| `withholdInputs` | boolean | optional | Withhold case text and reference material. Allowed for a clearly labelled limited report; it can then NEVER be seller evidence (§7.3) |
| `withheldReason` | string | optional | length ≥ 3, length ≤ 500 |
| `workflowVersionId` | integer | **required** | > 0 — The exact version being sold — must be the version the benchmark tested |
| `previewHash` | string | **required** | length ≥ 64, length ≤ 64 — The hash the user approved |
| `expectedListingRevision` | integer | optional | ≥ 0 — Pass listing_publication_state's evidenceSummaryRevision to avoid clobbering a concurrent change |


### `publish_community_evidence`

Publish your own measured evidence as a community report. It may reference a listing but NEVER becomes that listing's required seller evidence — community and seller proof stay distinguishable, and user-reported data is never presented as platform-recorded. Same consent-by-hash rule as seller publication.

**Scopes `mcp:write` · flag `v2Publication` (evidence publication; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `benchmarkId` | integer | **required** | > 0 — A COMPLETED benchmark you own — completion alone never publishes anything |
| `publicationKind` | string: `seller` \| `community` | optional | default `"community"` — seller = your own listing's required evidence (stricter gate); community = independently measured report |
| `consentVersion` | string | optional | length ≥ 1, length ≤ 40, default `"consent-v1"` |
| `withholdInputs` | boolean | optional | Withhold case text and reference material. Allowed for a clearly labelled limited report; it can then NEVER be seller evidence (§7.3) |
| `withheldReason` | string | optional | length ≥ 3, length ≤ 500 |
| `previewHash` | string | **required** | length ≥ 64, length ≤ 64 |
| `listingId` | integer | optional | > 0 |


### `supersede_evidence`

Replace a seller publication with a new measurement. Creates a NEW immutable row that links to the one it replaces (its own id and hash) and withdraws the old one; `testedAt` is copied from the new benchmark's own finish time, never re-dated to look fresher.

**Scopes `mcp:write` · flag `v2Publication` (evidence publication; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `benchmarkId` | integer | **required** | > 0 — A COMPLETED benchmark you own — completion alone never publishes anything |
| `listingId` | integer | **required** | > 0 |
| `publicationKind` | string: `seller` \| `community` | optional | default `"community"` — seller = your own listing's required evidence (stricter gate); community = independently measured report |
| `consentVersion` | string | optional | length ≥ 1, length ≤ 40, default `"consent-v1"` |
| `withholdInputs` | boolean | optional | Withhold case text and reference material. Allowed for a clearly labelled limited report; it can then NEVER be seller evidence (§7.3) |
| `withheldReason` | string | optional | length ≥ 3, length ≤ 500 |
| `workflowVersionId` | integer | **required** | > 0 — The exact version being sold — must be the version the benchmark tested |
| `previewHash` | string | **required** | length ≥ 64, length ≤ 64 — The hash the user approved |
| `expectedListingRevision` | integer | optional | ≥ 0 — Pass listing_publication_state's evidenceSummaryRevision to avoid clobbering a concurrent change |
| `supersededPublicationId` | integer | **required** | > 0 |


### `withdraw_evidence`

Withdraw a publication you authored. Historical run data, attempts and financial records are untouched, and the row stays as `withdrawn` so a superseded manifest is still addressable. If the withdrawn manifest was a listing's current evidence, the SAME transaction unpublishes the listing — a v2 listing is never left buyable with no evidence.

**Scopes `mcp:write` · flag `v2Publication` (evidence publication; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `publicationId` | integer | **required** | > 0 |
| `reason` | string | **required** | length ≥ 3, length ≤ 2000 — Recorded verbatim in the audit trail |


### `listing_publication_state`

Where one of your listings stands under the v2 rules: a `stage` that separates 'nothing published yet' from 'recorded as legacy and not managed here' from 'v2 evidence is current', which workflow version is sold, which publication is current, and the evidenceSummaryRevision to pass as expectedListingRevision. `null` means there is no v2 record for it at all, which is not the same as revision 0. Owner-scoped: another user's listing is reported as not found.

**Scopes `mcp:read` · flag `v2Publication` (evidence publication; hidden from `tools/list` and rejected as an unknown tool when off) · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `listingId` | integer | **required** | > 0 |


### `get_public_evidence`

Read evidence by listingId, publicationId or manifestHash, including standalone community reports. Listing reads include separately labeled purchased evidence. Withdrawn reports remain available only to their author or an entitled buyer of that version. Returns validated disclosure manifests, never private workflow prompts or credentials. Not feature-gated: existing evidence stays readable.

> Say something like: "Show me the evidence behind listing 7 before I buy it."

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `listingId` | integer | optional | > 0 |
| `publicationId` | integer | optional | > 0 — Read a specific publication, including a standalone community report |
| `manifestHash` | string | optional | matches /^[a-f0-9]{64}$/ |
| `includeCommunity` | boolean | optional | Also list community reports when addressing a listing |


### `preview_external_evidence`

Preview an external community report without writing or running anything. All declared inputs, outputs, model, date and rubric remain user-reported and not independently verified. Only public v2 listings and their current sold version are accepted. No attachments or fetched URLs. Returns the exact disclosure, consent version, hash and secret findings.

> Say something like: "Preview my report: I ran listing 7 on these five inputs and got these outputs."

**Scopes `mcp:read` · flag `v2Publication` (evidence publication; hidden from `tools/list` and rejected as an unknown tool when off) · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `listingId` | integer | **required** | ≤ 2147483647, > 0 |
| `workflowVersionId` | integer \| null | optional | — |
| `declaredInputs` | string | **required** | length ≤ 32000 |
| `declaredOutputs` | string | **required** | length ≤ 32000 |
| `declaredModel` | string \| null | optional | — |
| `declaredDate` | string \| null | optional | Author-declared date text; never interpreted as a platform test timestamp |
| `declaredRubric` | string \| null | optional | — |
| `notes` | string \| null | optional | — |
| `consentVersion` | string | **required** | — |


### `report_external_evidence`

Publish the exact previewed external community report after explicit user consent. Requires previewHash, consentVersion and publishConsent=true. Refuses secrets, stale hashes and unavailable listing/version pairs. Stores only user declarations: no benchmark, execution, judgment, score, attestation or seller certification is created.

**Scopes `mcp:write` · flag `v2Publication` (evidence publication; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `listingId` | integer | **required** | ≤ 2147483647, > 0 |
| `workflowVersionId` | integer \| null | optional | — |
| `declaredInputs` | string | **required** | length ≤ 32000 |
| `declaredOutputs` | string | **required** | length ≤ 32000 |
| `declaredModel` | string \| null | optional | — |
| `declaredDate` | string \| null | optional | Author-declared date text; never interpreted as a platform test timestamp |
| `declaredRubric` | string \| null | optional | — |
| `notes` | string \| null | optional | — |
| `consentVersion` | string | **required** | — |
| `previewHash` | string | **required** | matches /^[a-f0-9]{64}$/ |
| `publishConsent` | boolean | **required** | Explicit user consent to publish the exact previewed content publicly |


### `get_external_evidence`

Read a user-reported external community report for a public v2 listing. The report is not independently verified; declaredDate is author-supplied text and reportedAt is only the submission time, never a platform test time. Returns no private workflow definition or attachments.

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `reportId` | integer | **required** | ≤ 2147483647, > 0 |


### `list_external_evidence`

List external community reports for a public v2 listing, newest report first. Every report is user-reported and not independently verified, separate from seller evidence. Use the last reportId as beforeId for the next page. Unavailable listings return an empty list.

> Say something like: "What have other users reported about listing 7?"

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `listingId` | integer | **required** | ≤ 2147483647, > 0 |
| `limit` | integer | optional | ≥ 1, ≤ 50, default `20` |
| `beforeId` | integer | optional | ≤ 2147483647, > 0 |


### `withdraw_external_evidence`

Withdraw your own external community report from public reads. Author-only and idempotent; retains the report and durable consent proof without deleting or republishing anything. Available even when publication is disabled or the listing is no longer public.

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `reportId` | integer | **required** | ≤ 2147483647, > 0 |


### `model_retest_suggestions`

Your model-freshness suggestions: an admin-reviewed new or successor model that overlaps a workflow version you published evidence for. Each one is information only — nothing has been re-run, nothing has been spent, your published scores and their test dates are untouched, and no retest is scheduled by age. Dismissal is respected; snooze defers until the date you choose.

**Scopes `mcp:read` · flag `v2Publication` (evidence publication; hidden from `tools/list` and rejected as an unknown tool when off) · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `includeDismissed` | boolean | optional | — |


### `respond_retest_suggestion`

Dismiss a suggestion, snooze it until a date, or mark that you intend to retest. 'plan_retest' records intent and starts NOTHING — you still create the benchmark, quote it and approve the spend yourself, because a suggestion must never become a billable run on its own (§12.1).

**Scopes `mcp:write` · flag `v2Publication` (evidence publication; hidden from `tools/list` and rejected as an unknown tool when off) · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `suggestionId` | integer | **required** | > 0 |
| `action` | string: `dismiss` \| `snooze` \| `plan_retest` | **required** | — |
| `until` | string | optional | matches /^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$/ — Only for snooze: ISO 8601 timestamp with timezone |


### `listing_model_freshness`

For a listing's current published evidence: which provider/model/version it was tested on and when, whether each is catalogued, whether the provider deprecated it, and the reviewed successor if one exists (explicit lineage, never a name match). Buyer-facing context, not a verdict.

**Scopes `mcp:read` · flag `v2Publication` (evidence publication; hidden from `tools/list` and rejected as an unknown tool when off) · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `listingId` | integer | **required** | > 0 |


## Account

_6 tools._ Your own tenancy: providers and keys, default model, notifications.

| Tool | One line | Scopes | Gate |
| --- | --- | --- | --- |
| [`send_feedback`](#send_feedback) | Tell the team about a problem with a specific pipeline, run or benchmark and attach THAT object, so support sees what you saw | `mcp:write` | — |
| [`deewaanai_help`](#deewaanai_help) | This guide — filtered to your scopes, what you own, and the connected app. | `mcp:read` | — |
| [`suggest_llm_providers`](#suggest_llm_providers) | Show a curated list of free, cheap, and local LLM providers with signup links and setup instructions | `mcp:read` | — |
| [`add_provider`](#add_provider) | Add an LLM provider from this chat — just paste the slug and API key | `mcp:write` | — |
| [`get_settings`](#get_settings) | Show what you own (purchased pipelines and other entitlements), configured LLM providers, and your default model. | `mcp:read` | — |
| [`set_default_model`](#set_default_model) | Set your preferred model (and optionally provider) used for new pipeline work. | `mcp:write` | — |

### `send_feedback`

Send feedback to the DeeWaanAI team about a specific pipeline, run or benchmark, and attach THAT object so support can see what you saw. Pass attachments[] as { kind: pipeline|run|benchmark, refId, consent: true } — ONE EXPLICIT OPT-IN PER ITEM: nothing is harvested automatically, consent is required on that one object (an unticked or unseen item refuses the whole submission and writes nothing), and the receipt stores the consent version (currently consent-v1). Find the ids with list_pipelines (a pipeline is a project id), run_status/run_pipeline (a run id) or list_benchmarks (a benchmark id). The attached snapshot is exactly what YOUR account can already read: for a pipeline someone shared with you as run_only, or a marketplace workflow you bought, that means the redacted view you already get — their prompts, model bindings and keys are never copied into it. Up to 5 items per submission.

> Say something like: "Send feedback that run 42 stopped after step 2, and attach the run so they can see it."

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | optional | > 0 |
| `targetType` | string: `message` \| `ui` \| `general` | optional | default `"general"` |
| `targetMessageId` | integer | optional | > 0 |
| `feedbackType` | string: `bug` \| `suggestion` \| `praise` \| `confusion` | **required** | — |
| `severity` | string: `critical` \| `major` \| `minor` \| `cosmetic` | optional | default `"minor"` |
| `content` | string | **required** | length ≥ 1, length ≤ 5000 |
| `screenshotUrl` | string | optional | — |
| `context` | object | optional | — |
| `context.url` | string | optional | — |
| `context.browser` | string | optional | — |
| `context.os` | string | optional | — |
| `context.consoleLogs` | array<string> | optional | — |
| `context.activePipeline` | string | optional | — |
| `context.activeStep` | string | optional | — |
| `context.modelUsed` | string | optional | — |
| `context.tokenCount` | number | optional | — |
| `context.latencyMs` | number | optional | — |
| `tags` | array<string> | optional | — |
| `attachments` | array<object> | optional | — |
| `attachments[].kind` | string: `pipeline` \| `run` \| `benchmark` | **required** | what is being attached: a pipeline, a run of one, or a benchmark |
| `attachments[].refId` | integer | **required** | > 0 — the object's own id (projects.id / swarm_runs.id / benchmarks.id) |
| `attachments[].consent` | boolean | **required** | the author's explicit opt-in for THIS item only. Nothing is attached without it, and it is not a global setting: each attachment is ticked on its own object. |


### `deewaanai_help`

Guide to using DeeWaanAI from this chat: what pipelines are, every command your account and this connected app can actually run (with examples), and tips for your current setup. Start here if unsure what to ask.

**Scopes `mcp:read` · annotated read-only**

_No arguments._


### `suggest_llm_providers`

Show a curated list of free, cheap, and local LLM providers you can use with DeeWaanAI. No web search — each entry includes a signup link, suggested model, free-tier details, and setup instructions. Start here if you don't have an API key yet.

> Say something like: "What free providers can I use?"

**Scopes `mcp:read` · annotated read-only**

_No arguments._


### `add_provider`

Add a new LLM provider to your account so you can design and run pipelines. Provide the provider slug and API key; the rest is auto-filled from known defaults. Call suggest_llm_providers first if you need a free/cheap option or signup link.

> Say something like: "Add a Gemini provider with key: AI..."

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `slug` | string | **required** | length ≥ 1, length ≤ 100 — Provider slug — e.g. gemini, deepseek, openai, together, aliyun, mistral. Call suggest_llm_providers to see the full list with signup links. |
| `apiKey` | string | **required** | length ≥ 1, length ≤ 2000 — Your API key for the provider (never shown back to you). |
| `defaultModel` | string | optional | length ≤ 100 — Model to use by default (e.g. gemini-2.0-flash). Falls back to the provider's first known model. |
| `baseUrl` | string | optional | length ≤ 512 — Override the default base URL (rarely needed — e.g. for Ollama local: http://localhost:11434/v1). |


### `get_settings`

Show your DeeWaanAI settings: what you own (purchased pipelines and other entitlements), owned providers (keys never shown), resolved default model and its account/provider/unset source, access warnings and next steps, and desktop sampling support.

**Scopes `mcp:read` · annotated read-only**

_No arguments._


### `set_default_model`

Save an exact model and owned, enabled default provider together. Optionally setProviderDefault also updates that provider's default. No test LLM call or silent substitution; model access is not verified until a provider call.

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `model` | string | **required** | length ≥ 1, length ≤ 100 — Model name, e.g. gemini-2.0-flash, gpt-4o-mini, deepseek-chat |
| `providerId` | integer | optional | ≥ 1 — An enabled provider you own from get_settings; omitted means your currently selected provider, never an automatic choice |
| `setProviderDefault` | boolean | optional | Explicitly set true to also update only the chosen provider's default model for operations that read provider defaults; otherwise leave it unchanged |


## Your data

_6 tools._ What stays yours: persistent project memory, and getting your own work off our servers — hand over one bundle, then sweep the server's copy once your client has written it.

| Tool | One line | Scopes | Gate |
| --- | --- | --- | --- |
| [`preview_work_delivery`](#preview_work_delivery) | What a delivery of your own work data would contain — counts, volume, the bundle hash, and the runs excluded because another account's interest lives in them (a buyer run, a pipeline shared to you) | `mcp:read` | — |
| [`deliver_work_data`](#deliver_work_data) | One complete bundle of your own work data — projects, runs, prompts, step outputs, private benchmark cases, judgments and rationales — with its sha256 and the signed receipt a sweep needs | `mcp:read` | — |
| [`sweep_delivered_work`](#sweep_delivered_work) | Clear the server's copy of work you already delivered | `mcp:write` | — |
| [`export_pipeline`](#export_pipeline) | Export any pipeline you own as portable JSON | `mcp:read` | — |
| [`export_my_data`](#export_my_data) | Export everything you own (pipelines, agents, templates, settings) in one JSON bundle | `mcp:read` | — |
| [`sync_to_github`](#sync_to_github) | Push a pipeline export to your connected GitHub repo. | `mcp:write` | — |

### `preview_work_delivery`

Show what a delivery of your own work data WOULD contain — project and run counts, the step-output volume, the bundle hash, and any runs deliberately excluded (a marketplace buyer run or a pipeline shared to you belongs to another account's interest, so it is never carried or cleared). Writes nothing and hands over no content; use it to size the folder before the user commits to a write.

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | optional | > 0 — Every sweepable run in ONE project of yours |
| `swarmRunId` | integer | optional | > 0 — One run of yours |
| `benchmarkId` | integer | optional | > 0 — One private evaluation benchmark of yours: case inputs, outputs, judge rationales |
| `accountWide` | boolean | optional | Everything: all your projects' runs plus all your benchmarks. Provide exactly one of these four |


### `deliver_work_data`

Hand over ONE complete bundle of this account's own work data (projects, runs, step prompts and outputs, private benchmark cases, judgments and rationales) with a sha256 over it, plus the signed receipt a later sweep must present. Execution stays server-side and your chat client writes the folder the user chose — there is no upload and no background job. Delivering unchanged data returns the same hash, so a client can tell it already wrote these bytes.

> Say something like: "Export everything I have run this month into ~/DeeWaan/backup so I hold the only copy."

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | optional | > 0 — Every sweepable run in ONE project of yours |
| `swarmRunId` | integer | optional | > 0 — One run of yours |
| `benchmarkId` | integer | optional | > 0 — One private evaluation benchmark of yours: case inputs, outputs, judge rationales |
| `accountWide` | boolean | optional | Everything: all your projects' runs plus all your benchmarks. Provide exactly one of these four |


### `sweep_delivered_work`

Clear the server's copy of work data that was already delivered. Needs the receipt from deliver_work_data AND the exact confirmation phrase, and it re-derives the bundle from the database before deleting: if anything was added or edited since delivery it refuses with bundle_changed rather than destroying a copy the user does not hold. Content is nulled, structure is not — rows keep their ids, timestamps, token counts and cost ledger, so published versions, evidence, purchases, execution rights, spend approvals and consent records stay exactly as they were. Runs belonging to another account (a buyer run, a shared pipeline) are refused outright.

> Say something like: "The folder is written and verified — you can delete the server copies now."

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `receipt` | string | optional | length ≤ 4096 — The exact `receipt` string a delivery returned, unchanged |
| `confirmation` | string | optional | length ≤ 200 — Must be the literal phrase "delete-server-copy" |


### `export_pipeline`

Export one of your pipelines as portable JSON (ordered steps + full agent configs, including prompts). Ownership is verified. Hand the returned JSON to your client's filesystem tools to save it anywhere — your data is always exportable.

> Say something like: "Export pipeline 12 as JSON and save it to my Documents folder."

**Scopes `mcp:read` · annotated read-only**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | **required** | > 0 |


### `export_my_data`

Export ALL your DeeWaanAI data as one portable JSON backup: projects, pipeline steps, custom agents (with prompts), templates, and preferences. No lock-in — this is everything, restorable via the app's import. For large accounts the JSON can be long; ask your client to write it straight to a file.

> Say something like: "Export all my DeeWaanAI data."

**Scopes `mcp:read` · annotated read-only**

_No arguments._


### `sync_to_github`

Back up a pipeline to the GitHub repo connected to its project (web app → Project Settings → GitHub). Exports the pipeline JSON and commits it as a file. Requires a GitHub token for this call only — it is never stored.

> Say something like: "Back up my pipeline to GitHub."

**Scopes `mcp:write` · not read-only — it writes, spends or changes state**

| Argument | Type | Required | Constraints and meaning |
| --- | --- | --- | --- |
| `projectId` | integer | **required** | > 0 |
| `token` | string | **required** | length ≥ 1 |
| `path` | string | optional | length ≤ 255 |
| `message` | string | optional | length ≤ 200 |


## Diagnostics

_1 tools._ Connectivity probes, one per direction of the transport.

| Tool | One line | Scopes | Gate |
| --- | --- | --- | --- |
| [`sample_ping`](#sample_ping) | Check whether your connected desktop app can run pipeline steps on its own LLM (MCP sampling) instead of an API key. | `mcp:read` | `mcp_sampling` |

### `sample_ping`

Diagnostic: ask the connected desktop app's own LLM to reply (MCP sampling). Reports whether your app supports sampling, the model used, and the reply — no API key involved.

**Scopes `mcp:read` · flag `mcp_sampling` (server-initiated sampling; hidden from `tools/list` and rejected as an unknown tool when off) · annotated read-only**

_No arguments._

