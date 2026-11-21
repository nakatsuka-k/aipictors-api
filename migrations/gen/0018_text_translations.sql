-- 利用者が書いた文（コメント・プロフィール文・リクエストの文・AI評価コメントなど）の自動翻訳の結果（src/lib/translations.ts）
-- 翻訳は Google Apps Script（1 日の回数に上限がある）で、同じ文は 2 回目から呼ばずにここから返す。
-- 原文は持たず、原文の SHA-256（16 進）で引く
CREATE TABLE text_translations (
  source_hash TEXT NOT NULL,
  target TEXT NOT NULL,
  translated TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_hash, target)
) WITHOUT ROWID;
