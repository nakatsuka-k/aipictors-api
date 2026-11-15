-- クリエイター報酬: Stripe の本人確認が済んで入金できるようになった日時（新しい口座は 30 日のあいだ 1 回の振込を 3 万円までにする）
ALTER TABLE creator_payout_profiles ADD COLUMN payouts_enabled_at INTEGER;
UPDATE creator_payout_profiles SET payouts_enabled_at = updated_at WHERE payouts_enabled = 1 AND payouts_enabled_at IS NULL;
