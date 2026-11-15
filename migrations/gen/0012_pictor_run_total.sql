-- ぴくたーちゃんラン: 累計ランキング（lib/pictor-run.ts）
-- total_score = その人の全部の回の得点の合計。記録を受け取るたびに足す（ランキングのたびに pictor_run_plays を集計しない）
ALTER TABLE pictor_run_scores ADD COLUMN total_score INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_pictor_run_scores_total ON pictor_run_scores (total_score DESC, updated_at);
