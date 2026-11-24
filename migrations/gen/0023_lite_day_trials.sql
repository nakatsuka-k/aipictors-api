-- カード登録なしの「ライト1日体験」。無料の上限まで使った人に、1 人 1 回だけ、その日（JST）はライトと同じ使い方（1 回 4 枚・日次コイン 500）を開放する。
-- src/lib/lite-day-trial.ts
CREATE TABLE IF NOT EXISTS lite_day_trials (
  user_id TEXT PRIMARY KEY,
  trial_date TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_lite_day_trials_date ON lite_day_trials (trial_date);
