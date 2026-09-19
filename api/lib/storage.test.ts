// Tests for the upload storage abstraction (S3-compatible / disk backends).
// No network: the S3 selection test only constructs the backend (the SDK
// client is lazy and no request is made); the disk backend is exercised
// against a temp directory via the SCREENSHOT_DIR override.

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function freshStorage() {
  vi.resetModules();
  const mod = await import("./storage");
  return mod.getStorage();
}

describe("storage backend selection", () => {
  it("defaults to disk when S3 is not configured", async () => {
    expect((await freshStorage()).kind).toBe("disk");
  });

  it("selects s3 only when bucket + key + secret are ALL set", async () => {
    vi.stubEnv("S3_BUCKET", "uploads");
    expect((await freshStorage()).kind).toBe("disk"); // missing key+secret

    vi.stubEnv("S3_ACCESS_KEY_ID", "key");
    expect((await freshStorage()).kind).toBe("disk"); // missing secret

    vi.stubEnv("S3_SECRET_ACCESS_KEY", "secret");
    expect((await freshStorage()).kind).toBe("s3"); // all three set
  });
});

describe("disk backend", () => {
  async function diskStorage() {
    const dir = mkdtempSync(join(tmpdir(), "storage-test-"));
    tmpDirs.push(dir);
    vi.stubEnv("SCREENSHOT_DIR", dir);
    return freshStorage();
  }

  it("put → get round-trips bytes", async () => {
    const s = await diskStorage();
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
    await s.put("roundtrip.png", payload, "image/png");
    const got = await s.get("roundtrip.png");
    expect(got).not.toBeNull();
    expect(Buffer.compare(got!.body, payload)).toBe(0);
  });

  it("returns null for a missing object", async () => {
    const s = await diskStorage();
    expect(await s.get("does-not-exist.png")).toBeNull();
  });

  it("strips directory traversal from keys", async () => {
    const s = await diskStorage();
    await s.put("../../evil.png", Buffer.from("x"), "image/png");
    // Written inside the temp dir as "evil.png", retrievable by basename
    expect(await s.get("evil.png")).not.toBeNull();
    expect(await s.get("../../evil.png")).not.toBeNull();
  });
});
