-- ライトプランの 7 日間無料お試し（lib/subscription-trial.ts）。お試しの契約 1 件につき 1 行。
-- status: trialing（お試し中）/ converted（有料に移行）/ canceled（有料にならずに終了）
--         / rejected_duplicate_card（別の人が同じカードでお試し済みなので、すぐ解約した）/ rejected_repeat（同じ人の 2 回目なので、すぐ解約した）
CREATE TABLE IF NOT EXISTS subscription_trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  -- Stripe のカードの fingerprint（同じカード番号なら同じ値。カード番号そのものではない）
  card_fingerprint TEXT,
  pass_type TEXT NOT NULL,
  status TEXT NOT NULL,
  trial_start INTEGER,
  trial_end INTEGER,
  -- 終了 3 日前のお知らせメールを送った時刻
  reminder_sent_at INTEGER,
  converted_at INTEGER,
  ended_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscription_trials_user ON subscription_trials (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_trials_fingerprint ON subscription_trials (card_fingerprint);
