import { z } from "zod";
import { createRouter, authedQuery, adminQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { users, vouchers } from "@db/schema";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { logger } from "../lib/logger";

export const voucherRouter = createRouter({
  // Admin: generate a voucher code
  generate: adminQuery
    .input(z.object({
      tier: z.enum(["pro_designer", "pro_auto"]),
      durationDays: z.number().min(1).max(365).default(30),
      maxUses: z.number().min(1).max(1000).default(1),
      label: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const code = nanoid(12).toUpperCase();
      const db = getDb();

      await db.insert(vouchers).values({
        code,
        tier: input.tier,
        durationDays: input.durationDays,
        maxUses: input.maxUses,
        usedCount: 0,
        label: input.label ?? null,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days to redeem
        createdBy: 0, // admin
      });

      logger.info("Voucher generated", { code, tier: input.tier, maxUses: input.maxUses });
      return { code, tier: input.tier, durationDays: input.durationDays, maxUses: input.maxUses };
    }),

  // Admin: list all vouchers
  list: adminQuery.query(async () => {
    const db = getDb();
    return db.select().from(vouchers).orderBy(sql`${vouchers.createdAt} DESC`);
  }),

  // Any authenticated user: redeem a voucher
  redeem: authedQuery
    .input(z.object({ code: z.string().min(6).max(20) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const code = input.code.trim().toUpperCase();

      const [voucher] = await db.select().from(vouchers).where(eq(vouchers.code, code)).limit(1);
      if (!voucher) throw new Error("Invalid voucher code");

      // Check expiry
      if (voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) {
        throw new Error("This voucher has expired");
      }

      // Check max uses
      if (voucher.usedCount >= voucher.maxUses) {
        throw new Error("This voucher has been fully redeemed");
      }

      // Check if user already redeemed this voucher
      const existingRedemption = await db.execute(
        sql`SELECT id FROM voucher_redemptions WHERE voucher_id = ${voucher.id} AND user_id = ${ctx.user.id}`
      );
      if ((existingRedemption as any[]).length > 0) {
        throw new Error("You have already redeemed this voucher");
      }

      // Apply tier upgrade
      const expiresAt = new Date(Date.now() + voucher.durationDays * 24 * 60 * 60 * 1000);
      await db.update(users)
        .set({ tier: voucher.tier })
        .where(eq(users.id, ctx.user.id));

      // Record redemption
      await db.execute(
        sql`INSERT INTO voucher_redemptions (voucher_id, user_id, redeemed_at, tier_expires_at) VALUES (${voucher.id}, ${ctx.user.id}, NOW(), ${expiresAt})`
      );

      // Increment usage count
      await db.update(vouchers)
        .set({ usedCount: voucher.usedCount + 1 })
        .where(eq(vouchers.id, voucher.id));

      logger.info("Voucher redeemed", { code, userId: ctx.user.id, tier: voucher.tier });
      return { success: true, tier: voucher.tier, expiresAt: expiresAt.toISOString() };
    }),
});
