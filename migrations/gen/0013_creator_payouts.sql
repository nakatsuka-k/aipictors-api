-- クリエイター報酬（推しの換金、Stripe Connect）。設計: ~/Documents/aipictors-coin-payout-2026-11-16/design.md
-- そのロットのうち有料（おまけでない）コインの割合（100 万分率）。Web 購入 = coins / total_coins、アプリ内課金 = 商品の枚数 / 配った枚数、それ以外は 0
ALTER TABLE coin_lots ADD COLUMN paid_ratio_ppm INTEGER NOT NULL DEFAULT 0;

-- 今あるウェブ購入のロットにも割合を入れる（購入記録から）
UPDATE coin_lots
   SET paid_ratio_ppm = (
     SELECT CASE WHEN p.total_coins > 0 THEN (p.coins * 1000000) / p.total_coins ELSE 0 END
       FROM premium_coin_purchases p
      WHERE p.lot_id = coin_lots.id
   )
 WHERE source_kind = 'PURCHASE'
   AND EXISTS (SELECT 1 FROM premium_coin_purchases p WHERE p.lot_id = coin_lots.id);

-- 報酬プログラムの参加者と Stripe の連結アカウント
CREATE TABLE creator_payout_profiles (
  user_id TEXT NOT NULL PRIMARY KEY,
  -- JOINED（参加中）/ LEFT（やめた）/ SUSPENDED（運営が止めた）
  status TEXT NOT NULL DEFAULT 'JOINED',
  terms_version TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  stripe_account_id TEXT,
  -- アカウントを作ったときの Stripe のモード（1 = 本番、0 = テスト）。モードを切り替えたら作り直す
  stripe_livemode INTEGER,
  details_submitted INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  transfers_active INTEGER NOT NULL DEFAULT 0,
  -- INDIVIDUAL（源泉徴収する）/ CORPORATION（しない）。Stripe の business_type から
  tax_kind TEXT,
  requirements_json TEXT,
  email TEXT,
  -- 初回の振込を運営が承認した日時（以後は承認キューを通さない）
  approved_at INTEGER,
  approved_by_user_id TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_creator_payout_profiles_account ON creator_payout_profiles(stripe_account_id) WHERE stripe_account_id IS NOT NULL;

-- 報酬（1 推し 1 行）。HELD（保留中・保留明け）→ IN_PAYOUT（締めた）→ PAID（送金済み）、REVERSED（取り消し）
CREATE TABLE creator_earnings (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  -- SUPPORT（推し）/ CLAWBACK（振込後の取り消しの差し引き。マイナス）/ ADJUSTMENT（運営の調整）
  kind TEXT NOT NULL DEFAULT 'SUPPORT',
  source TEXT,
  sender_user_id TEXT,
  work_id TEXT,
  coins INTEGER NOT NULL,
  rate_milliyen INTEGER NOT NULL,
  amount_milliyen INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'HELD',
  available_at INTEGER NOT NULL,
  payout_id TEXT,
  reversed_reason TEXT,
  reversed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_creator_earnings_user_status ON creator_earnings(user_id, status, available_at);
CREATE INDEX idx_creator_earnings_status_available ON creator_earnings(status, available_at);
CREATE INDEX idx_creator_earnings_sender ON creator_earnings(sender_user_id, created_at);
CREATE INDEX idx_creator_earnings_source ON creator_earnings(source);
CREATE INDEX idx_creator_earnings_payout ON creator_earnings(payout_id);

-- 月の振込（1 人 1 か月 1 行）
CREATE TABLE creator_payouts (
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL,
  period TEXT NOT NULL,
  -- AWAITING_APPROVAL → READY → SENDING → SENT、FAILED、CANCELED
  status TEXT NOT NULL,
  gross_yen INTEGER NOT NULL,
  withholding_yen INTEGER NOT NULL,
  fee_yen INTEGER NOT NULL,
  net_yen INTEGER NOT NULL,
  earnings_count INTEGER NOT NULL,
  flags_json TEXT,
  stripe_account_id TEXT,
  stripe_livemode INTEGER,
  stripe_transfer_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  approved_at INTEGER,
  approved_by_user_id TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, period)
);
CREATE INDEX idx_creator_payouts_status ON creator_payouts(status, created_at);
CREATE INDEX idx_creator_payouts_user ON creator_payouts(user_id, period);
