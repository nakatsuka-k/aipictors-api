// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// ミニゲーム「ぴくたーちゃんラン」のチャットとスコアランキング（lib/pictor-run.ts）。
// サイトの API がログイン中の本人を確かめてから内部トークンで呼ぶ（user は本人の名前・アイコン・バッジ）
import { Hono as Hono2 } from "hono"
import { requireInternalAuth } from "../lib/auth"
import { getDb, getNow } from "../lib/db"
import { json } from "../lib/json"
import {
  createPictorRunMessage,
  deletePictorRunMessage,
  deletePictorRunMessageFromDiscord,
  sendPictorRunMessageToDiscord,
  syncPictorRunDiscord,
  getPictorRunRanking,
  listPictorRunDeletedIds,
  listPictorRunMessages,
  submitPictorRunScore,
  toPictorRunUser
} from "../lib/pictor-run"

export var pictorRunRoutes = new Hono2()
pictorRunRoutes.use("*", requireInternalAuth)

// チャットの一覧（未ログインでも読める）。afterId より新しいもの、または beforeId より古いもの
pictorRunRoutes.post("/messages/list", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const db = await getDb(c.env)
  const now = getNow()
  // Discord で書かれたものを取り込む（返事は待たせない。次に読みに来たときに出る）
  c.executionCtx.waitUntil(syncPictorRunDiscord(db, c.env, now).catch(() => {}))
  const [messages, deletedIds] = await Promise.all([
    listPictorRunMessages(db, body),
    Number(body.afterId) > 0 ? listPictorRunDeletedIds(db, now - 120) : Promise.resolve([])
  ])
  return json({ error: null, data: { messages, deletedIds, now } })
})

pictorRunRoutes.post("/messages/create", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const user = toPictorRunUser(body.user)
  if (!user) return json({ error: "user is required" }, 400)
  const db = await getDb(c.env)
  const result = await createPictorRunMessage(db, { ...body, user, now: getNow() })
  if (result.error) return json({ error: result.error }, result.status)
  c.executionCtx.waitUntil(sendPictorRunMessageToDiscord(db, c.env, result.row).catch(() => {}))
  return json({ error: null, data: { message: result.message } })
})

pictorRunRoutes.post("/messages/delete", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (!body.userId || !body.messageId) return json({ error: "userId and messageId are required" }, 400)
  const db = await getDb(c.env)
  const deleted = await deletePictorRunMessage(db, {
    messageId: body.messageId,
    userId: String(body.userId),
    isModerator: body.isModerator === true,
    now: getNow()
  })
  if (deleted) c.executionCtx.waitUntil(deletePictorRunMessageFromDiscord(db, c.env, body.messageId).catch(() => {}))
  return json({ error: null, data: { deleted } })
})

pictorRunRoutes.post("/scores/submit", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const user = toPictorRunUser(body.user)
  if (!user) return json({ error: "user is required" }, 400)
  const result = await submitPictorRunScore(await getDb(c.env), { ...body, user, now: getNow() })
  if (result.error) return json({ error: result.error }, result.status)
  return json({ error: null, data: result.data })
})

// ランキング（未ログインでも読める）。userId があれば本人の順位も返す
pictorRunRoutes.post("/scores/ranking", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const data = await getPictorRunRanking(await getDb(c.env), {
    period: body.period === "week" ? "week" : "all",
    limit: body.limit,
    userId: body.userId ?? null,
    now: getNow()
  })
  return json({ error: null, data })
})
