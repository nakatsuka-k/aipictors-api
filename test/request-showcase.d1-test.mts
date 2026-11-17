// 有料リクエストの実績: 依頼者の許可（申し込み時・あとから・取り消し）、透かし入りの画像だけを出すこと、クリエイターの非表示、
// 混んでいたときの cron のやり直し、作れない画像を飛ばすこと、R18 を出さないこと
import assert from "node:assert/strict"
import { Miniflare } from "miniflare"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { app } = await import(`${API}/app.ts`)
const svc = await import(`${API}/lib/coin-requests/service.ts`)

const d1 = await createTestD1()
const db = d1.db

const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["CORE", "ACTIVITY"] })
const CORE = await mf.getD1Database("CORE")
const ACTIVITY = await mf.getD1Database("ACTIVITY")
await CORE.prepare("CREATE TABLE wp_users (ID INTEGER PRIMARY KEY, user_login TEXT)").run()
await CORE.prepare("CREATE TABLE user_profiles (userId INTEGER PRIMARY KEY, userName TEXT, iconUrl TEXT, fcm_token TEXT, web_fcm_token TEXT)").run()
await CORE.prepare("CREATE TABLE blocked_users (id INTEGER PRIMARY KEY, user_id INTEGER, blocked_user_id INTEGER, is_canceled INTEGER DEFAULT 0)").run()
await ACTIVITY.prepare(
  "CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER, workId INTEGER, comment TEXT, stampId INTEGER, ownerUserId INTEGER, notifyInnerCount INTEGER, notifyType INTEGER, notifyTime TEXT, commentId INTEGER)",
).run()
for (const id of [1, 2, 3, 4, 5, 6]) {
  await CORE.prepare("INSERT INTO wp_users (ID, user_login) VALUES (?1, ?2)").bind(id, `login${id}`).run()
  await CORE.prepare("INSERT INTO user_profiles (userId, userName) VALUES (?1, ?2)").bind(id, `user${id}`).run()
}

const watermarkCalls: string[] = []
let busy = 0
const env: Record<string, unknown> = {
  DB: d1.DB,
  GENLOG: d1.GENLOG,
  SYSTEM_CORE: CORE,
  SYSTEM_ACTIVITY: ACTIVITY,
  INTERNAL_API_TOKEN: "internal",
  CREATOR_PAYOUT_ENABLED: "1",
  COIN_REQUESTS_ENABLED: "1",
  COIN_REQUEST_FEE_PPM: "100000",
  SHOWCASE_TOKEN: "showcase",
  IMAGE_RESIZE: {
    // 画像縮小 Worker の代わり: busy が残っている間は 503、それ以外は透かし入りの URL を返す
    async fetch(_url: string, init: { headers: Record<string, string>; body: string }) {
      watermarkCalls.push(JSON.parse(init.body).url)
      assert.equal(init.headers["x-showcase-token"], "showcase")
      if (busy > 0) {
        busy--
        return new Response(JSON.stringify({ error: "BUSY" }), { status: 503 })
      }
      if (String(JSON.parse(init.body).url).includes("huge")) return new Response(JSON.stringify({ error: "TOO_LARGE" }), { status: 422 })
      return new Response(JSON.stringify({ url: `https://files.aipictors.com/showcase/${watermarkCalls.length}.webp` }))
    },
  },
}
const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { authorization: "Bearer internal", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  )
  return { status: res.status, body: (await res.json()) as { error: string | null; data: any } }
}
const deps = { env, core: CORE, activity: ACTIVITY }
const NOW = Math.floor(Date.now() / 1000)

let lotSeq = 1
const giveLot = async (userId: string, coinType: "FREE" | "PREMIUM", amount: number, paidRatioPpm = 0, expiresAt: number | null = null) => {
  await db.execute(`INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at) VALUES ($1, 0, 0, $2) ON CONFLICT (user_id) DO NOTHING`, [userId, NOW])
  await db.execute(
    `INSERT INTO coin_lots(user_id, coin_type, remaining, locked_amount, source_kind, source_ref_id, expires_at, created_at, updated_at, paid_ratio_ppm)
     VALUES ($1, $2, $3, 0, 'TEST', $4, $5, $6, $6, $7)`,
    [userId, coinType, amount, `test-${lotSeq++}`, expiresAt, NOW, paidRatioPpm],
  )
  await db.execute(
    `UPDATE coin_balances SET free_balance = (SELECT COALESCE(SUM(remaining),0) FROM coin_lots WHERE user_id = $1 AND coin_type = 'FREE'),
       premium_balance = (SELECT COALESCE(SUM(remaining),0) FROM coin_lots WHERE user_id = $1 AND coin_type = 'PREMIUM') WHERE user_id = $1`,
    [userId],
  )
}
const balance = async (userId: string) => {
  const row = await db.queryOne<any>(`SELECT free_balance, premium_balance FROM coin_balances WHERE user_id = $1`, [userId])
  const lots = await db.queryOne<any>(
    `SELECT COALESCE(SUM(CASE WHEN coin_type = 'FREE' THEN remaining END), 0) AS f, COALESCE(SUM(CASE WHEN coin_type = 'PREMIUM' THEN remaining END), 0) AS p FROM coin_lots WHERE user_id = $1`,
    [userId],
  )
  assert.equal(Number(row?.free_balance ?? 0), Number(lots.f), "残高とロットが合う（無料）")
  assert.equal(Number(row?.premium_balance ?? 0), Number(lots.p), "残高とロットが合う（プレミアム）")
  return { free: Number(lots.f), premium: Number(lots.p) }
}
/** コインの総量 = 全員のロット + 預かり中 + 確定で取った手数料 + 報酬にした分（どの操作でも増えも減りもしない） */
const totalCoins = async () => {
  const lots = await db.queryOne<any>(`SELECT COALESCE(SUM(remaining), 0) AS n FROM coin_lots`)
  const escrow = await db.queryOne<any>(`SELECT COALESCE(SUM(free_spent + premium_spent), 0) AS n FROM coin_requests WHERE status IN ('PENDING','ACCEPTED','DELIVERED')`)
  const settled = await db.queryOne<any>(`SELECT COALESCE(SUM(fee_coins + earned_coins), 0) AS n FROM coin_requests WHERE status IN ('COMPLETED','ADMIN_COMPLETED')`)
  return Number(lots.n) + Number(escrow.n) + Number(settled.n)
}
const notifications = async (userId: number) =>
  ((await ACTIVITY.prepare("SELECT comment, commentId FROM notifications WHERE userId = ?1 AND notifyType = 6 ORDER BY id").bind(userId).all()).results ?? []) as any[]

let keySeq = 1
const apply = (requesterUserId: string, extra: Record<string, unknown>) =>
  call("POST", "/internal/requests", { requesterUserId, clientKey: `k${keySeq++}`, title: "テスト", body: "猫の絵をお願いします", ...extra })
const act = (id: string, userId: string, action: string, extra: Record<string, unknown> = {}) =>
  call("POST", `/internal/requests/${id}/action`, { userId, action, ...extra })


const giveCoins = (userId: string) => giveLot(userId, "PREMIUM", 100000, 1000000)
const plan = (
  await call("POST", "/internal/requests/plans", { userId: "1", title: "アイコン", description: "描きます", category: "ICON", priceCoins: 500, maxActive: 10 })
).body.data.plan
for (const id of ["2", "3", "4"]) await giveCoins(id)

/** 申し込み → 承諾 → 納品 → 確定まで進める */
const finish = async (requesterUserId: string, extra: Record<string, unknown>, imageUrls = ["https://image.aipictors.com/d1.webp"]) => {
  const applied = await apply(requesterUserId, { planId: plan.id, priceCoins: 500, ...extra })
  assert.equal(applied.status, 200, JSON.stringify(applied.body))
  const id = applied.body.data.requestId
  assert.equal((await act(id, "1", "accept")).status, 200)
  assert.equal((await act(id, "1", "deliver", { imageUrls })).status, 200)
  assert.equal((await act(id, "2" === requesterUserId ? "2" : requesterUserId, "complete")).status, 200)
  return id
}
const showcaseOf = async (query: string) => (await call("GET", `/internal/requests/showcase?${query}`)).body.data.items as any[]

// ---- 1. 許可して申し込み → 確定で透かし入りの画像ができ、プランとクリエイターの実績に出る ----
const allowed = await finish("2", { showcaseAllowed: true }, ["https://image.aipictors.com/d1.webp", "https://image.aipictors.com/d2.webp"])
{
  const detail = (await call("GET", `/internal/requests/${allowed}?userId=2`)).body.data.request
  assert.equal(detail.showcaseAllowed, true)
  assert.equal(detail.showcaseImageUrls.length, 2)
  assert.ok(detail.showcaseImageUrls.every((url: string) => url.startsWith("https://files.aipictors.com/showcase/")), "元の納品画像ではなく透かし入り")
  const byPlan = await showcaseOf(`planId=${plan.id}`)
  assert.equal(byPlan.length, 1)
  assert.equal(byPlan[0].planTitle, "アイコン")
  assert.deepEqual(byPlan[0].imageUrls, detail.showcaseImageUrls)
  assert.ok(!JSON.stringify(byPlan).includes("d1.webp"), "一覧に元の画像の URL を出さない")
  assert.equal((await showcaseOf("userId=1")).length, 1)
  const planDetail = (await call("GET", `/internal/requests/plans/${plan.id}`)).body.data
  assert.equal(planDetail.showcaseCount, 1)
  const profile = (await call("GET", "/internal/requests/creators/1")).body.data
  assert.equal(profile.showcaseCount, 1)
  assert.equal(profile.showcase.length, 1)
}

// ---- 2. 許可なしは出ない。あとから許可すると出て、取り消すと消える ----
const later = await finish("3", {})
{
  assert.equal((await showcaseOf(`planId=${plan.id}`)).length, 1, "許可していない依頼は出ない")
  assert.equal((await act(later, "1", "showcase", { allowed: true })).body.error, "FORBIDDEN", "許可は依頼者だけ")
  const before = watermarkCalls.length
  assert.equal((await act(later, "3", "showcase", { allowed: true })).status, 200)
  assert.equal(watermarkCalls.length, before + 1)
  assert.equal((await showcaseOf(`planId=${plan.id}`)).length, 2)
  await act(later, "3", "showcase", { allowed: false })
  assert.equal((await showcaseOf(`planId=${plan.id}`)).length, 1, "取り消すと出ない")
  await act(later, "3", "showcase", { allowed: true })
  assert.equal(watermarkCalls.length, before + 1, "作り直さない")
  assert.equal((await showcaseOf(`planId=${plan.id}`)).length, 2)
}

// ---- 3. クリエイターは自分の実績から外せる ----
{
  assert.equal((await act(later, "3", "showcase-hide", { hidden: true })).body.error, "FORBIDDEN")
  await act(later, "1", "showcase-hide", { hidden: true })
  assert.equal((await showcaseOf("userId=1")).length, 1)
  await act(later, "1", "showcase-hide", { hidden: false })
  assert.equal((await showcaseOf("userId=1")).length, 2)
}

// ---- 4. 混んでいて作れなければ、cron でやり直す。作れない画像は飛ばす ----
{
  busy = 1
  const retried = await finish("4", { showcaseAllowed: true }, ["https://image.aipictors.com/d3.webp", "https://image.aipictors.com/huge.webp"])
  let detail = (await call("GET", `/internal/requests/${retried}?userId=4`)).body.data.request
  assert.equal(detail.showcaseImageUrls, null, "まだできていない")
  // 間隔（30 分）が過ぎるまではやり直さない
  await svc.runRequestJob({ db, ...deps, now: NOW })
  assert.equal((await call("GET", `/internal/requests/${retried}?userId=4`)).body.data.request.showcaseImageUrls, null)
  const summary = await svc.runRequestJob({ db, ...deps, now: NOW + 31 * 60 })
  assert.equal(summary.showcase, 1)
  detail = (await call("GET", `/internal/requests/${retried}?userId=4`)).body.data.request
  assert.equal(detail.showcaseImageUrls.length, 1, "大きすぎる画像は飛ばす")
  assert.equal((await showcaseOf("userId=1")).length, 3)
}

// ---- 5. R18 の依頼は許可していても出さない ----
{
  await call("POST", "/internal/requests/settings/1", { acceptsFreeRequests: true, minCoins: 300, allowsR18: true, maxActive: 5 })
  const r18 = await apply("2", { creatorUserId: "1", priceCoins: 300, isR18: true, showcaseAllowed: true })
  const id = r18.body.data.requestId
  await act(id, "1", "accept")
  await act(id, "1", "deliver", { imageUrls: ["https://image.aipictors.com/r.webp"] })
  const before = watermarkCalls.length
  await act(id, "2", "complete")
  assert.equal(watermarkCalls.length, before, "R18 は透かしも作らない")
  assert.equal((await showcaseOf("userId=1")).length, 3)
}

console.log("request-showcase: ok")
await mf.dispose()
await d1.dispose()
