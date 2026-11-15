// @ts-nocheck
// クリエイター報酬（推しの換金）の入口。フロントのサーバー（ログインを確かめたあと）と管理画面から呼ぶ
import { Hono } from "hono"
import { boolean, literal, number, object, optional, safeParse, string, union } from "valibot"
import { requireInternalAuth } from "../lib/auth"
import {
  approvePayout,
  cancelPayout,
  closeMonthlyPayouts,
  createDashboardLink,
  createOnboardingLink,
  createPayoutNotifier,
  getAdminOverview,
  getCreatorRewardSummary,
  getPublicConfig,
  joinCreatorRewards,
  leaveCreatorRewards,
  listPayoutsForAdmin,
  refreshAccount,
  reverseEarningsForSenderRefund,
  sendReadyPayouts,
} from "../lib/creator-payouts"
import { getDb } from "../lib/db"
import { json } from "../lib/json"

const userSchema = object({ userId: string() })
const joinSchema = object({ userId: string(), termsVersion: string() })
const linkSchema = object({ userId: string(), email: optional(string()), returnUrl: string(), refreshUrl: string() })
const moderatorSchema = object({ moderatorUserId: string() })
const cancelSchema = object({ moderatorUserId: string(), mode: union([literal("release"), literal("reverse")]), reason: optional(string()) })
const closeSchema = object({ period: optional(string()), dryRun: optional(boolean()) })
const senderRefundSchema = object({ senderUserId: string(), since: number(), maxCoins: number(), reason: string() })

// 戻り先はサイトの中だけ（Stripe の画面から戻る URL を外に向けない）
const isSiteUrl = (url) => /^https:\/\/(www\.)?aipictors\.com\//.test(url) || /^http:\/\/localhost(:\d+)?\//.test(url)

const errorResponse = (code) => {
  const status = { DISABLED: 403, ONBOARDING_NOT_AVAILABLE: 403, SUSPENDED: 403, NOT_JOINED: 409, TERMS_OUTDATED: 409, NO_ACCOUNT: 404, MODE_MISMATCH: 409 }[code] ?? 400
  return json({ error: code, data: null }, status)
}

export const creatorPayoutRoutes = new Hono()
creatorPayoutRoutes.use("*", requireInternalAuth)

creatorPayoutRoutes.get("/config", (c) => json({ error: null, data: getPublicConfig(c.env) }))

creatorPayoutRoutes.get("/summary/:userId", async (c) => {
  const db = await getDb(c.env)
  return json({ error: null, data: await getCreatorRewardSummary({ db, env: c.env, userId: c.req.param("userId") }) })
})

creatorPayoutRoutes.post("/join", async (c) => {
  const parsed = safeParse(joinSchema, await c.req.json())
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  const db = await getDb(c.env)
  const result = await joinCreatorRewards({ db, env: c.env, userId: parsed.output.userId, termsVersion: parsed.output.termsVersion })
  return result.ok ? json({ error: null, data: { joined: true } }) : errorResponse(result.code)
})

creatorPayoutRoutes.post("/leave", async (c) => {
  const parsed = safeParse(userSchema, await c.req.json())
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  const db = await getDb(c.env)
  return json({ error: null, data: await leaveCreatorRewards({ db, userId: parsed.output.userId }) })
})

creatorPayoutRoutes.post("/onboarding-link", async (c) => {
  const parsed = safeParse(linkSchema, await c.req.json())
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  if (!isSiteUrl(parsed.output.returnUrl) || !isSiteUrl(parsed.output.refreshUrl)) return json({ error: "Invalid return url" }, 400)
  const db = await getDb(c.env)
  const result = await createOnboardingLink({ db, env: c.env, ...parsed.output })
  return result.ok ? json({ error: null, data: { url: result.url } }) : errorResponse(result.code)
})

creatorPayoutRoutes.post("/dashboard-link", async (c) => {
  const parsed = safeParse(userSchema, await c.req.json())
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  const db = await getDb(c.env)
  const result = await createDashboardLink({ db, env: c.env, userId: parsed.output.userId })
  return result.ok ? json({ error: null, data: { url: result.url } }) : errorResponse(result.code)
})

creatorPayoutRoutes.post("/refresh", async (c) => {
  const parsed = safeParse(userSchema, await c.req.json())
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  const db = await getDb(c.env)
  const result = await refreshAccount({ db, env: c.env, userId: parsed.output.userId })
  return result.ok ? json({ error: null, data: { refreshed: true } }) : errorResponse(result.code)
})

// アプリ内課金の返金（aipictors-system の App Store / Google Play の通知）から呼ぶ
creatorPayoutRoutes.post("/sender-refund", async (c) => {
  const parsed = safeParse(senderRefundSchema, await c.req.json())
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  const db = await getDb(c.env)
  return json({ error: null, data: await reverseEarningsForSenderRefund({ db, ...parsed.output }) })
})

// ---- 管理画面 ----
creatorPayoutRoutes.get("/admin/overview", async (c) => {
  const db = await getDb(c.env)
  const [overview, payouts] = await Promise.all([
    getAdminOverview({ db }),
    listPayoutsForAdmin({ db, status: c.req.query("status") || null, limit: Math.min(200, Number(c.req.query("limit") ?? 100) || 100) }),
  ])
  return json({ error: null, data: { config: getPublicConfig(c.env), ...overview, ...payouts } })
})

creatorPayoutRoutes.post("/admin/payouts/:id/approve", async (c) => {
  const parsed = safeParse(moderatorSchema, await c.req.json())
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  const db = await getDb(c.env)
  const result = await approvePayout({ db, payoutId: c.req.param("id"), moderatorUserId: parsed.output.moderatorUserId })
  if (!result.ok) return json({ error: "Payout is not awaiting approval" }, 409)
  // 承認したらすぐ送る（失敗しても承認は残り、翌日の cron でやり直す）
  const send = await sendReadyPayouts({ db, env: c.env, payoutId: c.req.param("id"), notify: createPayoutNotifier(c.env, db) })
  return json({ error: null, data: { approved: true, send } })
})

creatorPayoutRoutes.post("/admin/payouts/:id/cancel", async (c) => {
  const parsed = safeParse(cancelSchema, await c.req.json())
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  const db = await getDb(c.env)
  const result = await cancelPayout({
    db,
    payoutId: c.req.param("id"),
    mode: parsed.output.mode,
    reason: parsed.output.reason ? `admin:${parsed.output.moderatorUserId}:${parsed.output.reason}` : `admin:${parsed.output.moderatorUserId}`,
  })
  return result.ok ? json({ error: null, data: { canceled: true } }) : json({ error: "Payout cannot be canceled" }, 409)
})

creatorPayoutRoutes.post("/admin/close", async (c) => {
  const parsed = safeParse(closeSchema, await c.req.json().catch(() => ({})))
  if (!parsed.success) return json({ error: "Invalid body" }, 400)
  const db = await getDb(c.env)
  const result = await closeMonthlyPayouts({
    db,
    core: c.env.SYSTEM_CORE ?? null,
    env: c.env,
    period: parsed.output.period,
    dryRun: parsed.output.dryRun !== false,
  })
  return json({ error: null, data: result })
})

creatorPayoutRoutes.post("/admin/send", async (c) => {
  const db = await getDb(c.env)
  return json({ error: null, data: await sendReadyPayouts({ db, env: c.env, notify: createPayoutNotifier(c.env, db) }) })
})
