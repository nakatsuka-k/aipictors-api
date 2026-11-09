-- 生成画像の保存期間の見回りの位置（src/lib/generation-retention.ts）
CREATE TABLE IF NOT EXISTS generation_retention_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor_id INTEGER NOT NULL DEFAULT 0,
  next_pass_at INTEGER NOT NULL DEFAULT 0
);
