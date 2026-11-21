// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// ユーザーの退会（lib/withdrawn-user.ts）。aipictors-system の退会処理が内部トークンで呼ぶ
import { Hono as Hono2 } from "hono"
import { requireInternalAuth } from "../lib/auth"
import { json } from "../lib/json"
import { scrubWithdrawnUser } from "../lib/withdrawn-user"

export var userRoutes = new Hono2()
userRoutes.use("*", requireInternalAuth)

// 退会した人の個人情報を消す。何度呼んでも同じ結果
userRoutes.post("/:userId/withdrawn", async (c) => {
  const userId = c.req.param("userId")
  if (!/^\d+$/.test(userId)) return json({ error: "Invalid userId" }, 400)
  await scrubWithdrawnUser({ db: c.env.DB, userId })
  return json({ error: null, data: { ok: true } })
})
