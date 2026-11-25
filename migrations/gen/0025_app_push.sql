-- アプリのプッシュ通知（生成の完了・ランキング入り・週のまとめ）。lib/app-push.ts
-- 行が無い人は全部オン（既定）。アプリが Push を登録したときと、設定を変えたときに行を作る
CREATE TABLE IF NOT EXISTS push_preferences (
  user_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 1,
  ranking INTEGER NOT NULL DEFAULT 1,
  digest INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- 種類ごとに最後に送った時刻（同じ知らせを重ねて送らないため）。key は日・週など送る単位
CREATE TABLE IF NOT EXISTS push_sends (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);
