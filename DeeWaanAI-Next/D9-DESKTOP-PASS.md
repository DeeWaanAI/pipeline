# D9 desktop pass — run the workbench from a user's seat

Owner decision D9 makes MCP the workbench's primary interface, so a capability that is technically
correct but unreadable in a chat window is a defect, not a cosmetic issue. No mocked test can catch
that: unit and integration tests assert the bytes, and the bytes have been passing for a while.
This pass is the only check that reads the result the way a person does.

**Start a fresh Qoder session in this workspace to run it.** The callable tool surface is fixed when
a session starts; a server connected or restarted mid-session appears authorized in the `/mcp` panel
and answers over HTTP, yet stays invisible to the agent's tool list.

## Before touching a tool

1. `npm run dev` on :3000 is the whole stack — it serves `/mcp` and the in-process workers. No build
   step, no second server. `curl -i localhost:3000/mcp` answering **401 with a `WWW-Authenticate`
   challenge** is the healthy state; **`200` + HTML means the SPA fallback ate the route** and the
   pass must stop.
2. Sign in as **`p3-tester`**, not `p3-owner` — the point is a stranger's seat, and the owner is an
   admin. Accounts, provider ids and flags are in `V2-CHECKPOINT.md` and
   `memory/project-live-session-accounts.md`. Credentials lived in `/tmp/v2creds.json`, which does
   not survive a reboot; re-seed rather than hunting for it.
3. Flags in force: `v2Benchmarks`, `v2DesignJobs`, `v2Publication`, `v2ProtectedExecution` ON;
   `v2Commercial`, `teamsync`, `mcp_sampling` OFF. So expect roughly 60 tools, and expect the 8
   `team_*` tools to be absent (they are unreachable for a second, unrelated reason — task #26).
4. Budget: Together's own cap is the hard stop; keep any single benchmark under a ~$2 ceiling and the
   whole session under $20. The last full run cost about $0.016, so this is generous.
   `quote_benchmark` before every `approve_benchmark_spend`, and stop if it forecasts more than
   expected.

**Never** for this pass: enable the org's third-party-data-sharing toggle to make a model answer;
run `scripts/mcp-call.mjs` or `scripts/oauth-test-client.mjs` (both point at production and spend
real money); set `NODE_ENV=production` against the local `.env`; flip `v2Commercial` on.

## The journey

Generator on a serverless model that actually works with this key: `openai/gpt-oss-120b`.
Judges must be from model developers *different from each other and from the generator* —
`deepseek-ai/DeepSeek-V4.1-Flash` and `meta-llama/Llama-3.3-70B-Instruct-Turbo` worked last time.
`zai-org/GLM-5.2` returns empty text unless `chat_template_kwargs:{enable_thinking:false}` is sent,
which the judge path does not do yet (task #24), so leave it out and let that gap stay visible.

1. `deewaanai_help` — does the guide orient a newcomer, and does it match the tools actually listed?
2. `list_pipelines` / `get_pipeline` — read one workflow.
3. `start_design_job` then `design_job_status` (or `design_pipeline` if the flag path is easier) — a
   design job the buyer can review rather than have applied silently.
4. `create_benchmark` → `prepare_benchmark_rubric` → `prepare_benchmark_cases` → `quote_benchmark` —
   5 real cases, `grade_only` first, then one `compare_models` to exercise two candidates.
5. `approve_benchmark_spend` with the exact `planHash`, then `start_benchmark`, then
   `benchmark_status` polled until terminal. Confirm `plan_changed` really fires when the plan is
   edited between quote and approval, and that a stale approval is refused.
6. `publish_evidence_version` behind its preview-hash consent — only on a completed benchmark.
7. Record, do not fake: the purchase and `start_protected_run` leg **cannot run** while
   `trusted_provider_endpoints` is empty (task owned by the owner, P6). That is the honest result of
   step 7, not a skip.
8. `list_benchmarks`, `get_public_evidence`, `cancel_benchmark` / `resume_benchmark` where reachable.

## What to write down per tool

Judge the rendered chat text, not the API. A finding is anything that would make a person without
this codebase go wrong:

- Numbers with no unit, no currency, or no "estimated vs actual" label. Cost is the sharpest edge:
  `estimatedCostUsd` vs `providerInvoicedAmount` must never blur.
- Anything that forces the user to hold an internal id (`planHash`, `spendApprovalId`,
  `workflowVersionId`) across a turn without the tool echoing it back in words.
- A state word that means something different than it reads — `completed` (every call happened) is
  not "good result"; `partial` is not "failure"; `unknown` cost is not zero.
- Payloads long enough to scroll past a decision point, JSON dumped where a table would render, or
  required next steps buried at the end.
- Enums and booleans whose meaning a user cannot guess, and errors phrased in internals rather than
  in what to do next.
- Any v2 capability with **no** MCP route at all — that is a direct D9 violation.

## Output

Append a `DESKTOP PASS <date>` block to `V2-CHECKPOINT.md`: the tool sequence run, spend actually
observed versus what the quote forecast (migration 028 now prices actuals from the same rates, so
this comparison is finally computable — that is a result worth recording), and one line per finding
with the tool name and what a user would have done wrong. Fix nothing during the pass; the list is
the deliverable.
