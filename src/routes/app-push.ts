// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// アプリのプッシュ通知（lib/app-push.ts）。設定は Web のサーバー（/api/push-preferences）がログインを確かめて userId を渡す。
// /generation-done は生成ワーカー（aipictors-image-generation-worker のサービスバインディング）が 1 件保存するたびに呼ぶ
import { Hono as Hono2 } from "hono"
import { boolean, object, optional, safeParse, string } from "valibot"
import { getPushPreferences, notifyGenerationDone, savePushPreferences } from "../lib/app-push"
import { requireInternalAuth } from "../lib/auth"
import { getDb, getGenlogDb, getNow } from "../lib/db"
import { json } from "../lib/json"

export var pushPreferencesSchema = object({
  generation: optional(boolean()),
  ranking: optional(boolean()),
  digest: optional(boolean()),
})
export var generationDoneSchema = object({
  userId: string(),
  platform: optional(string()),
  nanoid: optional(string()),
})

export var appPushRoutes = new Hono2()
appPushRoutes.use("*", requireInternalAuth)

appPushRoutes.get("/preferences/:userId", async (c) => {
  const userId = c.req.param("userId")
  if (!/^\d+$/.test(userId)) return json({ error: "Invalid userId" }, 400)
  return json({ error: null, data: await getPushPreferences(await getDb(c.env), userId) })
})

appPushRoutes.post("/preferences/:userId", async (c) => {
  const userId = c.req.param("userId")
  const parsed = safeParse(pushPreferencesSchema, await c.req.json().catch(() => null))
  if (!/^\d+$/.test(userId) || !parsed.success) return json({ error: "Invalid body" }, 400)
  return json({ error: null, data: await savePushPreferences(await getDb(c.env), userId, parsed.output, getNow()) })
})

appPushRoutes.post("/generation-done", async (c) => {
  const parsed = safeParse(generationDoneSchema, await c.req.json().catch(() => null))
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  try {
    const data = await notifyGenerationDone({
      env: c.env,
      db: await getDb(c.env),
      genlog: await getGenlogDb(c.env),
      core: c.env.SYSTEM_CORE ?? null,
      userId: parsed.output.userId,
      platform: parsed.output.platform,
      now: getNow(),
    })
    if (data.result) console.log(JSON.stringify({ event: "app_push.generation_done", result: data.result }))
    return json({ error: null, data })
  } catch (error) {
    // 送れなくても生成には関係ないので 200 で返す（ワーカーは結果を見ない）
    console.error(JSON.stringify({ event: "app_push.generation_done_failed", message: String(error?.message ?? error).slice(0, 200) }))
    return json({ error: null, data: { skipped: "error" } })
  }
})
