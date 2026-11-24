// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// 作品のコメント・返信へのリアクション。コメントに ❤️ などを 1 人 1 つ付け、もう一度で外す。通知はしない
// リアクションは DB（aipictors-gen）の comment_reactions、コメント本体はサイトの DB（SYSTEM_CORE の comments）

// 👍 はコメントのいいねがあるので入れない
export const COMMENT_REACTIONS = ["❤️", "✨", "😂", "😮", "🙏", "🎉"]

/** 一度に読むコメントの数（作品ページのコメントと返信） */
export const COMMENT_REACTIONS_MAX_IDS = 200

const toIds = (commentIds) =>
  Array.from(new Set((commentIds ?? []).map((id) => String(id)).filter((id) => /^\d{1,12}$/.test(id)))).slice(0, COMMENT_REACTIONS_MAX_IDS)

/**
 * コメントごとのリアクション。{ [commentId]: [{ emoji, userIds }] }（付けた順。付いていないコメントは含めない）
 * 誰が付けたかを返すので、自分が付けたものは画面の側で分かる（ログインの確認なしで読める）
 */
export const listCommentReactions = async ({ db, commentIds }) => {
  const ids = toIds(commentIds)
  if (ids.length === 0) return {}
  const rows = await db.query(
    `SELECT comment_id, user_id, emoji FROM comment_reactions
     WHERE comment_id IN (SELECT value FROM json_each($1)) ORDER BY created_at ASC`,
    [ids]
  )
  const result = {}
  for (const row of rows) {
    const list = (result[String(row.comment_id)] ??= [])
    const entry = list.find((item) => item.emoji === row.emoji)
    if (entry) entry.userIds.push(String(row.user_id))
    else list.push({ emoji: row.emoji, userIds: [String(row.user_id)] })
  }
  return result
}

/**
 * リアクションを付ける（emoji が空なら外す）。消えたコメント・自分のコメントには付けられない
 */
export const reactToComment = async ({ db, core, userId, commentId, emoji, now }) => {
  const id = String(commentId ?? "")
  if (!/^\d{1,12}$/.test(id)) return { error: "Invalid commentId", status: 400 }
  if (emoji && !COMMENT_REACTIONS.includes(emoji)) return { error: "Invalid emoji", status: 400 }
  if (!core) return { error: "Core DB is not configured", status: 500 }
  const comment = await core.prepare(`SELECT ownerId, is_deleted FROM comments WHERE id = ?1`).bind(Number(id)).first()
  if (!comment || Number(comment.is_deleted) === 1) return { error: "コメントが見つかりません", status: 404 }
  if (String(comment.ownerId) === String(userId)) return { error: "自分のコメントにはリアクションできません", status: 400 }
  if (emoji) {
    await db.execute(
      `INSERT INTO comment_reactions (comment_id, user_id, emoji, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (comment_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`,
      [id, String(userId), emoji, now]
    )
  } else {
    await db.execute(`DELETE FROM comment_reactions WHERE comment_id = $1 AND user_id = $2`, [id, String(userId)])
  }
  const reactions = await listCommentReactions({ db, commentIds: [id] })
  return { data: reactions[id] ?? [] }
}
