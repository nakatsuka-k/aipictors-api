-- サイトを開くたびに読むお礼コインのキャンペーン。利用者の履歴を全部読まないようにする
CREATE INDEX IF NOT EXISTS idx_coin_ledger_thanks
  ON coin_ledger (user_id, source)
  WHERE source LIKE 'thanks:%';
