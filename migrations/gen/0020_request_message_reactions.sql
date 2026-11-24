-- 有料リクエストのメッセージへのリアクション（相手のメッセージに 👍 などを 1 つ付ける）。{ "<userId>": "👍" } の形。src/lib/coin-requests/service.ts
ALTER TABLE coin_request_messages ADD COLUMN reactions TEXT NOT NULL DEFAULT '{}';
