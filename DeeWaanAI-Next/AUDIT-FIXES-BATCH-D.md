# Batch D — Batch C Regressions + Beta Command Center

Source: Batch C verification audit (2026-07-14). D1/D2 are regressions introduced by
Batch C — fix first, they're small. D3 is the new feature.

---

## Fix D1 — REGRESSION: duplicated content in pipelines.md

**File:** `site/src/content/docs/en/pipelines.md`.

**Problem:** The "Your data — always exportable" section (Batch C Fix 2) was inserted
mid-file, duplicating the update-pipeline block. The "> In my invoice pipeline…" example
and the "Updates apply to future runs…" paragraph now appear twice (L41–L43 and L54–L56).

**Change:** Keep ONE copy of the update-pipeline example/paragraph, and move the
"Your data — always exportable" section to the END of the page (after the update-pipeline
content, before nothing). Section content itself is good — don't rewrite it.

**Acceptance:** `grep -c "invoice pipeline" pipelines.md` → 1; `grep -c "Updates apply" → 1`;
"Your data" is the last section on the page.

---

## Fix D2 — REGRESSION: docs MCP URL filled with the wrong domain

**File:** `site/Dockerfile` (CMD, L33).

**Problem:** Batch C Fix 4 substitutes `{{APP_DOMAIN}}` in built HTML using `$SITE_DOMAIN`.
Per the domain strategy these differ: SITE_DOMAIN = marketing site (deewaanai.com),
APP_DOMAIN = the app/MCP host (app.deewaanai.com). As shipped, the /docs quickstart and
troubleshooting pages print `https://<site-domain>/mcp` — a wrong MCP connect URL.

**Change:**
1. Introduce a separate `APP_DOMAIN` env var in the CMD substitution:
   `{{SITE_DOMAIN}}` ← `$SITE_DOMAIN` (robots.txt), `{{APP_DOMAIN}}` ← `$APP_DOMAIN` (HTML).
   Fall back: if `$APP_DOMAIN` unset, skip substitution (leave placeholder visible — a loud
   failure beats a silently wrong URL).
2. Set `APP_DOMAIN` on the Railway site service.
3. Document both vars in `site/README.md`.

**Acceptance:** deployed /docs quickstart shows the real app-host MCP URL (not the marketing
domain); `curl` the live page and grep for `/mcp`.

---

## Fix D3 — Beta command center: Waitlist + Invites tab

**Goal:** one Admin Panel tab ("Beta") that manages the Pioneer 100 funnel end-to-end:
see waitlist → generate invite voucher → track conversion. Backend for vouchers already
exists (`api/routers/voucher.ts`: `generate`, `list` — both adminQuery); waitlist has NO
admin read endpoint yet.

**Backend (api/routers/admin.ts or a new adminWaitlist section):**
1. `listWaitlist` (adminQuery): paginated waitlist entries from `waitlistEntries`
   (db/schema.ts L1277–L1288) with: email, role, position (reuse the rank logic in
   `api/waitlist-route.ts` L33–L39), referralCode, referredBy (resolve `ref` → referrer
   email where possible), createdAt, and a computed `referralCount` (how many entries carry
   this entry's code as ref). Support `search` (email) and sort by position.
2. `markWaitlistInvited` (adminQuery): set an `invitedAt` timestamp — requires adding a
   nullable `invited_at` column to `waitlist_entries` (new migration, follow
   `db/migrations/015_admin_audit.sql` conventions). Write to `admin_audit_log`
   (action: "waitlist.invite") like other privileged mutations.
3. Wire nothing to email — inviting is manual during beta (founder sends personal messages).

**Frontend (src/pages/AdminPanel.tsx):**
1. New `TabKey` "beta", tab label i18n'd in en+zh `pages.json` (run `npm run check-i18n`).
2. Section A — Waitlist table: position, email, role badge, referral count, referred-by,
   joined date, invited badge; row action "Mark invited" (calls markWaitlistInvited).
   Header shows claimed/100 counter (reuse the count query).
3. Section B — Invite vouchers: table from `voucher.list` (code, tier, redeemed-by, dates)
   + a small "Generate voucher" form calling `voucher.generate` (respect its existing input
   schema — read `api/routers/voucher.ts` before building the form).
4. Match existing tab styling (see CertificationTab / AuditTab patterns).

**Acceptance:** from /admin Beta tab, without SQL: view the waitlist ordered by position
with referral counts; generate a voucher; mark an entry invited and see it audit-logged in
the Audit tab.

---

## Out of scope
- Email sending / campaign tooling (manual outreach during beta).
- Waitlist analytics beyond referral counts.
- Public "position checker" page (post-beta if ever).

---

## D3 implementation references (exact locations, verified 2026-07-14)

**db/schema.ts** (file is 1289 lines):
- `adminAuditLog` → L1262–L1275 (`admin_audit_log`: id, adminUserId FK set-null, action varchar64, targetType, targetId, detail json, ip, createdAt + created/admin indexes)
- `waitlistEntries` → L1278–L1288 (`waitlist_entries`: id, email varchar320 UNIQUE, role enum creator|user|both, ref varchar64, referralCode varchar32 UNIQUE, createdAt)
- The `invited_at` column (Fix D3 backend #2) does NOT exist yet — add nullable `timestamp("invited_at")` to this table + migration.

**src/pages/AdminPanel.tsx** (1141 lines):
- `TabKey` type → L50; tab state → L205; `tabs` array with icons → L230–L237; tab-content switch → around L280.
- `AuditTab` component (newest pattern to copy: adminQuery + table + loading/error/empty states) → ~L1075 onward.

**i18n:** `src/locales/en/pages.json` and `zh/pages.json` (1014 lines each, keys mirror):
- Admin block → `"admin"` at L82; tab labels → `admin.tabs` at L87–L94 (add `"beta"` there).
- Add a new `admin.beta.*` block alongside the existing `admin.audit.*` block; run `npm run check-i18n` after.

**Backend references:** voucher endpoints → `api/routers/voucher.ts` (generate/list already adminQuery); waitlist rank logic to reuse → `api/waitlist-route.ts` L33–L39; `logAdminAction` helper → `api/routers/admin.ts`.
