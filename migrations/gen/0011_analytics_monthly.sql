-- 分析ページ: 利用者の月別の数字（登録・投稿した人・いいねした人）。1 か月 1 行
CREATE TABLE IF NOT EXISTS analytics_monthly (
  month TEXT NOT NULL,
  metrics TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (month)
);
