# In-chat subscription — paying for DeeWaanAI from a desktop client

Status: **proposal, pending owner numbers.** Written 2026-09-22 after the owner decided the
commercial shape of the redesigned product. Nothing here is built yet. Governed by
`OFFERING-REDESIGN-TECH-SPECS.md` D3, P2, P4, P5, P8 and acceptance tests A15/A16/A22.

## 1. The model this feature serves

Owner decisions taken in this thread, recorded here because the payment surface is meaningless
without them:

- The code is **AGPL-3.0 open source**; the paid thing is the **hosted service**, not the code.
  A self-hoster paying nothing is accepted, not a leak to be plugged.
- **One monthly, per-account subscription. No per-run fees** — under BYOK the user always pays
  their own provider, so there is no usage to mark up and no reason to meter billing.
- **No free tier.** Seven days from signup, then the subscription.
- **Execution stays server-side.** Work data is delivered to a folder the user chooses, written by
  their chat client, and swept from us: *your results stay on your computer; our servers are a
  workspace, not an archive.*
- **Team features are out of the project.**
- A seller may **delist at any time**, which stops new sales only. What was bought keeps running,
  and buyers keep being able to check the evidence behind what they bought.
- Provider-side privacy (logging, training retention, zero-retention plans) is **the user's
  responsibility**; ours is to name the destination before the run and record it.

The consequence for this document: a subscriber and a trial user have the *same features*. What
money buys is hosting, retention, marketplace participation and the review queue. So the checkout
flow cannot sell capability — it sells capacity and continuity. That is also why the legacy
`standard / pro_designer / pro_auto` ladder disappears from this surface rather than being renamed.

## 2. Why it is needed at all

A chat client has no idea what DeeWaanAI is. `upgrade_tier` exists, but it currently reports a tier
ladder this product is deleting, and claims `solo` "includes `pro_auto`"
(`api/mcp/tools/upgradeTier.ts:69`) while the plan table it is supposed to reflect
(`api/config/plans.ts:38`) grants `solo` neither `marketplace:publish` nor anything else the tool
promises. A user who pays on that description buys something the code does not deliver — the exact
class of defect A16 exists to catch.

## 3. The line that must not move

**The chat may start a payment and report its result. Card entry happens only on Stripe's hosted
page.** Never accept card or bank fields through a tool, never proxy them, never store anything
that looks like a payment instrument. Qoder opening a browser URL is a fine checkout UX; a
"payment form" rendered inside a conversation is not a feature we should want, because it puts us
inside PCI scope and every chat client in a different one.

Everything below is therefore *around* that page: getting there, knowing whether it worked, and
being able to leave.

## 4. What exists today

| Piece | State |
| --- | --- |
| Stripe subscription checkout | `createCheckoutSession` (`api/services/billingService.ts:39`) — mode `subscription`, price from `STRIPE_PRICE_*`, `client_reference_id` = our user id |
| Webhook → entitlement | present (`api/billing-webhook-route.ts` → `handleStripeEvent`) |
| MCP entry point | `upgrade_tier` returns a checkout URL when billing is configured |
| Prices | `G0-INVENTORY.md:46`: **no USD 9.99 mapping exists**; `plan.available` gates on a configured price id |
| Trial | **absent.** No `trial_period_days` anywhere; `trial_grants` (`db/schema.ts:1889`) exists, is policy-versioned, and is flag-gated off pending P4 |
| Self-service cancel / change card / invoices | **absent.** No billing-portal session anywhere; the only cancel is server-side on team deletion (`billingService.ts:418`) — and team is being removed |
| Payment state visible to a client | **absent.** `get_settings` returns tier and capabilities, not subscription, expiry, trial days left or storage used |
| Post-checkout return | `successUrl`/`cancelUrl` point at the web `/settings` page, so the chat never learns the outcome |

## 5. Build list

Ordered; each is independently shippable and testable.

**M1 — Replace tier language with plan facts, everywhere.** Delete the ladder from the surfaces
that speak it: `upgradeTier.ts` (`currentTier`, `missingByTier`, `CAPABILITY_LABELS`),
`helpContent.ts` `TIER_UPSELL` and the `upgradeCTA`, `src/lib/tiers.ts`, `TierBadge`, the Pricing
page, `site/src/content/ui/en.json`, and the generated wiki (regenerate, don't hand-edit).
The replacement copy is capacity, not capability: hosted runs, retention window, listing slots,
review queue, support. Per D3 no "savings" claim, and per §2 no numerical quality promise.

**M2 — The 7-day trial, tracked by us rather than by Stripe.** Deliberate: a Stripe trial still
demands a card at checkout, which contradicts "try it, then decide". So the trial is our own record,
and `trial_grants` is already the right shape — subject, source, state, expiry, `policyVersion`.
Rules to encode: one trial per account, measured in **days from signup** (the owner's choice), never
reset by clearing data; counters policy-versioned so a later change doesn't rewrite history; an
expired trial is a state, not an error thrown from the middle of a run. **Blocked on P4**, which
still asks for the reset policy and failure consumption — this is the one item that needs a written
policy, not just code.

**M3 — `account_status` readable from chat.** One tool a client can always call: plan or trial, days
left, what happens at expiry, storage used against allowance, listings in flight, next invoice date
when subscribed, and a `manageUrl`. This is the tool that makes the product legible to Qoder, and
the reason `get_settings` is not enough: it answers "what can I do" and not "where do I stand".

**M4 — Expiry behaviour, the humane version.** At expiry: new billable work is refused with the
reason and the checkout link, in the tool result, not as a 500. Runs already in flight **complete**,
on the owner's rule. Reading and exporting stay available **for ever** — locking a user's own work
behind a paywall is both the wrong promise and, given AGPL, an unenforceable one.

**M5 — Checkout that comes back with an answer.** `start_checkout` creates the session and returns
`{ url, sessionId }`; `checkout_status(sessionId)` reports `pending | paid | canceled | expired`,
idempotently, so the assistant can say "open this, tell me when you're done" and confirm. Entitlement
must survive a lost webhook: reconcile on read from Stripe rather than trusting the event, because
the failure mode we cannot afford is a paying customer told they are on a trial.

**M6 — A way out: Stripe billing portal.** A `manageUrl` from a portal session gives cancel, card
change and invoices without us building any of them and without a support ticket. Skipping this is
how a subscription business ends up with complaints that cannot be resolved, and in some
jurisdictions a legal problem rather than a rude one. Cheap to add; do it in the same increment as M3.

**M7 — Fair use, measured on what actually costs.** The owner's worry was users creating thousands
of pipelines; a definition is a few kilobytes, so that is not the cost driver. Meter **bytes stored
and rows retained** (run outputs, batch results, exports, evidence snapshots) plus **concurrent
children and monthly calls**. Warn at a stated threshold, offer clean-or-upgrade, and never delete
silently: notice, a final export, a grace window. Consistent with P5's "do not market unlimited
usage".

**M8 — Copy and translations.** Every new string in `en` and `zh` through the existing bundles
(`npm run i18n:check` fails otherwise), and one specific sentence in the trial and checkout UI:
*the subscription does not include model usage — you always pay your own provider.* Required by
§4.5/§9 ("'Trial' may waive an asset fee but must not imply free LLM tokens").

## 6. Open numbers — owner

1. Monthly price. D3 says USD 9.99 and §11.1 says verify a configured Stripe price before enabling
   checkout; no price id is mapped today.
2. Trial: does it require a card (Stripe-native) or not (M2, recommended)? Owner's decision, and it
   changes the build.
3. Storage and call allowance for the included tier, and the overage answer: ask them to clean, or
   sell a larger plan. If a second size exists, it is still not a feature ladder — say so in copy.
4. Whether trial users may publish on the marketplace at all. They have no payment history behind
   them, which makes them the cheapest way to abuse a review queue.

## 7. Not goals

Per-run or per-token billing; markup on provider costs; in-chat card collection; team seats;
capability gates of any kind; a free tier; holding user data hostage at expiry.

## 8. Acceptance additions

- **A23** — From a chat client with no web login other than card entry: see what the service is,
  start checkout, confirm payment, see the new state, and cancel later. Every step's outcome visible
  in the conversation.
- **A24** — An expired trial cannot start new billable work; a run already in flight completes;
  read and export keep working; nothing is deleted without notice and a grace period.
- **A15** (already in the spec, still open) — trial quotas behave honestly with no fabricated
  purchase rows, which is what `trial_grants` was built for.

## 9. Sequencing

M1 rides with removing the tier ladder — same files, one increment. M3+M6 together (state and exit).
M2 needs P4 written first. M5 after M2, because checkout during an active trial and checkout after
expiry are different offers. M7 last; it needs real usage numbers to set thresholds that are not
guesswork.
