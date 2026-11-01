// @ts-nocheck -- このリポジトリの routes と同じく型なし
import { Hono } from "hono"
import { boolean, nullable, object, optional, safeParse, string } from "valibot"
import { requireInternalAuth } from "../lib/auth"
import { getDb, getNow } from "../lib/db"
import {
  linkDiscordAccount,
  setupDiscordIntegration,
  syncDiscordLinkByUserId,
  toDiscordStatus,
  unlinkDiscordAccount,
  updateDiscordSettings,
} from "../lib/discord"
import { json } from "../lib/json"

export const discordRoutes = new Hono()
discordRoutes.use("*", requireInternalAuth)

const linkSchema = object({ userId: string(), code: string(), redirectUri: string() })
const userSchema = object({ userId: string() })
const settingsSchema = object({
  userId: string(),
  showNickname: optional(boolean()),
  celebrate: optional(boolean()),
  expiryDm: optional(boolean()),
  highlightKey: optional(nullable(string())),
})

discordRoutes.get("/status/:userId", async (c) => {
  const db = await getDb(c.env)
  return json({ error: null, data: await toDiscordStatus(db, c.req.param("userId")) })
})

discordRoutes.post("/link", async (c) => {
  const parsed = safeParse(linkSchema, await c.req.json())
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  const db = await getDb(c.env)
  return json({ error: null, data: await linkDiscordAccount(c.env, db, parsed.output) })
})

discordRoutes.post("/unlink", async (c) => {
  const parsed = safeParse(userSchema, await c.req.json())
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  const db = await getDb(c.env)
  return json({ error: null, data: await unlinkDiscordAccount(c.env, db, parsed.output.userId) })
})

discordRoutes.post("/settings", async (c) => {
  const parsed = safeParse(settingsSchema, await c.req.json())
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  const db = await getDb(c.env)
  await updateDiscordSettings(db, parsed.output)
  await syncDiscordLinkByUserId(c.env, db, parsed.output.userId).catch(() => undefined)
  return json({ error: null, data: await toDiscordStatus(db, parsed.output.userId) })
})

// 急がない同期の依頼（実績の達成時など）。次の 5 分ごとの処理で先に反映する
discordRoutes.post("/request-sync", async (c) => {
  const parsed = safeParse(userSchema, await c.req.json())
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  const db = await getDb(c.env)
  await db.execute(
    "UPDATE discord_links SET sync_requested_at = $2 WHERE user_id = $1",
    [parsed.output.userId, getNow()],
  )
  return json({ error: null, data: { ok: true } })
})

discordRoutes.post("/sync", async (c) => {
  const parsed = safeParse(userSchema, await c.req.json())
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  const db = await getDb(c.env)
  await syncDiscordLinkByUserId(c.env, db, parsed.output.userId).catch(() => undefined)
  return json({ error: null, data: await toDiscordStatus(db, parsed.output.userId) })
})

discordRoutes.post("/setup", async (c) => {
  const db = await getDb(c.env)
  return json({ error: null, data: await setupDiscordIntegration(c.env, db) })
})

/**
 * ぴくたーちゃん（Discord ボット）から呼ぶ。INTERNAL_API_TOKEN は渡さず、専用のトークンにする
 */
export const discordBotRoutes = new Hono()

discordBotRoutes.use("*", async (c, next) => {
  const expected = c.env.DISCORD_BOT_API_TOKEN
  const header = c.req.header("authorization")
  if (!expected || header !== `Bearer ${expected}`) {
    return json({ error: "Unauthorized" }, 401)
  }
  await next()
})

// サーバーに参加したとき: 連携済みならすぐ反映する
discordBotRoutes.post("/member-joined/:discordUserId", async (c) => {
  const db = await getDb(c.env)
  const link = await db.queryOne(
    "SELECT user_id FROM discord_links WHERE discord_user_id = $1",
    [c.req.param("discordUserId")],
  )
  if (!link) return json({ error: null, data: { isLinked: false } })
  await syncDiscordLinkByUserId(c.env, db, link.user_id).catch(() => undefined)
  return json({ error: null, data: { isLinked: true } })
})

// /card コマンド用
discordBotRoutes.get("/card/:discordUserId", async (c) => {
  const db = await getDb(c.env)
  const link = await db.queryOne(
    `SELECT user_id, aipictors_name, aipictors_login, level, unlocked_count, is_achievement_visible
       FROM discord_links WHERE discord_user_id = $1`,
    [c.req.param("discordUserId")],
  )
  if (!link) return json({ error: null, data: { isLinked: false } })
  return json({
    error: null,
    data: {
      isLinked: true,
      userId: link.user_id,
      name: link.aipictors_name,
      login: link.aipictors_login,
      level: link.level,
      unlockedCount: link.unlocked_count,
      isAchievementVisible: link.is_achievement_visible !== false,
    },
  })
})
