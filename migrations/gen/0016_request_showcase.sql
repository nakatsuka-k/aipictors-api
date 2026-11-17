-- 実績: 完了した依頼を、依頼者の許可を得て透かし入りでクリエイターの実績に出す（src/lib/coin-requests/showcase.ts）
-- 依頼者の許可（申し込みのときに選び、あとから変えられる）
ALTER TABLE coin_requests ADD COLUMN showcase_allowed INTEGER NOT NULL DEFAULT 0;
-- クリエイターが自分の実績に出さないことにした
ALTER TABLE coin_requests ADD COLUMN showcase_hidden INTEGER NOT NULL DEFAULT 0;
-- 透かし入りの画像の URL（JSON の配列）。NULL = まだ作っていない、[] = 作れる画像がなかった
ALTER TABLE coin_requests ADD COLUMN showcase_image_urls TEXT;
-- 透かし入りの画像を作れなかった時刻（やり直しの間隔に使う）
ALTER TABLE coin_requests ADD COLUMN showcase_failed_at INTEGER;
CREATE INDEX idx_coin_requests_showcase_creator ON coin_requests(creator_user_id, showcase_allowed, completed_at);
