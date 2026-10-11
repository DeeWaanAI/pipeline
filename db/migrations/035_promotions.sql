-- Admin-defined promotions (ticket #62): "7 days free for newcomers" and
-- code-based free-days grants, without a deploy.
--
-- WHAT THIS IS. A promotion grants N free days on the subscription. It does not
-- discount anything: the number charged stays the single flat price in
-- api/config/plans.ts. Stripe carries the grant as a subscription trial
-- (`subscription_data.trial_period_days`), so billing reconciles itself and
-- there is no second price path, no partial-credit arithmetic and nothing to
-- refund.
--
-- WHY A NEW TABLE AND NOT `vouchers`. `vouchers.tier` is a NOT NULL mysqlEnum of
-- ["pro_designer", "pro_auto"] — the plan ladder retired on 2026-09-22. Reusing
-- it for a free-days grant would mean either writing a fake tier value (a lie in
-- the data, and rejected by the enum anyway) or ALTERing the column (not
-- additive). `vouchers` and `voucher_redemptions` stay exactly as they are:
-- present, unread, historical.
--
-- ADDITIVE ONLY. Two CREATE TABLE statements. Nothing is dropped, renamed,
-- narrowed or altered, and no existing row is read or rewritten.
--
-- WHY REDEMPTION ROWS COPY `days`. A promotion is editable and revocable; what
-- somebody was actually granted is history. Copying the days into the redemptions
-- the grant was made means deactivating or re-tuning a promotion cannot rewrite
-- past entitlements, and the redemption cap is a COUNT over those rows rather
-- than a mutable counter that can drift or double-increment.

CREATE TABLE IF NOT EXISTS `promotions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(80) NOT NULL,
  -- Free days granted. Bounded in code (1..365), not by DDL.
  `days` int NOT NULL,
  -- 'new_signups' = granted automatically to an account that signs up inside the
  -- window and has never subscribed. 'code' = only on redemption.
  `audience` enum('new_signups','code') NOT NULL,
  -- Required when audience='code', NULL otherwise. NULLs are distinct in a MySQL
  -- UNIQUE index, so several automatic promotions coexist while codes stay
  -- one-per-promotion.
  `code` varchar(32) DEFAULT NULL,
  `starts_at` timestamp NULL DEFAULT NULL,
  `ends_at` timestamp NULL DEFAULT NULL,
  -- NULL = unlimited.
  `max_redemptions` int DEFAULT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `note` varchar(200) DEFAULT NULL,
  `created_by` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_promotions_code` (`code`),
  KEY `idx_promotions_audience_active` (`audience`,`active`),
  CONSTRAINT `fk_promotion_author` FOREIGN KEY (`created_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS `promotion_redemptions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `promotion_id` int NOT NULL,
  -- Copied from the promotion at grant time, so later edits cannot rewrite it.
  `days` int NOT NULL,
  `source` enum('signup','code') NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  -- One account cannot claim the same promotion twice.
  UNIQUE KEY `uq_promotion_redemption_user_promo` (`user_id`,`promotion_id`),
  KEY `idx_promotion_redemption_promo` (`promotion_id`),
  CONSTRAINT `fk_promotion_redemption_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_promotion_redemption_promo` FOREIGN KEY (`promotion_id`)
    REFERENCES `promotions` (`id`) ON DELETE CASCADE
);
