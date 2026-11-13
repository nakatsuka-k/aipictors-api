-- 週間の推しランキングは週で絞るのに、週から引ける索引がなく毎回全件（4 万行）を読んでいた
CREATE INDEX IF NOT EXISTS idx_coin_support_transfers_week ON coin_support_transfers (week_start_date, id);
