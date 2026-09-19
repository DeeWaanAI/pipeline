// Integration tests (audit finding #14): exercise the entitlement grant/revoke
// path and the Redis-backed rate limiter against REAL infrastructure.
//
// These run in the CI `integration` job, where MySQL + Redis service
// containers provide DATABASE_URL / REDIS_URL and the schema is created with
// `npm run db:push` beforehand. Locally (no env) they are SKIPPED so
// `npm test` stays hermetic and pure-function.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { users, entitlements } from "@db/schema";
import { can, grant, revoke, resolveCapabilities } from "./entitlements";
import { checkCustomerRateLimit } from "../lib/rateLimiter";

const hasDb = !!process.env.DATABASE_URL;
const hasRedis = !!process.env.REDIS_URL;

describe.skipIf(!hasDb)("entitlements (integration: real MySQL)", () => {
  let userId = 0;
  const username = `integration-${Date.now()}`;
  const capability = "pipeline:run:integration-test";

  beforeAll(async () => {
    const db = getDb();
    const result = await db.insert(users).values({ username, name: "Integration Test" });
    userId = Number(result[0].insertId);
    expect(userId).toBeGreaterThan(0);
  });

  afterAll(async () => {
    const db = getDb();
    // Clean up fixtures so repeated CI runs stay idempotent.
    await db.delete(entitlements).where(eq(entitlements.subjectId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("grant → can → revoke round-trip against a real database", async () => {
    expect(await can(userId, capability)).toBe(false);

    await grant({
      subjectType: "user",
      subjectId: userId,
      capability,
      source: "manual",
      sourceRef: "integration-test",
    });
    expect(await can(userId, capability)).toBe(true);

    const removed = await revoke({
      subjectType: "user",
      subjectId: userId,
      capability,
    });
    expect(removed).toBeGreaterThan(0);
    expect(await can(userId, capability)).toBe(false);
  });

  it("resolveCapabilities unions explicit entitlement grants", async () => {
    await grant({
      subjectType: "user",
      subjectId: userId,
      capability,
      source: "manual",
      sourceRef: "integration-test",
    });
    const { capabilities, tier } = await resolveCapabilities(userId);
    expect(tier).toBe("standard");
    expect(capabilities).toContain(capability);
  });
});

describe.skipIf(!hasRedis)("rate limiter (integration: real Redis)", () => {
  it("checkCustomerRateLimit enforces the solo fixed window via Redis", async () => {
    const key = `integration:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    // Solo budget is 60 req/min — the 61st sequential call must be denied.
    let last = await checkCustomerRateLimit(key, "solo");
    for (let i = 0; i < 60; i++) {
      last = await checkCustomerRateLimit(key, "solo");
    }
    expect(last.allowed).toBe(false);
    expect(last.retryAfterMs).toBeGreaterThan(0);
    expect(last.limit).toBe(60);
  });
});
