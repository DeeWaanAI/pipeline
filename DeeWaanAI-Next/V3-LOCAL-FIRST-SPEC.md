# V3 Local-First Architecture Spec

**Status: PROPOSED — no code yet. Owner decisions locked 2026-10-15.**

## The rule

The MCP server and all pipeline execution run **only on the user's own computer**,
driven from their LLM desktop app. This applies to everyone, including people who
fork marketplace listings. Our servers never execute a pipeline for anyone.

What stays hosted (the whole hosted product):

1. The marketplace: listings, evidence records, attestations, fork/download.
2. The marketing site.
3. Accounts — only insofar as publishing/forking needs identity (see §4).

What moves to the user's machine: everything else — pipeline storage, execution,
providers/keys, the visual designer (a local web page served by the local install),
benchmarks, sharing grants.

## 1. SQLite mode (the adoption barrier)

Today the app requires MySQL 8 (+ optional Redis). Target: `npm install -g`-style or
one-command setup with **zero services to install**.

- Add a `better-sqlite3` dialect alongside `mysql2`, selected by env:
  `DB_DRIVER=sqlite` (default for local installs) with the file at
  `~/.deewaanai/deewaanai.db`; `DB_DRIVER=mysql` keeps the current hosted path.
- `db/schema.ts` is MySQL-flavoured drizzle. Options:
  - **(a) Dual schema files** (`schema.mysql.ts` / `schema.sqlite.ts`) generated from
    one source of truth. More files, but each dialect stays idiomatic.
  - **(b) Lowest-common-denominator schema** — painful: loses native types.
  - Recommendation: **(a)**, with a parity test that applies both migration sets to
    scratch databases and diffs the table/column lists.
- Migrations: keep `db/migrations/` for MySQL; add `db/migrations-sqlite/`.
  Local installs migrate automatically on boot (no `drizzle-kit` for end users).
- Redis stays optional → in-memory queue fallback already exists (`api/infra/queue.ts:56`).
- Non-goals: multi-user SQLite, concurrent writers, hosted-on-SQLite.

## 2. Install & run UX

- One command: `npx deewaanai` (or a downloaded installer). On first run it creates
  `~/.deewaanai/`, initializes SQLite, generates a local session secret, and prints
  the two things the user needs: the local MCP URL (`http://localhost:3000/mcp`)
  and the local web designer URL.
- The desktop chat app connects to the local MCP endpoint directly — no `mcp-remote`,
  no OAuth against our servers for local use.
- The visual designer is the existing React app served by the local server
  (`npm run dev` path today, static build + local server in the package).

## 3. Hosted strip-down

- New deployment mode flag `HOSTED_MARKETPLACE_ONLY=1` on the Railway service:
  - Execution routes (`run_pipeline`, swarm execution, benchmarks, protected runs)
    return `410 Gone` with a pointer to the local install.
  - The hosted web app renders marketplace browse/detail/evidence pages only;
    creation/settings pages show "run DeeWaanAI locally" instead.
- The hosted `/mcp` endpoint keeps only marketplace tools (search, read evidence,
  fork-download, publish) — or is retired in favour of plain HTTPS API calls from
  local installs (decision in §5).

## 4. Identity: local-first, platform-linked on demand

- A local install is single-user with a **local account** (no sign-up to us).
- Publishing or forking-from-hosted requires linking to a marketplace account via
  **device authorization** (OAuth 2.0 Device Flow): the local app shows a code, the
  user approves on deewaanai.com, the local install receives a scoped token.
  No device flow exists today — this is the one new protocol piece.
- Seller identity on listings/evidence remains the marketplace account; local user
  ids never leak into hosted records.

## 5. Local ↔ marketplace protocol (the only cloud touchpoints)

All four already exist in spirit; they become plain authenticated HTTPS calls:

| Direction | Call | Exists as |
|---|---|---|
| → cloud | Publish listing + evidence manifest | `publish_evidence` / listing create |
| → cloud | Attestation of evidence (platform signs) | `evidenceSigning.ts` (hosted holds the key) |
| ← cloud | Fork/download a listing as a bundle | `exportListingBundle` (signed bundle, shipped) |
| local | Verify bundle + evidence offline | `verify-evidence.mjs` / `verifyPipelineBundle` (shipped) |

Evidence **signing stays hosted** (the platform key is the trust anchor); everything
else about a pipeline lives locally.

## 6. What this deletes

- Hosted execution, hosted worker, hosted BullMQ need (marketplace-only deploy).
- `mcp-remote` + hosted OAuth for daily use (kept only for the device-link flow).
- The adoption barrier list from HANDOFF-V3 item 3 becomes: Node (or installer) only.

## 7. Phases

| Phase | Deliverable | Gate |
|---|---|---|
| L0 ✅ (b2e8907, 2026-10-17) | SQLite dialect + dual migrations + parity test; app boots end-to-end on SQLite | full test suite runs twice (mysql + sqlite) |
| L1 | First-run setup (`~/.deewaanai`, auto-migrate, local account, printed URLs) | clean-machine install script smoke |
| L2 | `npx deewaanai` packaging (bundled server + static web) | install on a machine without the repo |
| L3 | Device-flow account linking + publish/fork from a local install against hosted | end-to-end: local fork → run → publish |
| L4 | Hosted strip-down flag + hosted UI reduction | hosted deploy refuses execution, marketplace intact |

## 8. Open questions for the owner

1. Chat-client OAuth for the **local** server: keep a local login screen, or trust
   localhost (any local process can call it)? Recommendation: local token printed at
   first run — no password UX.
2. Updates: auto-update prompt inside the app, or manual `npm update`?
   Recommendation: manual + a version-check notice.
3. Does the hosted web app keep user accounts for browsing (read-only) or only for
   publishers? Recommendation: accounts only for publishing/forking; browsing public.
