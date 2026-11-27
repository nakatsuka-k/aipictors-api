-- 流入元ごとのサブスク加入までの到達（lib/event-log.ts の SOURCE_FUNNEL_STEPS）。毎日 00:30 JST に前日分を作る
-- referrer = セッションの最初のページ表示の流入元（direct / google / x / internal …）、device = mobile / tablet / desktop
-- step 1〜6 = visit / explore / upsell_view / plan / checkout / subscribe（その段階まで進んだセッション数・人数）
-- step 91〜93 = 加入の内訳 pass（有料プラン）/ prepaid（前払いパス）/ trial（無料お試しの開始）
CREATE TABLE IF NOT EXISTS event_source_funnel_daily (
  day TEXT NOT NULL,
  referrer TEXT NOT NULL,
  device TEXT NOT NULL,
  step INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  users INTEGER NOT NULL,
  PRIMARY KEY (day, referrer, device, step)
);
