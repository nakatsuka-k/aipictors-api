-- 解約・退会の理由の深掘り（lib/leave-survey.ts）
-- 解約の理由に、理由ごとの追加質問の答え（JSON: {"choices":{"group":["key"]},"text":"","improvement":"","source":"web"}）。既存の行は NULL
ALTER TABLE subscription_cancel_reasons ADD COLUMN details TEXT;
-- 集計は期間で読む（主キーだけだと全件になる）
CREATE INDEX IF NOT EXISTS subscription_cancel_reasons__idx_created_at ON subscription_cancel_reasons (created_at);

-- アカウントの退会・一時停止の前に聞く理由。outcome は withdraw（退会した）/ pause（一時停止にした）
-- 退会しても残す（ユーザー ID だけで、名前やメールアドレスは持たない）
CREATE TABLE IF NOT EXISTS account_leave_reasons (
  id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  outcome TEXT,
  note TEXT,
  details TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS account_leave_reasons__idx_created_at ON account_leave_reasons (created_at);
