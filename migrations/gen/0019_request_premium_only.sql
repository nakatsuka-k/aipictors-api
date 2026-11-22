-- 有料リクエストの支払い: クリエイターが「プレミアムコインのみ」を選べる（プランごと・自由リクエストの受付ごと）。
-- 申し込みはフリーコインかプレミアムコインのどちらか一方だけで払う（混ぜない）。src/lib/coin-requests/escrow.ts
ALTER TABLE request_plans ADD COLUMN premium_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE creator_request_settings ADD COLUMN premium_only INTEGER NOT NULL DEFAULT 0;
