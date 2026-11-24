-- 有料リクエストのメッセージの送信取り消し。送った本人が取り消すと deleted_at を入れ、当事者には「取り消しました」とだけ見せる
-- （本文は通報の確認のため運営の画面では見られるよう残す）。src/lib/coin-requests/service.ts の unsend
ALTER TABLE coin_request_messages ADD COLUMN deleted_at INTEGER;
