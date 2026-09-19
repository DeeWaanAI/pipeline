# DeeWaanAI — Beta-to-Business Playbook

**Owner:** Founder · **Updated:** 2026-07-14 · **Use:** day-to-day operating reference
**Companion docs:** WEBSITE-SPEC.md · AUDIT-FIXES-BATCH-C.md · AUDIT-FIXES-BATCH-D.md · PROGRESS.md

---

## 0. The thesis (one paragraph, never lose it)

DeeWaanAI is the AI-pipeline marketplace where **every pipeline is certified by blind human
review** — used entirely from inside the LLM desktop apps people already have (MCP-native,
provider-neutral). The moat is not pipelines (everyone has pipelines); it is **trusted human
review supply** plus cross-provider neutrality. Every decision below serves one flywheel:
creators list → blind reviewers certify → buyers trust → more creators list.

---

## 1. Where things stand (asset inventory)

| Asset | Status |
|---|---|
| Product (MCP server, 30+ tools, OAuth 2.1) | ✅ live on Railway |
| Trust Phase 0 (security scan → AI triage → blind human quorum) | ✅ live, beta-verified |
| Marketing site + Pioneer 100 waitlist + /docs manual (i18n-ready) | ✅ live |
| Admin panel (feedback, users, stats, flags, cert queue, audit) | ✅ · Beta tab in Batch D |
| Data portability (export / GitHub sync via chat) | ✅ |
| UK company | ✅ exists (non-resident) |
| UK trademark "DeeWaanAI" word mark, Classes 9+42+35 (~£270) | 🔶 filing in progress |
| Demo video | ⬜ not recorded |
| ToS/Privacy with assignment clause | ⬜ verify live |
| HanZi FPGA appliance | 🅿️ parked — supplier finalizing design; naming TBD |

---

## 2. Phase 0 — Launch readiness (gate: do NOT invite anyone until all ✅)

**Technical gate:**
- [ ] Batch D deployed (D2 especially — live /docs must show the correct app-host MCP URL)
- [ ] Founder dry run, end-to-end, two fresh accounts:
      connect via Claude Desktop OAuth → add provider → create pipeline → run →
      publish → certify (blind review) → buy + run with account #2.
      **Time it. > 15 min to first success = fix before launch.**
- [ ] Record the 45-sec hero demo during the dry run (real screen, one take, no narration
      needed — captions). Post to site hero + pinned everywhere.
- [ ] Backup verified: DB backup workflow active and restorable (it was failing silently before).

**Business gate:**
- [ ] UK trademark application submitted → diary **+4 months** (registration expected) and
      **+6 months** (Madrid priority deadline — hard).
- [ ] ToS + Privacy pages live, including contract **assignment clause** (UK co → future HK co).
- [ ] TRADEMARK.md drafted (needed before repo goes public, not before beta).
- [ ] Wave-1 invite list written: 15–20 names (see §3.1 criteria).

---

## 3. Phase 1 — Wave 1 (weeks 1–4): prove the loop, not growth

**Objective:** the certification flywheel spins once, with strangers-grade honesty.
**Success =** 3–5 listings certified by real blind review **and** ≥2 purchases/runs of
certified pipelines by non-creators.

### 3.1 Who to invite (15–20 → expect 10–12 active)
Mix deliberately:
- 5–7 **builders** (will create + list pipelines)
- 5–7 **operators** (will use/buy pipelines for real work)
- 3–5 **conscientious people** (will actually complete reviews — reliability > AI expertise)
- At least 3 who already use Claude/ChatGPT/Kimi desktop daily (zero-setup testers)

### 3.2 Invite message (personal, one per person — never BCC)
> I'm opening my project to 20 people before anyone else. It's a marketplace of AI
> workflows you use directly inside [Claude/your AI chat] — every listing certified by
> blind human review. I need people who'll actually use it and tell me the truth.
> Takes 10 minutes to connect. In? (Pioneer perks: pro tier free for life + founding
> reviewer badge.)

### 3.3 Daily rhythm (~1 h/day, calendar-blocked)
| When | What (all in /admin) |
|---|---|
| Morning 20' | Stats tab → cert queue (unstick >30 min) → feedback triage (critical first) |
| Midday 20' | Concierge onboarding: personally walk the next 1–2 testers through first connect |
| Evening 20' | Reply to every feedback item ≤24h (even "logged, thanks") · update tester group |

### 3.4 Weekly rhythm
- Mon: "what changed last week" message to the whole group (3 bullets max)
- Wed: 15-min call/voice-note with 3 different testers (rotate)
- Fri: metrics snapshot (see §3.5) into PROGRESS.md — one line, trend arrows

### 3.5 The only 4 metrics that matter
| Metric | Target | Red line |
|---|---|---|
| Activation (invite → first successful run) | >60% | <40% → stop inviting, fix onboarding |
| Time-to-first-success | <15 min | >30 min → onboarding is broken |
| Review completion (assigned → submitted) | >70% | reviewers ghosting → fix incentives NOW |
| Week-2 return rate | >50% | <30% → product isn't pulling, ask why in calls |

**Pre-committed kill/pivot rule:** if after 3 weeks activation <40% OR reviewers won't
review despite points — freeze invites, diagnose with 5 user calls, fix, re-test. Do not
add more users to a broken loop.

### 3.6 Invite unlock mechanic (already spec'd)
Each active tester earns **3 invites** after: listing 1 pipeline OR completing 3 reviews.
Manual during beta (Beta tab → vouchers). This makes growth a *product output*.

---

## 4. Phase 2 — Waves 2–3 (weeks 5–10): earn growth

Entry gate: §3.5 targets green for 2 consecutive weeks.

- [ ] Wave 2 (→30–40 users): activate earned invites; onboarding switches from concierge
      to docs-first (docs quality now gets tested for real)
- [ ] **Turn on Teams** (feature flag) — built-in viral loop; teams pull in teammates
- [ ] Ship `/marketplace/{slug}` public listing pages (SEO/GEO-indexable) — every
      certification becomes a shareable moment; creators promote their own listings
- [ ] Content drumbeat, 1×/week, build-in-public: the kappa calibration story, quorum
      math, blind-review design — engineering notes are the marketing (GEO: LLMs cite
      technical posts)
- [ ] Reviewer leaderboard + public reviewer count on site (supply-side pride)
- [ ] Wave 3 (→60–100): regional champions — recruit 1–2 non-English power users to
      validate the AI-translated locales (site + app drop-in JSON)

**Watch:** review capacity vs listing inflow. If queue age climbs, recruit reviewers
before recruiting creators. Reviewer supply is the business.

---

## 5. Phase 3 — Revenue bridge (months 3–5): sell while in beta

1. **MoR decision (one afternoon):** Paddle vs Lemon Squeezy against the UK company.
   Criteria: KYB friction for a UK non-resident co, payout rails, marketplace/split support.
   MoR = they handle global VAT/sales tax; buyers contract with MoR → future HK switch is
   a payment-account swap, not a replatform.
2. **First revenue = creator success, not subscriptions.** Certified listings sell at real
   prices; platform takes its cut. Pioneer promise honored: pro tiers free for life for
   the first 100. A marketplace that moved $500 of real pipelines beats 1,000 free signups.
3. **Pitch-ready numbers (track from day 1):** GMV · take rate · review-completion rate ·
   certified-listing count. These four prove the thesis (marketplace + trust supply).
4. **Subscriptions later:** Pro tiers for post-Pioneer users once free-tier limits are
   genuinely felt (not before — artificial limits during beta poison feedback).
5. **HK entity trigger:** revisit only at ~$30–50K/yr profit. UK company carries beta and
   first revenue. UK co stays IP holder permanently (Madrid IR constraint); licenses brand
   to HK opco when it exists.

---

## 6. Legal / IP calendar

| When | Action |
|---|---|
| Now | Submit UKIPO application (word mark, 9+42+35) |
| +4 months | UK registration expected (unopposed) |
| +4–6 months | **File Madrid** based on registered UK mark, inside priority window. First-wave designations: China (first-to-file urgency), EU, US (expect office action; budget US attorney). ~CHF 2,000–3,500 |
| Same time | **Hong Kong direct filing** (NOT covered by Madrid; ~HK$2,000 first class) |
| If US copycat spotted earlier | File US designation immediately — priority date wins |
| Before repo public | TRADEMARK.md + PROGRESS/scripts sweep for business-side content |
| HanZi | Naming decision + China availability check BEFORE any tooling/chassis print. "HanZi" likely unregistrable in China (descriptive). Trademark separately when named |

---

## 7. Founder time allocation (the honest version)

During beta, the coding team ships batches; the founder's irreplaceable jobs are:
1. **Concierge onboarding** (highest-leverage hour of every day)
2. **Tester conversations** (3/week minimum — this is product discovery)
3. **Public drumbeat** (1 post/week — compounds into GEO/waitlist)
4. **Batch acceptance** (run the acceptance checks in each AUDIT-FIXES batch; audit here)
5. **IP/legal calendar** (§6 — dates are hard deadlines)

Explicitly NOT founder jobs right now: writing code, designing logos, HK incorporation,
hardware marketing, multi-language content production.

---

## 8. Risk register (top 5, pre-answered)

| Risk | Mitigation |
|---|---|
| Reviewers don't review | Points→subscription-days already live; add leaderboard; founder reviews personally in wave 1; quorum already beta-lowered (~3) |
| Onboarding too hard (MCP still novel) | Concierge wave 1; OAuth auto-provisioning queued; demo video; docs quickstart URL fixed (D2) |
| A big player ships "certified AI workflows" | Speed + narrative: independent/neutral + blind human review is not credibly copyable by a model vendor; ship public listing pages early so the brand owns the category phrase |
| Beta stalls (metrics red) | Pre-committed kill rule §3.5 — freeze, 5 calls, fix, retest |
| Founder burnout / context thrash | §7 allocation; one batch in flight at a time; weekly PROGRESS.md line keeps perspective |

---

## 9. Definition of "beta graduated" (all true)

- [ ] 60+ users, ≥50% week-2 retention held for 4 weeks
- [ ] 15+ certified listings; median certification time < 72h
- [ ] Review completion ≥70% with zero founder nagging
- [ ] ≥10 real purchases (money moved through MoR)
- [ ] Teams used by ≥3 organic teams
- [ ] Public launch assets ready: demo video, 3 case studies from Pioneer members,
      /marketplace public pages indexed

Then: public launch = "Pioneer 100 graduates" story + open registration + repo public
(AGPL + TRADEMARK.md) + subscriptions on.

---

## 10. Repo Publication Protocol (execute at public launch — agent-runnable)

**Trigger:** founder explicitly says "run the repo publication protocol" AND all §9 boxes
are ticked. Never run proactively.

**Non-negotiable rule:** the current private repo (`youssef-hariri/deewaanai`) is NEVER
flipped to public. Its git history contains the full business strategy (DeeWaanAI-Next/
has been committed since the first push). Publication = fresh repo from a clean snapshot.

**Steps:**
1. **Split the business docs.** Create private repo `deewaanai-business`; move the entire
   `DeeWaanAI-Next/` directory there (plus any other business-side files found in step 3).
   The private app repo keeps operating as the deploy source.
2. **Prepare the public snapshot** in a scratch directory: copy the working tree at the
   chosen release commit, then delete: `DeeWaanAI-Next/`, `feedback-screenshots/`, `.env`,
   any `*.local` files, editor/agent caches.
3. **Business-content sweep** (grep-based, fix hits before proceeding):
   - `grep -ri "pioneer\|waitlist strategy\|pricing strategy\|trademark\|HanZi\|Eaglechip"`
     over `scripts/`, `README.md`, code comments — the beta-simulation / quorum-rehearsal
     scripts are known carriers of business content; rewrite or exclude them.
   - `grep -rn "youssefhariri\|/Users/" --include="*.ts" --include="*.md"` — no local paths.
4. **Secret scan** the snapshot with gitleaks (or trufflehog). Zero findings required.
   Also verify: `.env.example` contains placeholders only; no Railway tokens, DB URLs,
   deploy-key material anywhere.
5. **License & legal files** at snapshot root: `LICENSE` (AGPL-3.0), `TRADEMARK.md`
   (word mark "DeeWaanAI", UK registration number once granted; usage rules: no confusingly
   similar use, no implying endorsement; contact license@deewaanai.com), README with
   trademark notice. Confirm `license@deewaanai.com` appears as the contact (already the
   license header address).
6. **Publish:** new public repo `DeeWaanAI/deewaanai` (org, not personal account — register
   the org first if not done), push the snapshot as a single initial commit
   (`feat: initial public release`). Enable: issues, discussions; disable: wiki (docs live
   on deewaanai.com).
7. **Post-publish checks:** clone fresh, `npm ci && npm run check && npm test && npm run
   build` green from the public repo alone; GitHub UI search for "DeeWaanAI-Next",
   "pioneer", and one known secret pattern returns nothing.
8. **Wire-up (deliberate, later):** CI on the public repo; decide when/whether Railway
   deploys from it. Until then the private repo remains the source of truth; changes flow
   private → public via curated syncs.

**Rollback:** if anything sensitive is discovered post-publish, immediately set the public
repo to private (GitHub caches/forks may persist — treat any leaked secret as compromised
and rotate it), fix the snapshot, republish.
