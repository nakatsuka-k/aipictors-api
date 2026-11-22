// @ts-nocheck
// 募集リクエスト（コンペ型）の入口。フロントのサーバー（/api/open-requests、ログインを確かめたあと）と管理画面から呼ぶ
import { Hono } from "hono"
import { requireInternalAuth } from "../lib/auth"
import { getDb, getNow } from "../lib/db"
import { json } from "../lib/json"
import { getRequestConfig } from "../lib/coin-requests/config"
import {
  DEADLINE_DEFAULT_DAYS,
  DEADLINE_MAX_DAYS,
  DEADLINE_MIN_DAYS,
  OPEN_REQUEST_MAX_COINS,
  OPEN_REQUEST_MIN_COINS,
  PROPOSALS_PER_USER,
  getOpenRequestConfig,
} from "../lib/open-requests/config"
import {
  actOnOpenRequest,
  actOnProposal,
  adminActOnOpenRequest,
  createOpenRequest,
  createProposal,
  getOpenRequest,
  getOpenRequestAccount,
  listOpenRequests,
  listOpenRequestShowcase,
  listOpenRequestsForAdmin,
  loadRequestUsers,
} from "../lib/open-requests/service"

const STATUS = {
  NOT_FOUND: 404,
  PROPOSAL_NOT_FOUND: 404,
  WORK_NOT_FOUND: 404,
  FORBIDDEN: 403,
  DISABLED: 403,
  BLOCKED: 403,
  INSUFFICIENT_COINS: 402,
  INVALID_STATE: 409,
  CLOSED: 409,
  HAS_PROPOSALS: 409,
  TOO_MANY_OPEN: 409,
  TOO_MANY_PROPOSALS: 409,
  TOO_MANY_COMMENTS: 409,
}
const fail = (code) => json({ error: code, data: null }, STATUS[code] ?? 400)
const deps = (c) => ({ env: c.env, core: c.env.SYSTEM_CORE ?? null, activity: c.env.SYSTEM_ACTIVITY ?? null })
const body = async (c) => (await c.req.json().catch(() => ({}))) ?? {}

/** 募集・提案・コメントに出てくる人 */
const usersOf = (core, request) =>
  loadRequestUsers(core, [
    request.requesterUserId,
    ...request.proposals.flatMap((p) => [p.userId, ...p.comments.map((c) => c.userId)]),
  ])

export const openRequestRoutes = new Hono()
openRequestRoutes.use("*", requireInternalAuth)

openRequestRoutes.get("/config", async (c) => {
  const userId = c.req.query("userId")
  const db = await getDb(c.env)
  return json({
    error: null,
    data: {
      enabled: getOpenRequestConfig(c.env).enabled,
      feePpm: getRequestConfig(c.env).feePpm,
      minCoins: OPEN_REQUEST_MIN_COINS,
      maxCoins: OPEN_REQUEST_MAX_COINS,
      deadlineMinDays: DEADLINE_MIN_DAYS,
      deadlineMaxDays: DEADLINE_MAX_DAYS,
      deadlineDefaultDays: DEADLINE_DEFAULT_DAYS,
      proposalsPerUser: PROPOSALS_PER_USER,
      account: userId ? await getOpenRequestAccount({ db, userId, now: getNow() }) : null,
    },
  })
})

// 一覧: status=open|done|all、sort=new|deadline|reward|proposals、r18=1、requesterUserId= / proposerUserId=（自分の募集・提案）
openRequestRoutes.get("/", async (c) => {
  const q = c.req.query()
  const db = await getDb(c.env)
  const requests = await listOpenRequests({
    db,
    status: q.status || "open",
    sort: q.sort || "new",
    r18: q.r18 === "1",
    requesterUserId: q.requesterUserId || null,
    proposerUserId: q.proposerUserId || null,
    viewerUserId: q.viewerUserId || null,
    limit: Number(q.limit ?? 30),
    offset: Number(q.offset ?? 0),
  })
  const users = await loadRequestUsers(c.env.SYSTEM_CORE, requests.map((r) => r.requesterUserId))
  return json({ error: null, data: { requests, users } })
})

// 採用された人の実績（依頼者が公開を許可したもの）
openRequestRoutes.get("/showcase", async (c) => {
  const q = c.req.query()
  if (!q.userId) return fail("NOT_FOUND")
  const db = await getDb(c.env)
  return json({ error: null, data: await listOpenRequestShowcase({ db, userId: q.userId, r18: q.r18 === "1", limit: Number(q.limit ?? 24), offset: Number(q.offset ?? 0) }) })
})

openRequestRoutes.post("/", async (c) => {
  const input = await body(c)
  if (!input.requesterUserId) return fail("FORBIDDEN")
  const db = await getDb(c.env)
  const r = await createOpenRequest({ db, env: c.env, now: getNow(), input })
  return r.ok ? json({ error: null, data: { requestId: r.requestId } }) : fail(r.code)
})

// ---- 運営 ----
openRequestRoutes.get("/admin/list", async (c) => {
  const q = c.req.query()
  const db = await getDb(c.env)
  const data = await listOpenRequestsForAdmin({ db, status: q.status || null, reportedOnly: q.reported === "1" })
  const users = await loadRequestUsers(c.env.SYSTEM_CORE, data.requests.map((r) => r.requesterUserId))
  return json({ error: null, data: { ...data, users } })
})

openRequestRoutes.get("/admin/:id", async (c) => {
  const db = await getDb(c.env)
  const request = await getOpenRequest({ db, requestId: Number(c.req.param("id")), isModerator: true })
  if (!request) return fail("NOT_FOUND")
  return json({ error: null, data: { request, users: await usersOf(c.env.SYSTEM_CORE, request) } })
})

openRequestRoutes.post("/admin/:id", async (c) => {
  const input = await body(c)
  if (!input.moderatorUserId) return fail("FORBIDDEN")
  const db = await getDb(c.env)
  const r = await adminActOnOpenRequest({ db, ...deps(c), now: getNow(), requestId: Number(c.req.param("id")), moderatorUserId: input.moderatorUserId, action: input.action, input })
  return r.ok ? json({ error: null, data: { ok: true } }) : fail(r.code)
})

// ---- 提案 ----
openRequestRoutes.post("/proposals/:id/action", async (c) => {
  const input = await body(c)
  if (!input.userId) return fail("FORBIDDEN")
  const db = await getDb(c.env)
  const r = await actOnProposal({ db, ...deps(c), now: getNow(), proposalId: Number(c.req.param("id")), userId: input.userId, action: input.action, input })
  if (!r.ok) return fail(r.code)
  const { ok, ...data } = r
  return json({ error: null, data })
})

// ---- 募集 ----
openRequestRoutes.get("/:id", async (c) => {
  const db = await getDb(c.env)
  const request = await getOpenRequest({ db, requestId: Number(c.req.param("id")), viewerUserId: c.req.query("viewerUserId") || null })
  if (!request) return fail("NOT_FOUND")
  return json({ error: null, data: { request, users: await usersOf(c.env.SYSTEM_CORE, request) } })
})

openRequestRoutes.post("/:id/proposals", async (c) => {
  const input = await body(c)
  if (!input.userId) return fail("FORBIDDEN")
  const db = await getDb(c.env)
  const r = await createProposal({ db, ...deps(c), now: getNow(), requestId: Number(c.req.param("id")), userId: input.userId, input })
  return r.ok ? json({ error: null, data: { proposalId: r.proposalId } }) : fail(r.code)
})

openRequestRoutes.post("/:id/action", async (c) => {
  const input = await body(c)
  if (!input.userId) return fail("FORBIDDEN")
  const db = await getDb(c.env)
  const r = await actOnOpenRequest({ db, ...deps(c), now: getNow(), requestId: Number(c.req.param("id")), userId: input.userId, action: input.action, input })
  return r.ok ? json({ error: null, data: { ok: true } }) : fail(r.code)
})
