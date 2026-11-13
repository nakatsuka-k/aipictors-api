-- ぴくたーちゃんランのチャットを Discord のチャンネルとつなぐ（lib/pictor-run.ts）
-- source: 'discord' = Discord で書かれたもの（user_id は discord:<ID>）。サイトで書かれたものは NULL
-- discord_id: Discord 側のメッセージの ID（サイトで書かれたものは、Discord に写した先の ID）
ALTER TABLE pictor_run_messages ADD COLUMN source TEXT;
ALTER TABLE pictor_run_messages ADD COLUMN discord_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pictor_run_messages_discord ON pictor_run_messages (discord_id) WHERE discord_id IS NOT NULL;
-- どこまで取り込んだか・最後に取りに行った時刻
CREATE TABLE IF NOT EXISTS pictor_run_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
