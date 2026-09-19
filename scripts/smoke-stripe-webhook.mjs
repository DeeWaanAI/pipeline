// ═══════════════════════════════════════════════════════════════════
//  OFFLINE SMOKE — Stripe webhook → marketplace entitlement grant/revoke
// ═══════════════════════════════════════════════════════════════════
// Verifies the POST /api/billing/stripe-webhook → entitlementSync path
// OFFLINE (no Stripe network calls):
//
//   1. Seeds a buyer (reuses an existing user), a pipeline template, and a
//      marketplace listing directly in MySQL.
//   2. Crafts a `checkout.session.completed` event with marketplace_purchase
//      metadata, signs it with a REAL Stripe webhook signature
//      (stripe.webhooks.generateTestHeaderString — the SDK's official test
//      helper, same HMAC constructEvent verifies), POSTs it to the app.
//   3. Asserts in MySQL: marketplace_purchases row (active), entitlement
//      `pipeline:run:<listingId>` (source=purchase), sales_count incremented.
//   4. Replays the same event → handler must answer duplicate:true and the
//      DB must still hold exactly ONE purchase (idempotency_keys claim).
//   5. Posts a bogus signature → must be rejected 400.
//   6. Crafts a `charge.refunded` event for the same payment intent →
//      asserts purchase status=refunded, entitlement row gone, sales_count
//      back to the pre-test value.
//
// USAGE
//   # 1. Boot the app with test Stripe env (any non-empty values — the
//   #    covered flows make NO live Stripe API calls):
//   #      STRIPE_SECRET_KEY=sk_test_smoke \
//   #      STRIPE_WEBHOOK_SECRET=whsec_smoke_local \
//   #      npm run dev                      # or: node dist/boot.js
//   #
//   # 2. Run this script with the SAME webhook secret:
//   #      STRIPE_WEBHOOK_SECRET=whsec_smoke_local \
//   #      node scripts/smoke-stripe-webhook.mjs http://127.0.0.1:3000
//   #
//   # Args/env:
//   #   argv[2]               baseUrl of the running app (required)
//   #   --keep                leave seeded fixtures + purchase rows in the DB
//   #   STRIPE_WEBHOOK_SECRET (required) must match the app's env
//   #   DATABASE_URL          (required; falls back to parsing ../.env)
//   #
//   # Expected output: PASS lines per check, then "SMOKE stripe-webhook OK".
//   # Requires at least one row in `users` (the first signup becomes admin).
//
// OFFLINE LIMITATIONS (deliberately NOT covered here):
//   - `checkout.session.completed` with metadata.type="team_seats" calls
//     stripe.subscriptions.retrieve() — a LIVE Stripe API call. It cannot be
//     tested offline and is excluded rather than faked. Cover it with the
//     live test-card cycle in DeeWaanAI-Next/ACCEPTANCE.md (section A).
//   - Stripe Checkout session CREATION (billing.checkout etc.) also calls
//     the live API and is out of scope; this script exercises webhook
//     PROCESSING only.
//   - All other webhook branches (marketplace purchase/refund covered here;
//     generic + team subscription.updated/deleted) make no Stripe API calls.
// ═══════════════════════════════════════════════════════════════════
import fs from "fs";
import Stripe from "stripe";
import mysql from "mysql2/promise";

// ─── Args & env ─────────────────────────────────────────────────────
const BASE = (process.argv[2] || "").replace(/\/+$/, "");
const KEEP = process.argv.includes("--keep");
if (!BASE) {
  console.error("usage: STRIPE_WEBHOOK_SECRET=whsec_... node scripts/smoke-stripe-webhook.mjs <baseUrl> [--keep]");
  process.exit(2);
}

let envFile = "";
try { envFile = fs.readFileSync(new URL("../.env", import.meta.url), "utf8"); } catch { /* .env optional */ }
const fromEnvFile = (k) => (envFile.match(new RegExp(`^${k}=["']?([^"'\\n]+)`, "m")) || [])[1] || "";

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const DATABASE_URL = process.env.DATABASE_URL || fromEnvFile("DATABASE_URL");
if (!WEBHOOK_SECRET) {
  console.error("STRIPE_WEBHOOK_SECRET is required and must match the value the app was booted with.");
  process.exit(2);
}
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required (env or .env).");
  process.exit(2);
}

// Offline signing client — the key is never used for network calls.
const stripe = new Stripe("sk_test_smoke_offline");

const fails = [];
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) fails.push(name);
};

const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const SESSION_ID = `cs_test_smoke_${run}`;
const PI_ID = `pi_smoke_${run}`;
const EVT_PURCHASE = `evt_smoke_purchase_${run}`;
const EVT_REFUND = `evt_smoke_refund_${run}`;
const AMOUNT_CENTS = 2500; // $25.00 — matches the seeded listing price

let conn;
let templateId = null;
let listingId = null;
let capability = null;

/** Sign `payload` (string) exactly the way Stripe signs webhook deliveries. */
function sign(payload) {
  return stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
}

async function postEvent(payload, signature) {
  return fetch(`${BASE}/api/billing/stripe-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
}

try {
  conn = await mysql.createConnection({ uri: DATABASE_URL });

  // ─── Fixtures: buyer + template + listing ──────────────────────────
  const [[buyer]] = await conn.query("SELECT id, username FROM users ORDER BY (role='admin') DESC, id LIMIT 1");
  if (!buyer) throw new Error("no users in DB — sign up once in the app first (first user becomes admin)");

  const [tpl] = await conn.query(
    "INSERT INTO pipeline_templates (user_id, name, description, steps, is_auto) VALUES (?, ?, ?, ?, 0)",
    [buyer.id, `smoke-template-${run}`, "smoke-stripe-webhook fixture",
      JSON.stringify([{ name: "s1", role: "assistant", systemPrompt: "smoke" }])],
  );
  templateId = tpl.insertId;

  const [lst] = await conn.query(
    "INSERT INTO marketplace_listings (creator_id, template_id, title, price, status) VALUES (?, ?, ?, '25.00', 'published')",
    [buyer.id, templateId, `smoke-listing-${run}`],
  );
  listingId = lst.insertId;
  capability = `pipeline:run:${listingId}`;

  const [[before]] = await conn.query("SELECT sales_count FROM marketplace_listings WHERE id = ?", [listingId]);
  const salesBefore = Number(before?.sales_count ?? 0);
  console.log(`fixtures: buyer=${buyer.id} (${buyer.username}) template=${templateId} listing=${listingId} sales_before=${salesBefore}`);

  // ─── 1. checkout.session.completed (marketplace_purchase) ─────────
  const purchaseEvent = JSON.stringify({
    id: EVT_PURCHASE,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: SESSION_ID,
        object: "checkout.session",
        amount_total: AMOUNT_CENTS,
        currency: "usd",
        payment_intent: PI_ID,
        metadata: { type: "marketplace_purchase", userId: String(buyer.id), listingId: String(listingId) },
      },
    },
  });

  const res1 = await postEvent(purchaseEvent, sign(purchaseEvent));
  const body1 = res1.status === 200 ? await res1.json() : null;
  if (res1.status === 503) {
    check("webhook configured", false,
      "503 billing not configured — boot the app with STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (see header)");
    throw new Error("aborting: app has no billing config");
  }
  check("checkout.session.completed accepted", res1.status === 200 && body1?.received === true,
    `status ${res1.status} ${JSON.stringify(body1)}`);

  const [[purchase]] = await conn.query(
    "SELECT id, status, amount_paid, stripe_payment_intent_id FROM marketplace_purchases WHERE stripe_session_id = ?",
    [SESSION_ID],
  );
  check("purchase row inserted (active, $25.00, PI stored)",
    purchase?.status === "active" && Number(purchase?.amount_paid) === 25 && purchase?.stripe_payment_intent_id === PI_ID,
    purchase ? `id=${purchase.id} status=${purchase.status} amount=${purchase.amount_paid}` : "no row");

  const [grants] = await conn.query(
    "SELECT id FROM entitlements WHERE subject_type='user' AND subject_id=? AND capability=? AND source='purchase' AND source_ref=?",
    [buyer.id, capability, SESSION_ID],
  );
  check(`entitlement ${capability} granted`, grants.length === 1, `${grants.length} row(s)`);

  const [[afterPurchase]] = await conn.query("SELECT sales_count FROM marketplace_listings WHERE id = ?", [listingId]);
  check("listing sales_count incremented", Number(afterPurchase?.sales_count) === salesBefore + 1,
    `${salesBefore} -> ${afterPurchase?.sales_count}`);

  // ─── 2. Replay same event → idempotent duplicate ───────────────────
  const res2 = await postEvent(purchaseEvent, sign(purchaseEvent));
  const body2 = res2.status === 200 ? await res2.json() : null;
  check("replayed event => duplicate:true", res2.status === 200 && body2?.duplicate === true,
    `status ${res2.status} ${JSON.stringify(body2)}`);
  const [[dupCount]] = await conn.query(
    "SELECT COUNT(*) AS n FROM marketplace_purchases WHERE stripe_session_id = ?", [SESSION_ID]);
  check("still exactly one purchase row", Number(dupCount?.n) === 1, `n=${dupCount?.n}`);

  // ─── 3. Bogus signature rejected ───────────────────────────────────
  const res3 = await postEvent(purchaseEvent, "t=1,v1=bogus");
  check("bad signature => 400", res3.status === 400, `status ${res3.status}`);

  // ─── 4. charge.refunded → revoke ───────────────────────────────────
  const refundEvent = JSON.stringify({
    id: EVT_REFUND,
    object: "event",
    type: "charge.refunded",
    data: {
      object: {
        id: `ch_smoke_${run}`,
        object: "charge",
        amount_refunded: AMOUNT_CENTS,
        payment_intent: PI_ID,
      },
    },
  });
  const res4 = await postEvent(refundEvent, sign(refundEvent));
  const body4 = res4.status === 200 ? await res4.json() : null;
  check("charge.refunded accepted", res4.status === 200 && body4?.received === true,
    `status ${res4.status} ${JSON.stringify(body4)}`);

  const [[refunded]] = await conn.query(
    "SELECT status FROM marketplace_purchases WHERE stripe_session_id = ?", [SESSION_ID]);
  check("purchase status => refunded", refunded?.status === "refunded", `status=${refunded?.status}`);

  const [grantsAfter] = await conn.query(
    "SELECT id FROM entitlements WHERE subject_type='user' AND subject_id=? AND capability=? AND source='purchase' AND source_ref=?",
    [buyer.id, capability, SESSION_ID],
  );
  check("entitlement revoked", grantsAfter.length === 0, `${grantsAfter.length} row(s) left`);

  const [[afterRefund]] = await conn.query("SELECT sales_count FROM marketplace_listings WHERE id = ?", [listingId]);
  check("listing sales_count decremented back", Number(afterRefund?.sales_count) === salesBefore,
    `${salesBefore} expected, got ${afterRefund?.sales_count}`);
} catch (err) {
  check("script completed without exception", false, err.message);
} finally {
  if (conn) {
    if (KEEP) {
      console.log(`--keep: leaving fixtures (template=${templateId} listing=${listingId} session=${SESSION_ID})`);
    } else {
      try {
        await conn.query("DELETE FROM entitlements WHERE source='purchase' AND source_ref=?", [SESSION_ID]);
        await conn.query("DELETE FROM marketplace_purchases WHERE stripe_session_id=?", [SESSION_ID]);
        if (listingId) await conn.query("DELETE FROM marketplace_listings WHERE id=?", [listingId]);
        if (templateId) await conn.query("DELETE FROM pipeline_templates WHERE id=?", [templateId]);
        await conn.query("DELETE FROM idempotency_keys WHERE `key` IN (?, ?)",
          [`stripe:${EVT_PURCHASE}`, `stripe:${EVT_REFUND}`]);
        console.log("fixtures cleaned up");
      } catch (err) {
        console.error(`cleanup failed (non-fatal): ${err.message}`);
      }
    }
    await conn.end();
  }
}

if (fails.length) {
  console.error(`SMOKE FAILED: ${fails.join(", ")}`);
  process.exit(1);
}
console.log("SMOKE stripe-webhook OK");
