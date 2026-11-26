// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// ユーザーの退会（lib/withdrawn-user.ts）。aipictors-system の退会処理が内部トークンで呼ぶ
import { Hono as Hono2 } from "hono"
import { requireInternalAuth } from "../lib/auth"
import { json } from "../lib/json"
import { scrubWithdrawnUser } from "../lib/withdrawn-user"
import { getDb } from "../lib/db"
import { saveAccountLeaveReason } from "../lib/leave-survey"

export var userRoutes = new Hono2()
userRoutes.use("*", requireInternalAuth)

// 退会した人の個人情報を消す。何度呼んでも同じ結果
userRoutes.post("/:userId/withdrawn", async (c) => {
  const userId = c.req.param("userId")
  if (!/^\d+$/.test(userId)) return json({ error: "Invalid userId" }, 400)
  await scrubWithdrawnUser({ db: c.env.DB, userId })
  return json({ error: null, data: { ok: true } })
})

// 退会・一時停止の前に聞いた理由（lib/leave-survey.ts）。aipictors-system の submitAccountLeaveSurvey が呼ぶ
userRoutes.post("/:userId/leave-reason", async (c) => {
  const userId = c.req.param("userId")
  if (!/^\d+$/.test(userId)) return json({ error: "Invalid userId" }, 400)
  const body = await c.req.json().catch(() => ({}))
  const db = await getDb(c.env)
  const saved = await saveAccountLeaveReason(db, {
    userId,
    reason: body.reason,
    outcome: body.outcome,
    note: body.note,
    details: body.details
  })
  if (!saved) return json({ error: "Invalid reason" }, 400)
  return json({ error: null, data: { ok: true } })
})
