// Queue dispatch/dedupe semantics, on the in-memory backend (D9 finding 24).

import { describe, expect, it, vi } from "vitest";

vi.mock("./redis", () => ({
  isRedisEnabled: () => false,
  getRedis: async () => null,
}));

import { createQueue } from "./queue";

describe("createQueue idempotency", () => {
  it("swallows a second enqueue with the same key", async () => {
    const queue = createQueue(`t-dedup-${Math.random().toString(36).slice(2)}`);
    try {
      const first = await queue.enqueue("run", { id: 1 }, { idempotencyKey: "k-1" });
      const second = await queue.enqueue("run", { id: 1 }, { idempotencyKey: "k-1" });
      expect(first).not.toMatch(/^dedup:/);
      expect(second).toBe("dedup:k-1");
    } finally {
      await queue.close();
    }
  });

  it("re-dispatches when the caller has proved the work is still outstanding", async () => {
    // The reconciler's whole job is to notice that nothing is coming and
    // dispatch again. With a 24h dedupe window and no escape hatch it logged
    // nothing and did nothing, so a benchmark left `queued` by a restart stayed
    // queued for a day.
    const queue = createQueue(`t-force-${Math.random().toString(36).slice(2)}`);
    try {
      await queue.enqueue("run", { id: 1 }, { idempotencyKey: "k-2" });
      const forced = await queue.enqueue("run", { id: 1 }, { idempotencyKey: "k-2", force: true });
      expect(forced).not.toMatch(/^dedup:/);
      // and the key is still live for everyone else
      expect(await queue.enqueue("run", { id: 1 }, { idempotencyKey: "k-2" })).toBe("dedup:k-2");
    } finally {
      await queue.close();
    }
  });
});
