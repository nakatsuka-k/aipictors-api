CREATE TABLE IF NOT EXISTS point_ledger (
  id BIGSERIAL PRIMARY KEY,
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
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  nanoid TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  is_disabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  current_period_start BIGINT NOT NULL,
  current_period_end BIGINT NOT NULL,
  trial_start BIGINT,
  trial_end BIGINT,
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
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_debug (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  debug_info TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_point_ledger_user_created_at
  ON point_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_active
  ON subscriptions(user_id, is_disabled, current_period_end DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_subscription_id
  ON subscriptions(stripe_subscription_id);

INSERT INTO pricing_settings(key, value, updated_at) VALUES
  ('points.yen_per_point', '1', EXTRACT(EPOCH FROM NOW())::bigint),
  ('points.package.100.amount_jpy', '100', EXTRACT(EPOCH FROM NOW())::bigint),
  ('points.package.300.amount_jpy', '300', EXTRACT(EPOCH FROM NOW())::bigint),
  ('points.package.1000.amount_jpy', '1000', EXTRACT(EPOCH FROM NOW())::bigint),
  ('subscription.plan.LITE.amount_jpy', '480', EXTRACT(EPOCH FROM NOW())::bigint),
  ('subscription.plan.STANDARD.amount_jpy', '1980', EXTRACT(EPOCH FROM NOW())::bigint),
  ('subscription.plan.PREMIUM.amount_jpy', '3980', EXTRACT(EPOCH FROM NOW())::bigint)
ON CONFLICT (key) DO NOTHING;
