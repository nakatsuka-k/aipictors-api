// @ts-nocheck
// 有料リクエストとプランの入口。フロントのサーバー（/api/requests、ログインを確かめたあと）と管理画面から呼ぶ
import { Hono } from "hono"
import { requireInternalAuth } from "../lib/auth"
import { getDb, getNow } from "../lib/db"
import { json } from "../lib/json"
import { getRequestConfig, PLAN_CATEGORIES, REQUEST_MAX_COINS, REQUEST_MIN_COINS } from "../lib/coin-requests/config"
import {
  actOnRequest,
  adminActOnRequest,
  applyRequest,
  deletePlan,
  getCreatorRequestProfile,
  getPlan,
  getRequest,
  getRequestBadge,
  getRequestSettings,
  listPlans,
  listRequests,
  listRequestsForAdmin,
  listShowcase,
  countShowcase,
  loadRequestUsers,
  reportPlan,
  savePlan,
  saveRequestSettings,
} from "../lib/coin-requests/service"

const STATUS = {
  NOT_FOUND: 404,
  PLAN_NOT_FOUND: 404,
  CREATOR_NOT_FOUND: 404,
  FORBIDDEN: 403,
  DISABLED: 403,
  BLOCKED: 403,
  INSUFFICIENT_COINS: 402,
  INVALID_STATE: 409,
  PRICE_CHANGED: 409,
  FULL: 409,
  NOT_ACCEPTING: 409,
  TOO_MANY_PENDING: 409,
  PREMIUM_ONLY: 409,
}
const fail = (code) => json({ error: code, data: null }, STATUS[code] ?? 400)
const deps = (c) => ({ env: c.env, core: c.env.SYSTEM_CORE ?? null, activity: c.env.SYSTEM_ACTIVITY ?? null })
const body = async (c) => (await c.req.json().catch(() => ({}))) ?? {}
const bool = (v) => (v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : null)

export const coinRequestRoutes = new Hono()
coinRequestRoutes.use("*", requireInternalAuth)

coinRequestRoutes.get("/config", (c) => {
  const config = getRequestConfig(c.env)
  return json({ error: null, data: { enabled: config.enabled, feePpm: config.feePpm, minCoins: REQUEST_MIN_COINS, maxCoins: REQUEST_MAX_COINS, categories: PLAN_CATEGORIES } })
})

// ---- プラン ----
coinRequestRoutes.get("/plans", async (c) => {
  const q = c.req.query()
  const db = await getDb(c.env)
  const plans = await listPlans({
    db,
    userId: q.userId || null,
    category: q.category || null,
    sort: q.sort || "popular",
    maxPrice: q.maxPrice ? Number(q.maxPrice) : null,
    maxDays: q.maxDays ? Number(q.maxDays) : null,
    r18: bool(q.r18),
    includeHidden: q.includeHidden === "1" && q.userId && q.viewerUserId === q.userId,
    acceptingOnly: q.acceptingOnly === "1",
    limit: Number(q.limit ?? 30),
    offset: Number(q.offset ?? 0),
  })
  const users = await loadRequestUsers(c.env.SYSTEM_CORE, plans.map((p) => p.userId))
  return json({ error: null, data: { plans, users } })
})

coinRequestRoutes.get("/plans/:id", async (c) => {
  const db = await getDb(c.env)
  const plan = await getPlan({ db, planId: Number(c.req.param("id")) })
  const viewer = c.req.query("viewerUserId")
  if (!plan || (plan.status !== "ACTIVE" && plan.userId !== viewer)) return fail("PLAN_NOT_FOUND")
  const [users, showcase, counts] = await Promise.all([
    loadRequestUsers(c.env.SYSTEM_CORE, [plan.userId]),
    listShowcase({ db, planId: plan.id, limit: 12 }),
    countShowcase({ db, planId: plan.id }),
  ])
  return json({ error: null, data: { plan, users, showcase, showcaseCount: counts.all, showcaseR18Count: counts.r18 } })
})

// 実績（依頼者が公開を許可した完了済みの依頼の透かし入り画像）。planId か userId（クリエイター）で絞る。r18=1 で R18 の実績
coinRequestRoutes.get("/showcase", async (c) => {
  const q = c.req.query()
  if (!q.planId && !q.userId) return fail("NOT_FOUND")
  const db = await getDb(c.env)
  // r18=1: R18 の実績だけ（画面は年齢の確認のあとに読む）。なし: 全年齢だけ
  const items = await listShowcase({ db, planId: q.planId || null, creatorUserId: q.planId ? null : q.userId, r18: q.r18 === "1", limit: Number(q.limit ?? 24), offset: Number(q.offset ?? 0) })
  const [users, counts] = await Promise.all([
    loadRequestUsers(c.env.SYSTEM_CORE, [...items.map((item) => item.creatorUserId), ...(q.userId ? [q.userId] : [])]),
    countShowcase({ db, planId: q.planId || null, creatorUserId: q.planId ? null : q.userId }),
  ])
  return json({ error: null, data: { items, users, counts } })
})

coinRequestRoutes.post("/plans", async (c) => {
  const input = await body(c)
  if (!input.userId) return fail("FORBIDDEN")
  const db = await getDb(c.env)
  const r = await savePlan({ db, now: getNow(), userId: input.userId, planId: input.planId ? Number(input.planId) : null, input })
  return r.ok ? json({ error: null, data: { plan: r.plan } }) : fail(r.code)
})

coinRequestRoutes.post("/plans/:id/delete", async (c) => {
  const input = await body(c)
  const db = await getDb(c.env)
  const r = await deletePlan({ db, now: getNow(), userId: input.userId, planId: Number(c.req.param("id")), isModerator: input.isModerator === true })
  return r.ok ? json({ error: null, data: { ok: true } }) : fail("PLAN_NOT_FOUND")
})

coinRequestRoutes.post("/plans/:id/report", async (c) => {
  const input = await body(c)
  const db = await getDb(c.env)
  const r = await reportPlan({ db, now: getNow(), planId: Number(c.req.param("id")), userId: input.userId, reason: input.reason })
  return r.ok ? json({ error: null, data: { ok: true } }) : fail(r.code)
})

// ---- クリエイターの受付 ----
coinRequestRoutes.get("/creators/:userId", async (c) => {
  const db = await getDb(c.env)
  const data = await getCreatorRequestProfile({ db, userId: c.req.param("userId"), viewerUserId: c.req.query("viewerUserId") ?? null })
  const users = await loadRequestUsers(c.env.SYSTEM_CORE, [c.req.param("userId")])
  return json({ error: null, data: { ...data, users } })
})

coinRequestRoutes.get("/settings/:userId", async (c) => {
  const db = await getDb(c.env)
  return json({ error: null, data: await getRequestSettings({ db, userId: c.req.param("userId") }) })
})

coinRequestRoutes.post("/settings/:userId", async (c) => {
  const db = await getDb(c.env)
  return json({ error: null, data: await saveRequestSettings({ db, now: getNow(), userId: c.req.param("userId"), input: await body(c) }) })
})

coinRequestRoutes.get("/badge/:userId", async (c) => {
  const db = await getDb(c.env)
  return json({ error: null, data: await getRequestBadge({ db, userId: c.req.param("userId") }) })
})

// ---- 運営 ----
coinRequestRoutes.get("/admin/list", async (c) => {
  const db = await getDb(c.env)
  const q = c.req.query()
  const data = await listRequestsForAdmin({ db, status: q.status || null, reportedOnly: q.reported === "1" })
  const users = await loadRequestUsers(c.env.SYSTEM_CORE, data.requests.flatMap((r) => [r.requesterUserId, r.creatorUserId]))
  return json({ error: null, data: { ...data, users } })
})

coinRequestRoutes.get("/admin/:id", async (c) => {
  const db = await getDb(c.env)
  const request = await getRequest({ db, requestId: Number(c.req.param("id")), viewerUserId: null, isModerator: true })
  if (!request) return fail("NOT_FOUND")
  const users = await loadRequestUsers(c.env.SYSTEM_CORE, [request.requesterUserId, request.creatorUserId])
  return json({ error: null, data: { request, users } })
})

coinRequestRoutes.post("/admin/:id", async (c) => {
  const input = await body(c)
  if (!input.moderatorUserId) return fail("FORBIDDEN")
  const db = await getDb(c.env)
  const r = await adminActOnRequest({ db, ...deps(c), now: getNow(), requestId: Number(c.req.param("id")), moderatorUserId: input.moderatorUserId, action: input.action, reason: input.reason })
  return r.ok ? json({ error: null, data: { ok: true } }) : fail(r.code)
})

// ---- 依頼 ----
coinRequestRoutes.get("/", async (c) => {
  const q = c.req.query()
  if (!q.userId) return fail("FORBIDDEN")
  const db = await getDb(c.env)
  const data = await listRequests({ db, userId: q.userId, role: q.role === "sent" ? "sent" : "received", status: q.status || "open", limit: Number(q.limit ?? 50), offset: Number(q.offset ?? 0) })
  const users = await loadRequestUsers(c.env.SYSTEM_CORE, data.requests.flatMap((r) => [r.requesterUserId, r.creatorUserId]))
  return json({ error: null, data: { ...data, users } })
})

coinRequestRoutes.post("/", async (c) => {
  const input = await body(c)
  if (!input.requesterUserId) return fail("FORBIDDEN")
  const db = await getDb(c.env)
  const r = await applyRequest({ db, ...deps(c), now: getNow(), input })
  return r.ok ? json({ error: null, data: { requestId: r.requestId } }) : fail(r.code)
})

coinRequestRoutes.get("/:id", async (c) => {
  const db = await getDb(c.env)
  const request = await getRequest({ db, requestId: Number(c.req.param("id")), viewerUserId: c.req.query("userId") })
  if (!request) return fail("NOT_FOUND")
  const users = await loadRequestUsers(c.env.SYSTEM_CORE, [request.requesterUserId, request.creatorUserId])
  return json({ error: null, data: { request, users } })
})

coinRequestRoutes.post("/:id/action", async (c) => {
  const input = await body(c)
  if (!input.userId) return fail("FORBIDDEN")
  const db = await getDb(c.env)
  const r = await actOnRequest({ db, ...deps(c), now: getNow(), requestId: Number(c.req.param("id")), userId: input.userId, action: input.action, input })
  return r.ok ? json({ error: null, data: { request: r.request ?? null } }) : fail(r.code)
})
