-- ミニゲーム「ぴくたーちゃんラン」（lib/pictor-run.ts）
-- みんなで共通のチャット。名前・アイコン・バッジは書き込んだ時点のものを持つ（表示のたびに利用者の表を引かない）
-- badge: {"level":12,"achievement":{...}|null} の JSON、mentions: [{"userId":"1","name":"…"}] の JSON
CREATE TABLE IF NOT EXISTS pictor_run_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_login TEXT,
  icon_url TEXT,
  badge TEXT,
  body TEXT NOT NULL DEFAULT '',
  sticker_id TEXT,
  sticker_url TEXT,
  reply_to_id INTEGER,
  reply_to_user_id TEXT,
  reply_to_name TEXT,
  reply_to_excerpt TEXT,
  mentions TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pictor_run_messages_user ON pictor_run_messages (user_id, created_at DESC);
-- 利用者ごとの自己ベスト（累計のランキング）
CREATE TABLE IF NOT EXISTS pictor_run_scores (
  user_id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL,
  user_login TEXT,
  icon_url TEXT,
  badge TEXT,
  best_score INTEGER NOT NULL,
  best_coins INTEGER NOT NULL DEFAULT 0,
  plays INTEGER NOT NULL DEFAULT 0,
  best_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pictor_run_scores_best ON pictor_run_scores (best_score DESC, best_at);
-- 1 回ごとの記録（今週のランキング）
CREATE TABLE IF NOT EXISTS pictor_run_plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  coins INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pictor_run_plays_created ON pictor_run_plays (created_at, score DESC);
CREATE INDEX IF NOT EXISTS idx_pictor_run_plays_user ON pictor_run_plays (user_id, created_at DESC);
