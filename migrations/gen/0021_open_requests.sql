-- 募集リクエスト（コンペ型）: 依頼者が内容と報酬（購入したプレミアムコイン）を出して募集し、誰でも画像で提案できる。
-- 依頼者が 1 件を採用すると報酬が提案者へ。締切までに採用されなければ、いいねが一番多い提案を自動で採用（提案がなければ全額返却）。
-- src/lib/open-requests/
-- 状態: OPEN（募集中）→ AWARDED（依頼者が採用）/ AUTO_AWARDED（締切で自動採用）/ ADMIN_AWARDED（運営が採用）
-- 終わり（全額返却）: EXPIRED（締切で提案なし）/ CANCELED（提案が来る前に依頼者が取り下げ）/ ADMIN_CANCELED
CREATE TABLE open_requests (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  requester_user_id TEXT NOT NULL,
  client_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  reference_image_urls TEXT NOT NULL DEFAULT '[]',
  is_r18 INTEGER NOT NULL DEFAULT 0,
  reward_coins INTEGER NOT NULL,
  -- 預かったプレミアムコインと、そのうち有料（おまけでない）分
  premium_spent INTEGER NOT NULL DEFAULT 0,
  paid_coins INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN',
  deadline_at INTEGER NOT NULL,
  -- 採用された作品を、採用された人の実績として公開してよいか（依頼者が決める。あとから変えられる）
  showcase_allowed INTEGER NOT NULL DEFAULT 0,
  awarded_proposal_id INTEGER,
  awarded_user_id TEXT,
  awarded_at INTEGER,
  -- 採用のときの内訳（手数料・報酬にしたコイン・コインで渡した分）
  fee_coins INTEGER,
  earned_coins INTEGER,
  earned_milliyen INTEGER,
  settle_premium_coins INTEGER,
  proposal_count INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  reminded_at INTEGER,
  closed_reason TEXT,
  closed_at INTEGER,
  closed_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_open_requests_client_key ON open_requests(requester_user_id, client_key);
CREATE INDEX idx_open_requests_list ON open_requests(status, is_hidden, created_at);
CREATE INDEX idx_open_requests_deadline ON open_requests(status, deadline_at);
CREATE INDEX idx_open_requests_requester ON open_requests(requester_user_id, created_at);
CREATE INDEX idx_open_requests_awarded ON open_requests(awarded_user_id, showcase_allowed, awarded_at);

-- 提案。ACTIVE / WITHDRAWN（提案者が取り下げ）/ HIDDEN（運営が非表示）
CREATE TABLE open_request_proposals (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  image_urls TEXT NOT NULL DEFAULT '[]',
  work_id TEXT,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  like_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  is_awarded INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_open_request_proposals_request ON open_request_proposals(request_id, status, id);
CREATE INDEX idx_open_request_proposals_user ON open_request_proposals(user_id, created_at);

CREATE TABLE open_request_proposal_likes (
  proposal_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, user_id)
);

-- 提案へのコメント（ツリーの 3 段目）。ACTIVE / DELETED
CREATE TABLE open_request_comments (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  proposal_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_open_request_comments_proposal ON open_request_comments(proposal_id, id);
CREATE INDEX idx_open_request_comments_request ON open_request_comments(request_id, id);

-- 通報（募集か提案。運営の管理画面で見る）
CREATE TABLE open_request_reports (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  proposal_id INTEGER,
  reporter_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_open_request_reports_status ON open_request_reports(status, created_at);
