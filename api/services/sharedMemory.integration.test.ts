// Integration tests for shared memory service (real MySQL + disk).
// T15: access rules (non-shared project rejected).
// T16: optimistic locking (sequential bumps with stale version → conflict).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTeamFixture, cleanupTeamFixture, type TeamFixture } from "../testUtils/teamFixture";
import {
  getSharedContext,
  appendSharedEpisode,
  bumpSharedStateActivity,
} from "./sharedMemory";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("sharedMemory (integration: real MySQL)", () => {
  let f: TeamFixture;

  beforeAll(async () => {
    f = await createTeamFixture();
  });

  afterAll(async () => {
    if (f) await cleanupTeamFixture(f);
  });

  // ─── T15 access rule ────────────────────────────────────────────────
  it("T15: getSharedContext rejects non-shared project", async () => {
    await expect(
      getSharedContext(f.member.id, f.unsharedProjectId),
    ).rejects.toThrow("Project is not shared with any of your teams");
  });

  it("T15: getSharedContext returns episodes/state/lock for shared project", async () => {
    const ctx = await getSharedContext(f.member.id, f.sharedProjectId);
    expect(ctx.projectId).toBe(f.sharedProjectId);
    expect(typeof ctx.episodeCount).toBe("number");
    expect(Array.isArray(ctx.episodes)).toBe(true);
    expect(ctx.lockVersion).toBeNull(); // no state written yet
  });

  // ─── T16 optimistic locking ─────────────────────────────────────────
  it("T16: two sequential bumps with same stale version → second conflicts", async () => {
    // First bump: version null → ensureLockRow creates version 1, bumps to 2
    const first = await bumpSharedStateActivity(
      f.member.id,
      f.sharedProjectId,
      "First activity",
    );
    expect(first.version).toBe(2);

    // Second bump using the SAME expected version (simulating stale read)
    // The first bump moved the lock from 1→2, so passing expectedVersion=1 should conflict
    await expect(
      bumpSharedStateActivity(f.member.id, f.sharedProjectId, "Second activity", 1),
    ).rejects.toThrow("Shared project state changed since your last read");
  });

  it("T16: appendSharedEpisode succeeds even when state bump conflicts", async () => {
    // Append is independent of state lock
    const result = await appendSharedEpisode(
      f.member.id,
      f.sharedProjectId,
      "Episode during lock test",
      "test",
    );
    expect(result.episodeId).toMatch(/^ep-/);
    expect(result.episodeCount).toBeGreaterThan(0);
  });
});
