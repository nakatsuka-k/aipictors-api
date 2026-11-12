-- 紹介特典（lib/referrals.ts）
-- 紹介コード（1 人 1 つ）。device_id / ip_hash は紹介する人が紹介ページを開いたときの端末と IP（自分で自分を紹介するのを弾くため。IP はハッシュだけ）
CREATE TABLE IF NOT EXISTS referral_codes (
  user_id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  device_id TEXT,
  ip_hash TEXT,
  created_at INTEGER NOT NULL
);
-- 紹介の成立（紹介された人 1 人につき 1 行 = 同じ組み合わせは 1 回だけ）
-- status: attached（成立）/ rejected（あとから不正と分かって、紹介した人への特典を止めた）
-- referrer_capped = 1: 紹介した人の月の上限を超えた分（紹介された人の特典だけ付け、紹介した人には付けない）
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_user_id TEXT NOT NULL,
  referred_user_id TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  status TEXT NOT NULL,
  referrer_capped INTEGER NOT NULL DEFAULT 0,
  device_id TEXT,
  ip_hash TEXT,
  -- 紹介された人に登録の特典を付けた時刻
  signup_rewarded_at INTEGER,
  -- 紹介した人に「はじめての生成・投稿」の特典を付けた時刻と、どちらだったか（generation / post）
  action_rewarded_at INTEGER,
  action_kind TEXT,
  -- はじめての生成・投稿を最後に確かめた時刻
  action_checked_at INTEGER,
  -- 紹介した人に「はじめての支払い」の特典を付けた時刻
  paid_rewarded_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_pending_action ON referrals (created_at) WHERE action_rewarded_at IS NULL AND status = 'attached' AND referrer_capped = 0;
-- 弾いた紹介の記録（運営があとで見る）。reason: self / not_new_account / same_device / same_ip / ip_overlap / monthly_limit / unknown_code
CREATE TABLE IF NOT EXISTS referral_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_user_id TEXT,
  referred_user_id TEXT NOT NULL,
  code TEXT,
  reason TEXT NOT NULL,
  device_id TEXT,
  ip_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referral_rejections_created ON referral_rejections (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referral_rejections_referrer ON referral_rejections (referrer_user_id, created_at DESC);
