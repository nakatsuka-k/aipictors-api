-- 有料リクエストとプラン。設計: ~/Documents/aipictors-requests-2026-11-16/design.md
-- クリエイターの自由リクエストの受付（プランを使わない依頼）
CREATE TABLE creator_request_settings (
  user_id TEXT NOT NULL PRIMARY KEY,
  accepts_free_requests INTEGER NOT NULL DEFAULT 0,
  min_coins INTEGER NOT NULL DEFAULT 500,
  allows_r18 INTEGER NOT NULL DEFAULT 0,
  max_active INTEGER NOT NULL DEFAULT 3,
  note TEXT,
  updated_at INTEGER NOT NULL
);

-- プラン（クリエイターの出品メニュー）。ACTIVE / HIDDEN（非公開）/ DELETED
CREATE TABLE request_plans (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'ILLUSTRATION',
  sample_image_urls TEXT NOT NULL DEFAULT '[]',
  price_coins INTEGER NOT NULL,
  delivery_days INTEGER NOT NULL,
  image_count INTEGER NOT NULL DEFAULT 1,
  revision_count INTEGER NOT NULL DEFAULT 1,
  max_active INTEGER NOT NULL DEFAULT 3,
  is_accepting INTEGER NOT NULL DEFAULT 1,
  allows_r18 INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  order_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_request_plans_user ON request_plans(user_id, status, created_at);
CREATE INDEX idx_request_plans_list ON request_plans(status, is_accepting, created_at);

-- 依頼。PENDING（承諾待ち）→ ACCEPTED（制作中）→ DELIVERED（納品済み）→ COMPLETED（確定）
-- 終わり: DECLINED / CANCELED / EXPIRED / ADMIN_CANCELED（コインは全額返却）、ADMIN_COMPLETED（運営が確定）
CREATE TABLE coin_requests (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER,
  requester_user_id TEXT NOT NULL,
  creator_user_id TEXT NOT NULL,
  client_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  reference_image_urls TEXT NOT NULL DEFAULT '[]',
  is_r18 INTEGER NOT NULL DEFAULT 0,
  price_coins INTEGER NOT NULL,
  delivery_days INTEGER NOT NULL,
  revision_left INTEGER NOT NULL DEFAULT 0,
  -- 預かったコインの内訳（無料・プレミアム・プレミアムのうち有料＝おまけでない分）
  free_spent INTEGER NOT NULL DEFAULT 0,
  premium_spent INTEGER NOT NULL DEFAULT 0,
  paid_coins INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  respond_by INTEGER NOT NULL,
  due_at INTEGER,
  auto_complete_at INTEGER,
  accepted_at INTEGER,
  delivered_at INTEGER,
  delivery_message TEXT,
  delivery_image_urls TEXT,
  delivered_work_id TEXT,
  completed_at INTEGER,
  closed_reason TEXT,
  closed_at INTEGER,
  closed_by_user_id TEXT,
  -- 確定のときの内訳（手数料・報酬にしたコイン・コインで渡した分）
  fee_coins INTEGER,
  earned_coins INTEGER,
  earned_milliyen INTEGER,
  settle_free_coins INTEGER,
  settle_premium_coins INTEGER,
  reminded_at INTEGER,
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_coin_requests_client_key ON coin_requests(requester_user_id, client_key);
CREATE INDEX idx_coin_requests_creator ON coin_requests(creator_user_id, status, created_at);
CREATE INDEX idx_coin_requests_requester ON coin_requests(requester_user_id, status, created_at);
CREATE INDEX idx_coin_requests_plan ON coin_requests(plan_id, status);
CREATE INDEX idx_coin_requests_status ON coin_requests(status, updated_at);

-- 依頼ごとのやり取り（システムの記録は sender_user_id = NULL）
CREATE TABLE coin_request_messages (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  sender_user_id TEXT,
  body TEXT NOT NULL,
  image_urls TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_coin_request_messages_request ON coin_request_messages(request_id, id);

-- 通報（運営の管理画面で見る）
CREATE TABLE coin_request_reports (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER,
  plan_id INTEGER,
  reporter_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_coin_request_reports_status ON coin_request_reports(status, created_at);
