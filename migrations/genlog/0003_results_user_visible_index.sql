-- 履歴の件数（消していない・画像のあるもの）を数える専用の索引。
-- これがないと、履歴を多く消した人は件数のたびに自分の全行（数万行）を読む
-- 表が大きい（6GB）ので、生成の少ない時間に 1 回だけ流す
CREATE INDEX IF NOT EXISTS idx_image_generation_results_user_visible
  ON image_generation_results (user_id, status)
  WHERE is_deleted = 0 AND image_url <> '';
