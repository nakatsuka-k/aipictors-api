-- 作品がオリジナルか二次創作かの運営の判定（作品のタグとは別。作品ページのバッジとプレミアムコインの推しに使う）。作品本体はサイトの DB（SYSTEM_CORE の works）。src/lib/work-original-judgments.ts
-- judgment: ORIGINAL = オリジナル、FAN_WORK = 二次創作。行が無い作品は未判定（推しは今までどおりタグで見る）
CREATE TABLE IF NOT EXISTS work_original_judgments (
  work_id TEXT PRIMARY KEY,
  judgment TEXT NOT NULL,
  note TEXT,
  judged_by TEXT NOT NULL,
  judged_at INTEGER NOT NULL
);

-- 判定の記録（付けた・変えた・外したを全部残す。judgment が NULL は判定を外した）
CREATE TABLE IF NOT EXISTS work_original_judgment_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL,
  judgment TEXT,
  note TEXT,
  judged_by TEXT NOT NULL,
  judged_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS work_original_judgment_logs_work ON work_original_judgment_logs (work_id, id);
