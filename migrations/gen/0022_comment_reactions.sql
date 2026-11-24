-- 作品のコメント・返信へのリアクション（スタンプの代わりに ❤️ などを 1 人 1 つ付ける）。コメント本体はサイトの DB（SYSTEM_CORE の comments）。src/lib/comment-reactions.ts
CREATE TABLE IF NOT EXISTS comment_reactions (
  comment_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);
