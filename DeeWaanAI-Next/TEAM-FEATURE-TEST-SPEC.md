# Team Feature (TeamSync) — Automated Test Specification

Handoff for the coding team. Goal: the team feature currently has ZERO automated tests
(only the manual smoke script). Before the Teams flag turns on in Wave 2 (playbook §4),
it needs a regression suite that runs in the existing CI without new infrastructure.

**Architecture decision (already made):** three layers, matching the patterns that
already exist in this repo — no new frameworks, no mocking library.

| Layer | Pattern to copy | Runs in |
|---|---|---|
| 1. Pure unit | `api/services/entitlements.test.ts` | CI "gates" job (no DB) |
| 2. DB integration | `api/services/entitlements.integration.test.ts` (`describe.skipIf(!process.env.DATABASE_URL)`) | CI "integration" job (mysql:8 + redis:7 service containers, already configured) |
| 3. MCP E2E smoke | extend `scripts/smoke-teamsync.mjs` | manual / pre-deploy against a real environment |

---

## Part 0 — FIX FIRST: four permission gaps found during spec investigation

Tests must assert the CORRECT behavior, so these get fixed in the same batch. All in
`api/routers/team.ts`:

- **P0-1 `shareProject` (L322-L364):** only checks the project EXISTS, not that the
  caller owns it. Today any team admin can share ANY user's project to their team and
  read its pipelines via `getSharedPipelines` — privilege escalation. Fix: require
  `project.userId === ctx.user.id`.
- **P0-2 `importPipeline` (L542-L600) / `importAgent` (L605-L660):** source step/agent is
  fetched by raw id with no check that it belongs to a team-shared project / teammate.
  Any member can copy ANY pipeline step in the database by guessing ids. Fix: verify the
  source is reachable through one of the caller's teams (same join used by
  `getSharedPipelines` / `getSharedAgents`).
- **P0-3 `updateMemberRole` (L217-L255):** an admin can change the OWNER's role row
  (role enum excludes "owner" as a target, so this demotes the owner). Fix: reject when
  the target's current role is "owner".
- **P0-4 duplicate guards:** `team_members` and `team_projects` have no unique
  constraints (schema.ts L759, L779); `shareProject` double-insert creates duplicate
  share rows. Fix: add unique indexes `(team_id, user_id)` and `(team_id, project_id)`
  via a new migration (follow 017 conventions) + tolerate the DB error in code paths.

---

## Part 1 — Unit tests (no DB) — `api/routers/team.test.ts` + additions

1. **Invite code generator** (`generateInviteCode`, team.ts L16-L22): length 16,
   alphanumeric only, 1000 generations → 1000 unique values.
2. **Flag evaluation matrix** (`featureFlags.ts` isFeatureEnabled — refactor the pure
   decision into an exported helper if needed): enabled=1 → true regardless;
   enabled=0 + rollout=100 → true for any userId (the KNOWN PITFALL from PROGRESS.md
   L73 — this test documents it); enabled=0 + rollout=0 + user on allowlist → true;
   unknown flag → false; no userId + rollout>0 → false.
3. **Help catalog gating** (extend `api/mcp/tools/helpContent.test.ts`): exactly 8
   entries carry `flag: "teamsync"`; all are group "Team"; read tools carry `team:read`,
   write tools `team:write`.

## Part 2 — Integration tests (real MySQL/Redis) — `api/routers/team.integration.test.ts`

**Shared fixture helper** (put in `api/testUtils/teamFixture.ts`): creates users
Owner/Admin/Member/Outsider, one team (Owner creates; promote Admin), one project owned
by Owner shared to the team, one project owned by Outsider NOT shared. Returns ids +
a tRPC caller per user (follow the caller pattern used by portability tools). afterAll
deletes the team (cascades) + users + projects.

**Lifecycle:**
- T1 create → team row + owner membership (role "owner") + team_seats row seats=1, in
  one transaction; inviteCode present.
- T2 joinByCode with valid code → role "tester"; invalid code → "Invalid invite code";
  joining twice → "Already a member of this team"; duplicate row count stays 1 (P0-4).
- T3 listMyTeams / getTeam → myRole correct per user; Outsider getTeam → "Not a member
  of this team".
- T4 delete: Member attempts → "Only owner can delete"; Owner deletes → teams,
  team_members, team_projects, team_seats rows all gone (cascade assertion).

**Roles & permission boundaries (the heart of the suite):**
- T5 updateMemberRole: Owner promotes Member→admin OK; Member (tester) attempts →
  rejected; Admin attempts to change Owner's row → rejected (P0-3).
- T6 removeMember: self-removal allowed for any role; Member removing another → rejected;
  Admin removes Member → OK; anyone removing Owner → "Cannot remove team owner".
- T7 shareProject: Owner shares own project → OK; Admin shares OWNER's project →
  rejected after P0-1 fix (caller must own it); Admin shares Outsider's project →
  rejected (P0-1 — the escalation case); double-share → single row (P0-4).
- T8 importPipeline: Member imports step from team-shared project → copy created with
  "(imported)" suffix, disabled=true, appended step order, in Member's own target
  project; Member imports step id from the UNSHARED Outsider project → rejected (P0-2);
  target project not owned by caller → "Target project not found".
- T9 importAgent: same shape as T8; slug collision → "-imported" suffix.
- T10 getSharedPipelines/getSharedAgents: Member sees Owner's shared pipelines and
  teammates' agents; Outsider gets nothing/error; unshare removes visibility.

**Cross-router effects:**
- T11 project.list for Member includes the team-shared project; after unshareProject it
  disappears.
- T12 swarm `canAccessProject`: Member can access shared project's runs; Outsider cannot.

**Seat billing (no Stripe in CI — billing unconfigured):**
- T13 joinByCode and removeMember complete successfully with Stripe unconfigured
  (syncTeamSeatQuantity swallows errors — assert no throw, membership still correct).
- T14 billing.createTeamCheckout as non-owner → FORBIDDEN "Only the team owner can
  manage seat billing"; unconfigured billing → PRECONDITION_FAILED (503 path).

**Shared memory & locking (`api/services/sharedMemory.integration.test.ts`):**
- T15 access rule: getSharedContext on a project not shared with caller's teams →
  "Project is not shared with any of your teams"; shared → returns episodes/state/lock.
- T16 optimistic locking: two sequential bumpSharedStateActivity with the same stale
  version → second gets the conflict error; appendSharedEpisode still succeeds when the
  state bump conflicts (append-durability guarantee).

## Part 3 — MCP E2E (extend `scripts/smoke-teamsync.mjs`)

Keep the existing flag on/off tool-visibility assertions, add one deep scenario (new
phase "flow"): seed two users + team + shared project via SQL → JWT for user B →
`team_context_get` returns the seeded state → user A `team_handoff` to B → B's
`team_runs_list` shows waitingForYou → B `team_memory_append` → episode visible to A.
Exit nonzero on any step failure. This stays a manual/pre-deploy gate (needs a running
server), NOT wired into CI.

---

## Acceptance
1. Part 0 fixes merged with the tests that prove them (T5/T7/T8 + P0-4 migration).
2. `npm test` green locally without DB (integration specs skip cleanly).
3. CI integration job green — all T-cases running against the service containers.
4. `node scripts/smoke-teamsync.mjs flow` passes against a dev deployment.
5. No new dependencies added; vitest include pattern already covers the new files.

## Out of scope
- Frontend component tests (TeamDashboard/TeamConnect) — revisit if Teams UI churns.
- Stripe-live seat quantity assertions (requires Stripe test keys — post-beta).
- Load/concurrency testing of memory locks beyond T16.
