-- 失効するロットの確認（表示のたびに走る）を、ユーザーの全ロットを読まずに済ませる
CREATE INDEX IF NOT EXISTS idx_coin_lots_user_expiring ON coin_lots (user_id, expires_at) WHERE remaining > 0 AND expires_at IS NOT NULL;
