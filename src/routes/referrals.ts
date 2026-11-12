// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// 紹介特典（lib/referrals.ts）
import { Hono as Hono2 } from "hono"
import { nullable, object, optional, safeParse, string } from "valibot"
import { requireInternalAuth } from "../lib/auth"
import { getDb, getGenlogDb, getNow } from "../lib/db"
import { json } from "../lib/json"
import { attachReferral, ensureReferralCode, getReferralStats, getReferralSummary, grantReferralActionRewards, hashIp } from "../lib/referrals"

export var referralSeenSchema = object({
  userId: string(),
  deviceId: optional(nullable(string())),
  ip: optional(nullable(string()))
})
export var referralAttachSchema = object({
  userId: string(),
  code: string(),
  deviceId: optional(nullable(string())),
  ip: optional(nullable(string()))
})

export var referralRoutes = new Hono2()
referralRoutes.use("*", requireInternalAuth)

// 紹介ページ: 自分のコードと、これまでの人数・受け取ったコイン。開いたときに、紹介した人のはじめての生成・投稿も確かめる
referralRoutes.post("/summary", async (c) => {
  const parsed = safeParse(referralSeenSchema, await c.req.json())
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400)
  }
  const db = await getDb(c.env)
  const code = await ensureReferralCode(db, parsed.output.userId, {
    deviceId: parsed.output.deviceId,
    ipHash: await hashIp(c.env, parsed.output.ip)
  })
  await grantReferralActionRewards({
    db,
    genlog: c.env.GENLOG ? await getGenlogDb(c.env) : null,
    core: c.env.SYSTEM_CORE ?? null,
    referrerUserId: parsed.output.userId,
    limit: 50
  }).catch((error) => console.error("[referrals.summary] failed to check action rewards", error))
  return json({ error: null, data: await getReferralSummary(db, parsed.output.userId, code) })
})

// 登録した人を紹介コードにひも付けて、登録の特典を付ける
referralRoutes.post("/attach", async (c) => {
  const parsed = safeParse(referralAttachSchema, await c.req.json())
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400)
  }
  const db = await getDb(c.env)
  const result = await attachReferral({
    db,
    core: c.env.SYSTEM_CORE ?? null,
    env: c.env,
    ...parsed.output
  })
  return json({ error: null, data: result })
})

// 運営用: 直近 N 日の紹介の件数と、弾いた件数（理由ごと）
referralRoutes.get("/stats", async (c) => {
  const days = Math.min(Math.max(Number.parseInt(c.req.query("days") ?? "30", 10) || 30, 1), 365)
  const db = await getDb(c.env)
  return json({ error: null, data: { days, ...(await getReferralStats(db, getNow() - days * 86400)) } })
})
