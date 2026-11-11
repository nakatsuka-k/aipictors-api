-- 週替わりのピックアップモデル（みんなのモデル）。週（月曜 00:00 JST 始まり）に 1 行。
-- 毎週月曜 00:00 JST の cron が直近 7 日の利用から自動で選ぶ（source = AUTO）。運営が管理画面で差し替えると source = ADMIN
CREATE TABLE IF NOT EXISTS user_model_pickups (
  week_start TEXT NOT NULL PRIMARY KEY,
  model_id TEXT NOT NULL,
  source TEXT DEFAULT 'AUTO' NOT NULL,
  score REAL,
  stats TEXT DEFAULT '{}' NOT NULL,
  event_slug TEXT,
  x_draft TEXT,
  notified_model_id TEXT,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_model_pickups_model ON user_model_pickups (model_id, week_start);
