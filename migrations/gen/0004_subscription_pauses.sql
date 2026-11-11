-- プランの一時休止（解約の代わりに次の 1 か月だけ止める）。Stripe の pause_collection（void）と対になる記録
CREATE TABLE IF NOT EXISTS subscription_pauses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  pass_type TEXT,
  -- この日時で今の期間が終わり、次の 1 回分の請求を取り消す
  paused_from INTEGER NOT NULL,
  -- Stripe の resumes_at（この後の更新日から請求とプランが戻る）
  resumes_at INTEGER NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  -- 取り消した・新しく加入して不要になった日時
  canceled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_subscription_pauses_user ON subscription_pauses (user_id, created_at DESC);
