-- 自動更新なしのプラン（PayPay などの 1 回払いで買う 1 か月・1 年のパス）の購入記録。決済 1 回につき 1 行（同じ決済を二重に反映しないため）
CREATE TABLE IF NOT EXISTS prepaid_pass_purchases (
  stripe_session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  pass_type TEXT NOT NULL,
  interval TEXT NOT NULL,
  price_yen INTEGER NOT NULL,
  stripe_payment_intent_id TEXT,
  -- 反映した subscriptions の行と、この購入で延びた期間
  subscription_nanoid TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prepaid_pass_purchases_user ON prepaid_pass_purchases (user_id, created_at DESC);
