-- 操作の記録の日別のまとめ（lib/event-log.ts）。元はフロントの POST /api/ev → Analytics Engine（aipictors_events、生は 90 日）
-- 毎日 00:30 JST に前日分を作る。データセンターからの通信（traffic = dc）は数えない
-- users はログイン中の人（ユーザー ID の鍵付きハッシュ）の人数、sessions はタブごとのセッション数

-- イベント × 出どころ × ページの種類 × 端末 × ログイン中か
CREATE TABLE IF NOT EXISTS event_daily (
  day TEXT NOT NULL,
  event TEXT NOT NULL,
  source TEXT NOT NULL,
  page TEXT NOT NULL,
  device TEXT NOT NULL,
  auth TEXT NOT NULL,
  events INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  users INTEGER NOT NULL,
  PRIMARY KEY (day, event, source, page, device, auth)
);
CREATE INDEX IF NOT EXISTS event_daily__idx_event_day ON event_daily (event, day);

-- ページの種類ごとの表示・入口（セッションの最初の表示）・出口（最後の表示＝離脱）
CREATE TABLE IF NOT EXISTS event_page_daily (
  day TEXT NOT NULL,
  page TEXT NOT NULL,
  views INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  entries INTEGER NOT NULL,
  exits INTEGER NOT NULL,
  bounces INTEGER NOT NULL,
  PRIMARY KEY (day, page)
);

-- よく見られたパス（その日の上位 500）
CREATE TABLE IF NOT EXISTS event_path_daily (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  views INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  exits INTEGER NOT NULL,
  PRIMARY KEY (day, path)
);

-- ファネル（lib/event-log.ts の FUNNELS）。その日のセッションのうち、段階を順に進んだ数
CREATE TABLE IF NOT EXISTS event_funnel_daily (
  day TEXT NOT NULL,
  funnel TEXT NOT NULL,
  step INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  users INTEGER NOT NULL,
  PRIMARY KEY (day, funnel, step)
);

-- 流入元（最初の page_view の r）× 入口のページの種類
CREATE TABLE IF NOT EXISTS event_entry_daily (
  day TEXT NOT NULL,
  referrer TEXT NOT NULL,
  page TEXT NOT NULL,
  device TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  bounces INTEGER NOT NULL,
  PRIMARY KEY (day, referrer, page, device)
);

-- まとめを作った記録（件数・R2 に残した生データのキー）
CREATE TABLE IF NOT EXISTS event_rollup_runs (
  day TEXT NOT NULL,
  events INTEGER NOT NULL,
  dc_events INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  users INTEGER NOT NULL,
  archive_key TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day)
);
