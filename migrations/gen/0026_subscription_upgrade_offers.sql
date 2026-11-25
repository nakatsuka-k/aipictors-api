-- ライトからスタンダードへ上げる人の初月割引（初月 ¥980）を使ったか。1 人 1 回（主キー）。
-- src/lib/standard-upgrade-offer.ts
CREATE TABLE IF NOT EXISTS subscription_upgrade_offers (
  user_id TEXT NOT NULL,
  offer TEXT NOT NULL,
  stripe_subscription_id TEXT,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, offer)
);
