# Batch C — Post-Website Audit Fixes

Source: alignment audit (2026-07-14) of Batch B fixes + marketing site vs. WEBSITE-SPEC.md and Trust Phase 0.
Order = priority. #1 is a beta blocker; #2–#4 are quick follow-ups; #5 is optional hardening.

---

## Fix 1 — BLOCKER: `helpContent.ts` contradicts Trust Phase 0 certification

**File:** `api/mcp/tools/helpContent.ts` L150–L154 (`submit_for_review` entry).

**Problem:** The in-chat `help` tool tells users the *old* certification story: "AI ensemble
certification … Requires 3 different LLM providers … if the grade is ≥3.5 the listing is
published immediately." The live pipeline (marketplace.ts, Trust Phase 0) and the site docs
(`site/src/content/docs/en/selling.md`) say the opposite: AI triage **can never approve**;
only blind human consensus (minimum average + pass ratio) publishes. The site docs carry
`SYNC-WITH: helpContent.ts` markers pointing at this exact file — the file is the stale side.

**Change:** Replace the `submit_for_review` summary/example so it mirrors selling.md's
three-layer model. Suggested copy (verify wording against actual marketplace.ts behavior
before committing):

> summary: "Submit a draft marketplace listing for certification. Three layers: (1) a
> deterministic security scan of your prompts; (2) AI triage that runs generated test inputs
> and gives feedback — it can reject low-quality submissions but can never approve; (3) blind
> human review — independent reviewers score real outputs without knowing who built it.
> Publication requires human consensus: a minimum average score plus a minimum pass ratio.
> If rejected at any layer, you get actionable findings and can fix and resubmit."
> example: "Submit listing 1 for certification."

**Also sweep while in the file:** `get_listing_status` (L156–L159) — mentions "grade";
confirm the wording matches the current status payload (stages: generating / pending_review /
reviewing / certifying / rejected / published). Adjust if it exposes the old grade-≥3.5 framing.

**Acceptance:** `deewaanai_help` output for submit_for_review contains "can never approve"
and "human consensus", and contains neither "≥3.5" nor "published immediately".
`helpContent.test.ts` updated accordingly.

---

## Fix 2 — Portability tools are invisible

**Files:** `api/mcp/tools/helpContent.ts` (HELP_CATALOG); `site/src/content/docs/en/` (docs manual).

**Problem:** `export_pipeline`, `export_my_data`, `sync_to_github` are registered
(`api/mcp/tools/index.ts` L68–L71) but absent from HELP_CATALOG and from the site docs —
users can't discover them.

**Change:**
1. Add three HELP_CATALOG entries in a new "Your data" group (or under Account), matching
   the registered names and scopes in `api/mcp/tools/portability.ts`:
   - `export_pipeline` (mcp:read) — "Export any pipeline you own as portable JSON. Ask your
     chat to save it anywhere — a local folder, GitHub, or paste it into another tool."
     example: "Export pipeline 12 as JSON and save it to my Documents folder."
   - `export_my_data` (mcp:read) — "Export everything you own (pipelines, agents, templates,
     settings) in one JSON bundle. Your data is always exportable."
   - `sync_to_github` (mcp:write) — "Push a pipeline export to your connected GitHub repo."
2. Site docs: add a short "Your data" section to `site/src/content/docs/en/index.md`
   (or a paragraph at the end of `pipelines.md`) in the docs' existing style — natural-language
   prompts, **no literal tool names** (consistent with the rest of the manual). Example prompt:
   > "Export my pipeline and save it in my projects folder" / "Export all my DeeWaanAI data."
   Mention: exports work with the chat client's own file tools; no lock-in.

**Acceptance:** `deewaanai_help` lists the three tools; docs manual contains an exportability
section; `helpContent.test.ts` covers the new entries.

---

## Fix 3 — Audit trail has no UI

**Files:** `src/pages/AdminPanel.tsx` (TabKey at L49, tab strip, new component);
backend already done (`admin.listAdminAuditLog`, admin.ts L242–L267).

**Change:** Add an "Audit" tab to the Admin Panel consuming `listAdminAuditLog`:
plain table (timestamp, admin, action, target, details JSON pretty-printed), newest first,
paginated, no filters needed for beta. Match existing tab styling; add i18n strings to both
`src/locales/en/*` and `zh/*` (run `npm run check-i18n`).

**Acceptance:** changing a user's tier then opening the Audit tab shows the entry without
touching SQL.

---

## Fix 4 — Placeholder leak in docs code blocks

**Files:** `site/src/content/docs/en/index.md` L16, `site/src/content/docs/en/troubleshooting.md`
L16 — both hardcode `https://{{APP_DOMAIN}}/mcp` inside fenced code blocks. Markdown content
can't read `site/src/config.ts`, so filling config.ts leaves these stale (breaks the spec §9
single-replacement-point rule).

**Change (pick the simple one):** extend the existing container-start substitution in
`site/Dockerfile` (it already seds `SITE_DOMAIN` into robots.txt) to also replace
`{{APP_DOMAIN}}` across `dist/**/*.html` from the same env var source. Document the
placeholder pair in `site/README.md`. Do NOT convert the docs pages to .astro/MDX for this.

**Acceptance:** build with APP_DOMAIN set → rendered /docs quickstart and troubleshooting
pages show the real MCP URL; grep of dist for `{{` returns nothing.

---

## Fix 5 — (Optional) Requeue coverage for remaining stuck states

**File:** `api/routers/admin.ts` (`requeueCertification`, L417–L464).

**Problem:** requeue handles stuck `generating` and `certifying` only. A listing stuck in
`pending_review`/`reviewing` (e.g. reviewer pool never fills) has no one-click recovery.

**Change:** acceptable to defer. If done: add a guarded action for stuck `reviewing` states —
re-open the pool or return the listing to `pending_review`, and write to `admin_audit_log`
like the existing paths. Never auto-publish from an admin action.

---

## Out of scope for this batch
- Cert-queue stage *names* differ from the old spec language ("scanning/triage/in-review") —
  keep the code's names (`generating/pending_review/reviewing/certifying/rejected/published`);
  they are the source of truth.
- config.ts placeholder values themselves are supplied via Railway env at build time — no
  repo change needed.
