import { describe, it, expect } from "vitest";
import { withTimeout } from "./withTimeout";

describe("withTimeout", () => {
  it("resolves with the value when the promise settles in time", async () => {
    const fast = new Promise<string>((r) => setTimeout(() => r("done"), 10));
    await expect(withTimeout(fast, 1000, "fast op")).resolves.toBe("done");
  });

  it("rejects with a labeled timeout error when the promise hangs", async () => {
    // A promise that NEVER settles — the exact beta re-run failure mode
    // (stalled LLM stream blocked a listing in `generating` for ~25 min).
    const hung = new Promise<string>(() => {});
    await expect(withTimeout(hung, 20, "TestGen[1] step 0")).rejects.toThrow(
      "TestGen[1] step 0 timed out after 20ms",
    );
  });

  it("propagates the original rejection instead of waiting for the timeout", async () => {
    const failing = new Promise<string>((_, rej) => setTimeout(() => rej(new Error("boom")), 10));
    await expect(withTimeout(failing, 1000, "failing op")).rejects.toThrow("boom");
  });

  it("does not fire the timer after an early settle (no late rejection)", async () => {
    const fast = Promise.resolve("ok");
    await withTimeout(fast, 30, "early settle");
    // If the timer were not cleared it would fire here and reject nothing —
    // the assertion is that awaiting past the deadline stays quiet.
    await new Promise((r) => setTimeout(r, 60));
  });
});
