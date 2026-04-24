CREATE TABLE IF NOT EXISTS point_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT,
  stripe_event_id TEXT,
  stripe_session_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS point_balances (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nanoid TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  current_period_start INTEGER NOT NULL,
  current_period_end INTEGER NOT NULL,
  trial_start INTEGER,
  trial_end INTEGER,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  stripe_latest_invoice_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_subscription_item_id TEXT,
  stripe_price_id TEXT,
  stripe_product_id TEXT
);

CREATE TABLE IF NOT EXISTS pricing_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_point_ledger_user_created_at
  ON point_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_active
  ON subscriptions(user_id, is_disabled, current_period_end DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_subscription_id
  ON subscriptions(stripe_subscription_id);

INSERT OR IGNORE INTO pricing_settings(key, value, updated_at) VALUES
  ('points.yen_per_point', '1', unixepoch()),
  ('points.package.100.amount_jpy', '100', unixepoch()),
  ('points.package.300.amount_jpy', '300', unixepoch()),
  ('points.package.1000.amount_jpy', '1000', unixepoch()),
  ('subscription.plan.LITE.amount_jpy', '480', unixepoch()),
  ('subscription.plan.STANDARD.amount_jpy', '1980', unixepoch()),
  ('subscription.plan.PREMIUM.amount_jpy', '3980', unixepoch());
