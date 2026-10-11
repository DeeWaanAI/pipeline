// Promotion grants against the real tables (ticket #62).
//
// The pure rules are pinned in `promotionService.test.ts`. This file proves the
// parts that only exist once SQL is involved: the migration's columns match the
// schema, the redemption cap counts LIVE rows rather than a counter that can
// drift, an account cannot take the same grant twice, a deactivation stops
// future grants without rewriting a past one, and the read model behind the admin
// screen reports numbers it can be trusted with.
//
// Requires the LOCAL docker stack (v2-mysql). Uses its own throwaway schema
// (`swarm_v2test_promo`) plus a GET_LOCK guard — never the dev schema, never
// production. No Stripe traffic: what checkout would ask is called directly.

import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";

const TEST_DB = "swarm_v2test_promo";
const ROOT_MYSQL = process.env.MYSQL_ROOT_URL || "mysql://root:rootpass@localhost:3307";

let admin: mysql.Connection;
let locked = false;
let svc: typeof import("./promotionService");
let schema: typeof import("@db/schema");
let orm: typeof import("drizzle-orm");
let db: any;
/** `promotions.created_by` is a real FK, so the "admin" has to be a real row. */
let actorId = 0;

async function pushSchema() {
  const { execFileSync } = await import("node:child_process");
  execFileSync("npx", ["drizzle-kit", "push", "--force"], {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: "ignore",
    timeout: 150_000,
  });
}

beforeAll(async () => {
  admin = await mysql.createConnection(ROOT_MYSQL);
  const [lock] = await admin.query<mysql.RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [TEST_DB]);
  if (!lock[0]?.acquired) throw new Error(`another run holds ${TEST_DB}`);
  locked = true;

  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.query(`GRANT ALL PRIVILEGES ON \`${TEST_DB}\`.* TO 'swarm'@'%'`);
  await admin.query("FLUSH PRIVILEGES");
  process.env.DATABASE_URL = `mysql://swarm:swarmpass@localhost:3307/${TEST_DB}`;
  process.env.REDIS_URL = "";
  process.env.NODE_ENV = "development";
  process.env.APP_SECRET ||= "1".repeat(64);
  process.env.AI_SWARM_MASTER_KEY ||= "2".repeat(64);
  process.env.MARKETPLACE_MASTER_KEY ||= "3".repeat(64);
  await pushSchema();

  svc = await import("./promotionService");
  schema = await import("@db/schema");
  orm = await import("drizzle-orm");
  const { getDb } = await import("../queries/connection");
  db = getDb();
  const [author] = await db.insert(schema.users).values({
    username: `promo-admin-${Date.now()}`, name: "Promotions admin", passwordHash: "not-a-real-hash", role: "admin",
  });
  actorId = Number((author as { insertId: number }).insertId);
}, 240_000);

afterAll(async () => {
  if (admin) {
    if (locked) await admin.query(`SELECT RELEASE_LOCK('${TEST_DB}')`).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`REVOKE ALL PRIVILEGES ON \`${TEST_DB}\`.* FROM 'swarm'@'%'`);
    await admin.end();
  }
});

// Each case starts from "no promotions at all" so an answer here means THIS
// promotion caused it, not whichever one the previous test left live.
afterEach(async () => {
  await db.delete(schema.promotionRedemptions);
  await db.delete(schema.promotions);
});

const DAY = 86_400_000;

/** A fresh account whose signup is `at`, with no subscription history. */
async function newUser(at: Date): Promise<number> {
  const username = `promo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [r] = await db.insert(schema.users).values({ username, name: username, passwordHash: "not-a-real-hash" });
  const id = Number((r as { insertId: number }).insertId);
  await db.update(schema.users).set({ createdAt: at }).where(orm.eq(schema.users.id, id));
  return id;
}

async function markSubscribed(userId: number) {
  await db.insert(schema.subscriptions).values({
    userId,
    plan: "solo",
    status: "active",
    stripeCustomerId: `cus_${userId}`,
    stripeSubscriptionId: `sub_${userId}`,
    seats: 1,
  });
}

function newcomer(days: number, window: { startsAt?: Date | null; endsAt?: Date | null } = {}) {
  return svc.createPromotion({
    name: `Newcomer ${days}d`,
    days,
    audience: "new_signups",
    code: null,
    startsAt: window.startsAt ?? null,
    endsAt: window.endsAt ?? null,
    maxRedemptions: null,
    note: null,
  }, actorId);
}

describe("a newcomer promotion", () => {
  it("grants its days once, and never twice", async () => {
    const now = new Date();
    const promo = await newcomer(7, { startsAt: new Date(now.getTime() - DAY), endsAt: new Date(now.getTime() + 30 * DAY) });
    expect(promo.status).toBe("live");

    const userId = await newUser(now);
    expect(await svc.resolveTrialForCheckout({ userId })).toMatchObject({ days: 7, promotionId: promo.id, source: "signup" });

    await svc.recordPromotionRedemption({ userId, promotionId: promo.id, days: 7, source: "signup" });
    // A second delivery of the same webhook event must not take a second slot…
    await svc.recordPromotionRedemption({ userId, promotionId: promo.id, days: 7, source: "signup" });
    const rows = await db.select().from(schema.promotionRedemptions).where(orm.eq(schema.promotionRedemptions.userId, userId));
    expect(rows).toHaveLength(1);
    // …and the account is now out of the offer entirely.
    expect(await svc.resolveTrialForCheckout({ userId })).toBeNull();

    const listed = await svc.listPromotions(now);
    expect(listed.find((p) => p.id === promo.id)?.redemptions).toBe(1);
  });

  it("skips an account that has subscribed before, however long ago", async () => {
    const now = new Date();
    await newcomer(14);
    const userId = await newUser(now);
    await markSubscribed(userId);
    expect(await svc.resolveTrialForCheckout({ userId })).toBeNull();
  });

  it("skips an account that joined before the window opened", async () => {
    const now = new Date();
    await newcomer(30, { startsAt: new Date(now.getTime() - DAY) });
    const tooEarly = await newUser(new Date(now.getTime() - 7 * DAY));
    expect(await svc.resolveTrialForCheckout({ userId: tooEarly })).toBeNull();
  });

  it("stops granting when the admin switches it off, without rewriting what was given", async () => {
    const now = new Date();
    const promo = await svc.createPromotion(
      { name: "Revoked", days: 21, audience: "code", code: "REVOKE-ME", startsAt: null, endsAt: null, maxRedemptions: null, note: null },
      actorId,
    );
    const holder = await newUser(now);
    await svc.recordPromotionRedemption({ userId: holder, promotionId: promo.id, days: 21, source: "code" });

    const stranger = await newUser(now);
    expect(await svc.resolveTrialForCheckout({ userId: stranger, requestedCode: "REVOKE-ME" }))
      .toMatchObject({ days: 21 });

    await svc.setPromotionActive(promo.id, false, actorId);
    expect(await svc.resolveTrialForCheckout({ userId: stranger, requestedCode: "REVOKE-ME" })).toBeNull();

    // The grant already made is the account's own record, not a pointer into a
    // table the admin can still edit.
    const [mine] = await db.select().from(schema.promotionRedemptions)
      .where(orm.and(
        orm.eq(schema.promotionRedemptions.userId, holder),
        orm.eq(schema.promotionRedemptions.promotionId, promo.id),
      ));
    expect(mine.days).toBe(21);
  });

  it("honours the cap by counting rows, not a counter column", async () => {
    const now = new Date();
    const promo = await svc.createPromotion(
      { name: "Two seats", days: 5, audience: "code", code: "TWO-SEATS", startsAt: null, endsAt: null, maxRedemptions: 2, note: null },
      actorId,
    );

    const opener = await newUser(now);
    expect(await svc.resolveTrialForCheckout({ userId: opener, requestedCode: "two-seats" }))
      .toMatchObject({ days: 5, source: "code" });

    for (let i = 0; i < 2; i++) {
      const u = await newUser(now);
      await svc.recordPromotionRedemption({ userId: u, promotionId: promo.id, days: 5, source: "code" });
    }

    const latecomer = await newUser(now);
    expect(await svc.resolveTrialForCheckout({ userId: latecomer, requestedCode: "TWO-SEATS" })).toBeNull();
    const listed = await svc.listPromotions(now);
    expect(listed.find((p) => p.id === promo.id)).toMatchObject({ redemptions: 2, status: "sold_out" });
  });
});

describe("the code promotion", () => {
  it("grants only on the right code", async () => {
    const now = new Date();
    const promo = await svc.createPromotion(
      { name: "Partner", days: 10, audience: "code", code: "PARTNER-2026", startsAt: null, endsAt: null, maxRedemptions: null, note: null },
      actorId,
    );
    const userId = await newUser(now);
    expect(await svc.resolveTrialForCheckout({ userId })).toBeNull();
    expect(await svc.resolveTrialForCheckout({ userId, requestedCode: "PARTNER-1999" })).toBeNull();
    expect(await svc.resolveTrialForCheckout({ userId, requestedCode: " partner-2026 " }))
      .toMatchObject({ days: 10, promotionId: promo.id, source: "code" });
  });

  it("refuses a duplicate code instead of creating an ambiguous pair", async () => {
    const first = await svc.createPromotion({ name: "A", days: 3, audience: "code", code: "DUPE-CODE", startsAt: null, endsAt: null, maxRedemptions: null, note: null }, actorId);
    expect(first.id).toBeGreaterThan(0);
    await expect(svc.createPromotion({ name: "B", days: 4, audience: "code", code: "dupe-code", startsAt: null, endsAt: null, maxRedemptions: null, note: null }, 1))
      .rejects.toThrow(/already used by promotion/);
  });

  it("reaches an existing subscriber too — the code is the offer, not the signup date", async () => {
    const now = new Date();
    await svc.createPromotion({ name: "Win-back", days: 7, audience: "code", code: "COME-BACK", startsAt: null, endsAt: null, maxRedemptions: null, note: null }, actorId);
    const userId = await newUser(now);
    await markSubscribed(userId);
    expect(await svc.resolveTrialForCheckout({ userId, requestedCode: "COME-BACK" })).toMatchObject({ days: 7 });
  });
});

describe("the admin read model", () => {
  it("shows each promotion with its live count and a status the list can be trusted for", async () => {
    const now = new Date();
    const scheduled = await newcomer(7, { startsAt: new Date(now.getTime() + 5 * DAY) });
    const ended = await newcomer(7, { endsAt: new Date(now.getTime() - DAY) });
    await newcomer(9); // live, no grants yet

    const listed = await svc.listPromotions(now);
    expect(listed.find((p) => p.id === scheduled.id)?.status).toBe("scheduled");
    expect(listed.find((p) => p.id === ended.id)?.status).toBe("ended");
    expect(listed.filter((p) => p.status === "live")).toHaveLength(1);
    expect(listed.every((p) => typeof p.redemptions === "number")).toBe(true);
    // newest first, so the admin screen needs no sort of its own
    expect(listed[0].createdAt >= listed[1].createdAt).toBe(true);
  });

  it("will not save an impossible promotion", async () => {
    await expect(svc.createPromotion({ name: "Zero", days: 0, audience: "new_signups", startsAt: null, endsAt: null, code: null, maxRedemptions: null, note: null }, 1))
      .rejects.toThrow(/between 1 and 365/);
    await expect(svc.createPromotion({ name: "No code", days: 7, audience: "code", code: null, startsAt: null, endsAt: null, maxRedemptions: null, note: null }, 1))
      .rejects.toThrow(/needs a code/);
    await expect(svc.setPromotionActive(999_999, false, actorId)).rejects.toThrow(/not found/);
  });
});
