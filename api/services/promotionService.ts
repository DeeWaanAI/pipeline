// ═══════════════════════════════════════════════════════════════════
//  PROMOTIONS — admin-defined free-days grants (migration 035)
// ═══════════════════════════════════════════════════════════════════
// A promotion grants N free days on the one flat subscription. It never changes
// the price: the grant travels to Stripe as `subscription_data.trial_period_days`
// on the Checkout Session, so billing continues to use the single price id and
// reconciles itself.
//
// Two audiences:
//   · 'new_signups' — granted automatically to an account that signed up inside
//     the promotion window and has never subscribed. This is "7 days free for
//     newcomers".
//   · 'code'        — granted only when the buyer types that code at checkout.
//
// Eligibility is a pure function (promotionEligible / pickPromotion) so the
// rules can be tested without a database or a Stripe account, and so the same
// answer comes back whether checkout is configured or not.

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { promotions, promotionRedemptions, subscriptions, users } from "@db/schema";
import { logger } from "../lib/logger";

export type PromotionAudience = "new_signups" | "code";
export type PromotionSource = "signup" | "code";

export interface PromotionCandidate {
  id: number;
  days: number;
  audience: PromotionAudience;
  code: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  maxRedemptions: number | null;
  active: boolean;
}

export interface EligibilityContext {
  /** When the grant is being evaluated. */
  now: Date;
  /** The account's own signup time — a newcomer offer is about WHEN they joined. */
  signupAt: Date;
  /** True when the account has any `subscriptions` row: it already paid once,
   *  so it is not a newcomer. Checked by the caller, not guessed here. */
  everSubscribed: boolean;
  /** Promotion ids this account already holds a redemption row for. */
  redeemedPromotionIds: number[];
  /** Live redemption count per promotion id (absent = none yet). */
  redemptionCounts?: Map<number, number>;
  /** The code typed at checkout, if any. */
  requestedCode?: string | null;
}

export type PromotionRejection =
  | "eligible"
  | "inactive"
  | "not_started"
  | "expired"
  | "not_new_signup"
  | "already_redeemed"
  | "sold_out"
  | "code_required"
  | "code_mismatch";

function normalizeCode(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().toUpperCase();
  return trimmed ? trimmed : null;
}

function withinWindow(at: Date, startsAt: Date | null, endsAt: Date | null): boolean {
  if (startsAt && at < startsAt) return false;
  if (endsAt && at > endsAt) return false;
  return true;
}

/** Why this promotion does or does not apply to this account right now. */
export function promotionEligible(p: PromotionCandidate, ctx: EligibilityContext): PromotionRejection {
  if (!p.active) return "inactive";
  if (ctx.now < (p.startsAt ?? ctx.now)) return "not_started";
  if (p.endsAt && ctx.now > p.endsAt) return "expired";
  if (ctx.redeemedPromotionIds.includes(p.id)) return "already_redeemed";
  if (p.maxRedemptions !== null && (ctx.redemptionCounts?.get(p.id) ?? 0) >= p.maxRedemptions) return "sold_out";

  if (p.audience === "new_signups") {
    // A newcomer offer is defined by WHEN the account joined, so an existing
    // account cannot pick up a launch promotion it was never addressed to.
    if (ctx.everSubscribed) return "not_new_signup";
    if (!withinWindow(ctx.signupAt, p.startsAt, p.endsAt)) return "not_new_signup";
    return "eligible";
  }

  // audience === 'code'
  const wanted = normalizeCode(ctx.requestedCode);
  if (!wanted) return "code_required";
  if (!p.code || wanted !== normalizeCode(p.code)) return "code_mismatch";
  return "eligible";
}

/**
 * The single grant to apply, or null. Nothing stacks: two active promotions that
 * both fit would produce one trial of unknown length, so the longer one wins and
 * ties break on the lower id — a deterministic answer that does not depend on
 * row order.
 */
export function pickPromotion(
  candidates: PromotionCandidate[],
  ctx: EligibilityContext,
): { promotion: PromotionCandidate; source: PromotionSource } | null {
  const eligible = candidates.filter((p) => promotionEligible(p, ctx) === "eligible");
  if (!eligible.length) return null;
  const best = eligible.reduce((a, b) =>
    b.days > a.days || (b.days === a.days && b.id < a.id) ? b : a,
  );
  return { promotion: best, source: best.audience === "new_signups" ? "signup" : "code" };
}

// ─── Database-backed operations ────────────────────────────────────

interface ResolutionInput {
  userId: number;
  requestedCode?: string | null;
  now?: Date;
}

/**
 * The trial days this account should get at checkout, or null. Reads only —
 * nothing is consumed here, because a Checkout Session that the buyer abandons
 * must not burn a place in a capped promotion. The redemption row is written by
 * the webhook once the subscription actually exists.
 */
export async function resolveTrialForCheckout(
  input: ResolutionInput,
): Promise<{ days: number; promotionId: number; source: PromotionSource } | null> {
  const db = getDb();
  const now = input.now ?? new Date();

  const [account] = await db
    .select({ createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!account?.createdAt) return null;

  const [subscribed] = await db
    .select({ one: sql<number>`1` })
    .from(subscriptions)
    .where(eq(subscriptions.userId, input.userId))
    .limit(1);

  const [rows, ownRedemptions, counts] = await Promise.all([
    db.select().from(promotions),
    db
      .select({ promotionId: promotionRedemptions.promotionId })
      .from(promotionRedemptions)
      .where(eq(promotionRedemptions.userId, input.userId)),
    db
      .select({
        promotionId: promotionRedemptions.promotionId,
        n: sql<number>`COUNT(*)`,
      })
      .from(promotionRedemptions)
      .groupBy(promotionRedemptions.promotionId),
  ]);

  const picked = pickPromotion(
    rows.map((r) => ({
      id: r.id,
      days: r.days,
      audience: r.audience,
      code: r.code,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      maxRedemptions: r.maxRedemptions,
      active: r.active,
    })),
    {
      now,
      signupAt: account.createdAt,
      everSubscribed: !!subscribed,
      redeemedPromotionIds: ownRedemptions.map((o) => o.promotionId),
      redemptionCounts: new Map(counts.map((c) => [c.promotionId, Number(c.n)])),
      requestedCode: input.requestedCode ?? null,
    },
  );

  if (!picked) return null;
  logger.info("Promotion applied to checkout", {
    userId: input.userId,
    promotionId: picked.promotion.id,
    days: picked.promotion.days,
    source: picked.source,
  });
  return { days: picked.promotion.days, promotionId: picked.promotion.id, source: picked.source };
}

/** Record the grant. Idempotent per (user, promotion): a repeated webhook
 *  delivery re-reads the same row instead of taking a second slot. */
export async function recordPromotionRedemption(opts: {
  userId: number;
  promotionId: number;
  days: number;
  source: PromotionSource;
}): Promise<void> {
  const db = getDb();
  const [existing] = await db
    .select({ id: promotionRedemptions.id })
    .from(promotionRedemptions)
    .where(and(
      eq(promotionRedemptions.userId, opts.userId),
      eq(promotionRedemptions.promotionId, opts.promotionId),
    ))
    .limit(1);
  if (existing) return;

  await db.insert(promotionRedemptions).values({
    userId: opts.userId,
    promotionId: opts.promotionId,
    days: opts.days,
    source: opts.source,
  });
}

export interface PromotionView extends PromotionCandidate {
  name: string;
  note: string | null;
  createdBy: number | null;
  createdAt: Date;
  redemptions: number;
  status: "live" | "scheduled" | "ended" | "disabled" | "sold_out";
}

function statusOf(p: PromotionCandidate & { redemptions: number }, now: Date): PromotionView["status"] {
  if (!p.active) return "disabled";
  if (p.startsAt && now < p.startsAt) return "scheduled";
  if (p.endsAt && now > p.endsAt) return "ended";
  if (p.maxRedemptions !== null && p.redemptions >= p.maxRedemptions) return "sold_out";
  return "live";
}

/** Everything the admin needs: each promotion with its live redemption count. */
export async function listPromotions(now = new Date()): Promise<PromotionView[]> {
  const db = getDb();
  const rows = await db.select({
    id: promotions.id,
    name: promotions.name,
    days: promotions.days,
    audience: promotions.audience,
    code: promotions.code,
    startsAt: promotions.startsAt,
    endsAt: promotions.endsAt,
    maxRedemptions: promotions.maxRedemptions,
    active: promotions.active,
    note: promotions.note,
    createdBy: promotions.createdBy,
    createdAt: promotions.createdAt,
    redemptions: sql<number>`(SELECT COUNT(*) FROM promotion_redemptions pr WHERE pr.promotion_id = promotions.id)`,
  }).from(promotions);

  return rows
    .map((r) => ({
      ...r,
      redemptions: Number(r.redemptions),
      status: statusOf({ ...r, redemptions: Number(r.redemptions) }, now),
    }))
    .sort((a, b) => b.id - a.id);
}

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

export interface CreatePromotionInput {
  name: string;
  days: number;
  audience: PromotionAudience;
  code?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  maxRedemptions?: number | null;
  note?: string | null;
}

/** Validate in code, not in the caller: an admin typo here is a promotion that
 *  runs against real money the moment billing is configured. */
export function validatePromotion(input: CreatePromotionInput): string | null {
  if (!input.name.trim()) return "A name is required.";
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 365) {
    return "Free days must be a whole number between 1 and 365.";
  }
  if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
    return "The end of the window must be after its start.";
  }
  if (input.maxRedemptions !== null && input.maxRedemptions !== undefined
    && (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1)) {
    return "The redemption cap must be at least 1, or left empty for unlimited.";
  }
  if (input.audience === "code") {
    const code = normalizeCode(input.code);
    if (!code) return "A code promotion needs a code.";
    if (!CODE_PATTERN.test(code)) {
      return "Codes are 3-32 characters: letters, digits, underscore or hyphen.";
    }
  }
  return null;
}

export async function createPromotion(
  input: CreatePromotionInput,
  actorId: number,
): Promise<PromotionView> {
  const problem = validatePromotion(input);
  if (problem) throw new Error(problem);

  const db = getDb();
  const code = input.audience === "code" ? normalizeCode(input.code) : null;
  if (code) {
    const [clash] = await db.select({ id: promotions.id }).from(promotions)
      .where(eq(promotions.code, code)).limit(1);
    if (clash) throw new Error(`The code ${code} is already used by promotion #${clash.id}.`);
  }

  const [inserted] = await db.insert(promotions).values({
    name: input.name.trim(),
    days: input.days,
    audience: input.audience,
    code,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    maxRedemptions: input.maxRedemptions ?? null,
    active: true,
    note: input.note?.trim() || null,
    createdBy: actorId,
  });
  const id = Number((inserted as unknown as { insertId: number }).insertId);
  logger.info("Promotion created", { promotionId: id, days: input.days, audience: input.audience, actorId });

  const all = await listPromotions();
  const view = all.find((p) => p.id === id);
  if (!view) throw new Error("Promotion created but could not be read back");
  return view;
}

/** Flip `active`. Rows already granted are untouched — a redemption record is
 *  the account's, not a pointer into this table, so stopping a promotion stops
 *  future grants and rewrites nobody's history. */
export async function setPromotionActive(
  promotionId: number,
  active: boolean,
  actorId: number,
): Promise<void> {
  const db = getDb();
  const [row] = await db.select({ id: promotions.id })
    .from(promotions)
    .where(eq(promotions.id, promotionId))
    .limit(1);
  if (!row) throw new Error("Promotion not found");
  await db.update(promotions).set({ active }).where(eq(promotions.id, promotionId));
  logger.info("Promotion toggled", { promotionId, active, actorId });
}
