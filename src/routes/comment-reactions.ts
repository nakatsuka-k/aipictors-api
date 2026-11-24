// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// 作品のコメント・返信へのリアクション（lib/comment-reactions.ts）。userId はフロントのサーバーがログインを確かめて渡す
import { Hono as Hono2 } from "hono"
import { array, object, safeParse, string } from "valibot"
import { requireInternalAuth } from "../lib/auth"
import { listCommentReactions, reactToComment } from "../lib/comment-reactions"
import { getDb, getNow } from "../lib/db"
import { json } from "../lib/json"

export var commentReactionListSchema = object({
  commentIds: array(string())
})
export var commentReactionReactSchema = object({
  userId: string(),
  commentId: string(),
  emoji: string()
})

export var commentReactionRoutes = new Hono2()
commentReactionRoutes.use("*", requireInternalAuth)

// コメントごとのリアクション（誰が付けたかも返すので、ログインなしで読める）
commentReactionRoutes.post("/list", async (c) => {
  const parsed = safeParse(commentReactionListSchema, await c.req.json().catch(() => null))
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400)
  }
  const db = await getDb(c.env)
  return json({ error: null, data: await listCommentReactions({ db, ...parsed.output }) })
})

// リアクションを付ける・外す（emoji が空なら外す）
commentReactionRoutes.post("/react", async (c) => {
  const parsed = safeParse(commentReactionReactSchema, await c.req.json().catch(() => null))
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400)
  }
  const db = await getDb(c.env)
  const result = await reactToComment({ db, core: c.env.SYSTEM_CORE ?? null, now: getNow(), ...parsed.output })
  if (result.error) {
    return json({ error: result.error }, result.status ?? 400)
  }
  return json({ error: null, data: result.data })
})
