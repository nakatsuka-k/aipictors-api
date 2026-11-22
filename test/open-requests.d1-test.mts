// 募集リクエスト（コンペ型）: 購入したプレミアムコインだけで預かる・二度押し・同時の募集数、提案（自分の募集・1 人 3 件・作品・締切後）、
// いいね（自分の提案・数）、コメントのツリー、提案があるときの取り下げ不可、採用（手数料・報酬・二重の採用なし）、
// 締切の処理（いいね最多の自動採用・提案なしは全額返却で有料の割合を残す）、通知（commentId がマイナス）、実績、コインの総量が合うこと
import assert from "node:assert/strict"
import { Miniflare } from "miniflare"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { app } = await import(`${API}/app.ts`)
const svc = await import(`${API}/lib/open-requests/service.ts`)

const d1 = await createTestD1()
const db = d1.db

const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["CORE", "ACTIVITY"] })
const CORE = await mf.getD1Database("CORE")
const ACTIVITY = await mf.getD1Database("ACTIVITY")
await CORE.prepare("CREATE TABLE wp_users (ID INTEGER PRIMARY KEY, user_login TEXT)").run()
await CORE.prepare("CREATE TABLE user_profiles (userId INTEGER PRIMARY KEY, userName TEXT, iconUrl TEXT, fcm_token TEXT, web_fcm_token TEXT)").run()
await CORE.prepare("CREATE TABLE blocked_users (id INTEGER PRIMARY KEY, user_id INTEGER, blocked_user_id INTEGER, is_canceled INTEGER DEFAULT 0)").run()
await CORE.prepare(
  "CREATE TABLE works (id INTEGER PRIMARY KEY, userId INTEGER, ageLimit INTEGER, is_deleted INTEGER DEFAULT 0, adminViewMode INTEGER DEFAULT 0, viewMode INTEGER DEFAULT 0, large_thumbnail_image_url TEXT)",
).run()
await ACTIVITY.prepare(
  "CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER, workId INTEGER, comment TEXT, stampId INTEGER, ownerUserId INTEGER, notifyInnerCount INTEGER, notifyType INTEGER, notifyTime TEXT, commentId INTEGER)",
).run()
for (const id of [1, 2, 3, 4, 5, 6]) {
  await CORE.prepare("INSERT INTO wp_users (ID, user_login) VALUES (?1, ?2)").bind(id, `login${id}`).run()
  await CORE.prepare("INSERT INTO user_profiles (userId, userName) VALUES (?1, ?2)").bind(id, `user${id}`).run()
}
await CORE.prepare("INSERT INTO works (id, userId, ageLimit, large_thumbnail_image_url) VALUES (100, 2, 0, 'https://image.aipictors.com/w100.webp')").run()
await CORE.prepare("INSERT INTO works (id, userId, ageLimit, large_thumbnail_image_url) VALUES (101, 2, 1, 'https://image.aipictors.com/w101.webp')").run()

const env: Record<string, unknown> = {
  DB: d1.DB,
  GENLOG: d1.GENLOG,
  SYSTEM_CORE: CORE,
  SYSTEM_ACTIVITY: ACTIVITY,
  INTERNAL_API_TOKEN: "internal",
  CREATOR_PAYOUT_ENABLED: "1",
  COIN_REQUEST_FEE_PPM: "100000",
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
const DAY = 86400

let lotSeq = 1
const giveLot = async (userId: string, coinType: "FREE" | "PREMIUM", amount: number, paidRatioPpm = 0) => {
  await db.execute(`INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at) VALUES ($1, 0, 0, $2) ON CONFLICT (user_id) DO NOTHING`, [userId, NOW])
  await db.execute(
    `INSERT INTO coin_lots(user_id, coin_type, remaining, locked_amount, source_kind, source_ref_id, expires_at, created_at, updated_at, paid_ratio_ppm)
     VALUES ($1, $2, $3, 0, 'TEST', $4, NULL, $5, $5, $6)`,
    [userId, coinType, amount, `test-${lotSeq++}`, NOW, paidRatioPpm],
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
    `SELECT COALESCE(SUM(CASE WHEN coin_type = 'FREE' THEN remaining END), 0) AS f, COALESCE(SUM(CASE WHEN coin_type = 'PREMIUM' THEN remaining END), 0) AS p,
            COALESCE(SUM(CASE WHEN coin_type = 'PREMIUM' AND paid_ratio_ppm > 0 THEN remaining END), 0) AS paid FROM coin_lots WHERE user_id = $1`,
    [userId],
  )
  assert.equal(Number(row?.premium_balance ?? 0), Number(lots.p), "残高とロットが合う（プレミアム）")
  return { free: Number(lots.f), premium: Number(lots.p), paidPremium: Number(lots.paid) }
}
/** コインの総量 = 全員のロット + 募集中の預かり + 採用で取った手数料 + 報酬にした分 */
const totalCoins = async () => {
  const lots = await db.queryOne<any>(`SELECT COALESCE(SUM(remaining), 0) AS n FROM coin_lots`)
  const escrow = await db.queryOne<any>(`SELECT COALESCE(SUM(premium_spent), 0) AS n FROM open_requests WHERE status = 'OPEN'`)
  const settled = await db.queryOne<any>(`SELECT COALESCE(SUM(fee_coins + earned_coins), 0) AS n FROM open_requests WHERE status IN ('AWARDED','AUTO_AWARDED','ADMIN_AWARDED')`)
  return Number(lots.n) + Number(escrow.n) + Number(settled.n)
}
const notifications = async (userId: number) =>
  ((await ACTIVITY.prepare("SELECT comment, commentId FROM notifications WHERE userId = ?1 AND notifyType = 6 ORDER BY id").bind(userId).all()).results ?? []) as any[]

let keySeq = 1
const create = (requesterUserId: string, extra: Record<string, unknown> = {}) =>
  call("POST", "/internal/open-requests", { requesterUserId, clientKey: `k${keySeq++}`, title: "猫の絵", body: "白い猫を描いてください", rewardCoins: 500, ...extra })
const propose = (requestId: string, userId: string, extra: Record<string, unknown> = {}) =>
  call("POST", `/internal/open-requests/${requestId}/proposals`, { userId, imageUrls: ["https://image.aipictors.com/p.webp"], ...extra })
const actP = (proposalId: string, userId: string, action: string, extra: Record<string, unknown> = {}) =>
  call("POST", `/internal/open-requests/proposals/${proposalId}/action`, { userId, action, ...extra })
const actR = (requestId: string, userId: string, action: string, extra: Record<string, unknown> = {}) =>
  call("POST", `/internal/open-requests/${requestId}/action`, { userId, action, ...extra })

// ---- 1. 募集: 購入したプレミアムコインだけ ----
await giveLot("1", "FREE", 5000)
await giveLot("1", "PREMIUM", 5000, 0) // 運営の付与など（有料の割合 0）は使えない
{
  const poor = await create("1")
  assert.equal(poor.status, 402)
  assert.equal(poor.body.error, "INSUFFICIENT_COINS", "無料コイン・有料の割合 0 のプレミアムでは募集できない")
}
await giveLot("1", "PREMIUM", 2000, 800000) // 購入（おまけ 25%）
const total0 = await totalCoins()
const cfg = await call("GET", "/internal/open-requests/config?userId=1")
assert.equal(cfg.body.data.account.paidPremiumBalance, 2000)
assert.equal((await create("1", { rewardCoins: 50 })).body.error, "INVALID_REWARD")
assert.equal((await create("1", { title: "" })).body.error, "TITLE_REQUIRED")
const r1 = await create("1", { clientKey: "same", showcaseAllowed: true })
assert.equal(r1.status, 200)
const req1 = r1.body.data.requestId
const dup = await create("1", { clientKey: "same" })
assert.equal(dup.body.data.requestId, req1, "二度押しは同じ募集")
assert.deepEqual(await balance("1"), { free: 5000, premium: 6500, paidPremium: 1500 }, "500 を預かる（購入したロットから）")
{
  const row = await db.queryOne<any>(`SELECT premium_spent, paid_coins FROM open_requests WHERE id = $1`, [req1])
  assert.equal(Number(row.premium_spent), 500)
  assert.equal(Number(row.paid_coins), 400, "有料の分は 80%")
}
assert.equal(await totalCoins(), total0)

// ---- 2. 提案 ----
assert.equal((await propose(req1, "1")).body.error, "SELF_PROPOSAL")
assert.equal((await propose(req1, "2", { imageUrls: ["https://evil.example.com/a.png"] })).body.error, "IMAGE_REQUIRED", "外のサイトの画像は使えない")
const p2a = (await propose(req1, "2", { message: "描きました" })).body.data.proposalId
const p2b = (await propose(req1, "2", { imageUrls: [], workId: "100" })).body.data.proposalId
assert.ok(p2b)
assert.equal((await propose(req1, "2", { imageUrls: [], workId: "101" })).body.error, "R18_NOT_ALLOWED", "全年齢の募集に R18 の作品は出せない")
assert.equal((await propose(req1, "3", { imageUrls: [], workId: "100" })).body.error, "WORK_NOT_FOUND", "他人の作品は出せない")
const p2c = (await propose(req1, "2")).body.data.proposalId
assert.ok(p2c)
assert.equal((await propose(req1, "2")).body.error, "TOO_MANY_PROPOSALS", "1 人 3 件まで")
assert.equal((await actP(p2c, "2", "withdraw")).status, 200)
assert.ok((await propose(req1, "2")).body.data.proposalId, "取り下げた分はまた出せる")
const p3 = (await propose(req1, "3")).body.data.proposalId
{
  const n = await notifications(1)
  assert.equal(n.length, 1, "提案の通知は 10 分に 1 回まで")
  assert.equal(Number(n[0].commentId), -Number(req1), "commentId は募集の ID のマイナス")
  assert.match(n[0].comment, /user2さんが募集リクエスト「猫の絵」に提案しました/)
}

// ---- 3. いいね・コメント ----
assert.equal((await actP(p2a, "2", "like")).body.error, "SELF_LIKE")
for (const u of ["4", "5", "1"]) await actP(p3, u, "like")
await actP(p3, "4", "like") // 二度押し
await actP(p2a, "4", "like")
assert.equal((await actP(p3, "6", "like")).body.data.likeCount, 4)
assert.equal((await actP(p3, "6", "unlike")).body.data.likeCount, 3)
const c1 = await actP(p3, "4", "comment", { body: "かわいい！" })
assert.equal(c1.status, 200)
await actP(p3, "3", "comment", { body: "ありがとうございます" })
assert.equal((await actP(p3, "4", "delete-comment", { commentId: "999" })).body.error, "NOT_FOUND")
{
  const detail = await call("GET", `/internal/open-requests/${req1}?viewerUserId=4`)
  const tree = detail.body.data.request
  assert.equal(tree.proposalCount, 4)
  assert.equal(tree.proposals[0].id, p3, "いいねの多い順")
  assert.equal(tree.proposals[0].isLikedByMe, true)
  assert.deepEqual(tree.proposals[0].comments.map((c: any) => c.body), ["かわいい！", "ありがとうございます"])
  assert.ok(detail.body.data.users["3"], "提案者・コメントした人の名前も返す")
  assert.equal(tree.settlement, null, "依頼者以外に内訳は見せない")
  const list = await call("GET", "/internal/open-requests?sort=reward")
  assert.equal(list.body.data.requests.length, 1)
  assert.equal(list.body.data.requests[0].previewImageUrls.length, 3)
}

// ---- 4. 提案があると取り下げられない・採用 ----
assert.equal((await actR(req1, "1", "cancel")).body.error, "HAS_PROPOSALS")
assert.equal((await actR(req1, "2", "award", { proposalId: p3 })).body.error, "FORBIDDEN")
await db.execute(`INSERT INTO creator_payout_profiles(user_id, status, terms_version, joined_at, created_at, updated_at) VALUES ('2', 'JOINED', 'v', $1, $1, $1)`, [NOW])
const [a1, a2] = await Promise.all([actR(req1, "1", "award", { proposalId: p2a }), actR(req1, "1", "award", { proposalId: p3 })])
assert.equal([a1, a2].filter((r) => r.status === 200).length, 1, "同時に押しても採用は 1 件")
{
  const row = await db.queryOne<any>(`SELECT * FROM open_requests WHERE id = $1`, [req1])
  const winner = String(row.awarded_user_id)
  assert.equal(row.status, "AWARDED")
  assert.equal(Number(row.fee_coins), 50)
  if (winner === "2") {
    // 参加中: 有料 400 のうち手数料を引いた 360 は報酬、残り 90 はプレミアムコイン
    assert.equal(Number(row.earned_coins), 360)
    assert.equal(Number(row.settle_premium_coins), 90)
    const earning = await db.queryOne<any>(`SELECT coins, kind FROM creator_earnings WHERE user_id = '2' AND source = $1`, [`open-request:${req1}`])
    assert.equal(Number(earning.coins), 360)
    assert.equal(earning.kind, "REQUEST")
  } else {
    // 不参加: 全部コイン
    assert.equal(Number(row.earned_coins), 0)
    assert.equal(Number(row.settle_premium_coins), 450)
    assert.equal((await balance("3")).premium, 450)
  }
  const awarded = await db.query<any>(`SELECT id FROM open_request_proposals WHERE request_id = $1 AND is_awarded = 1`, [req1])
  assert.equal(awarded.length, 1)
  assert.equal(String(awarded[0].id), String(row.awarded_proposal_id))
  assert.ok((await notifications(Number(winner))).some((n) => n.comment.startsWith("🏆 あなたの提案が")))
}
assert.equal((await actR(req1, "1", "award", { proposalId: p3 })).body.error, "INVALID_STATE", "採用は 1 回だけ")
assert.equal((await actP(p3, "6", "like")).body.error, "CLOSED", "終わった募集にはいいねできない")
assert.equal((await propose(req1, "6")).body.error, "CLOSED")
assert.equal(await totalCoins(), total0)
{
  const detail = await call("GET", `/internal/open-requests/${req1}?viewerUserId=1`)
  assert.equal(detail.body.data.request.settlement.feeCoins, 50, "依頼者には内訳を見せる")
  const winner = detail.body.data.request.awardedUserId
  const showcase = await call("GET", `/internal/open-requests/showcase?userId=${winner}`)
  assert.equal(showcase.body.data.items.length, 1, "公開を許可した採用は実績に出る")
  await actR(req1, "1", "showcase", { allowed: false })
  assert.equal((await call("GET", `/internal/open-requests/showcase?userId=${winner}`)).body.data.items.length, 0)
}

// ---- 5. 締切: いいね最多の自動採用 ----
const req2 = (await create("1", { rewardCoins: 300 })).body.data.requestId
const q4 = (await propose(req2, "4")).body.data.proposalId
const q5 = (await propose(req2, "5")).body.data.proposalId
await actP(q5, "6", "like")
await actP(q5, "3", "like")
await actP(q4, "6", "like")
// 提案がないまま締切 → 全額返却
const req3 = (await create("1", { rewardCoins: 200 })).body.data.requestId
// 提案がなければ取り下げられる
const req4 = (await create("1", { rewardCoins: 100 })).body.data.requestId
assert.equal((await actR(req4, "1", "cancel")).status, 200)
const before = await balance("1")
await db.execute(`UPDATE open_requests SET deadline_at = $1 WHERE id IN ($2, $3)`, [NOW - 1, req2, req3])
assert.equal((await propose(req2, "6")).body.error, "CLOSED", "締切を過ぎたら提案できない")
const job = await svc.runOpenRequestJob({ db, ...deps, now: NOW })
assert.equal(job.autoAwarded, 1)
assert.equal(job.expired, 1)
{
  const r2 = await db.queryOne<any>(`SELECT * FROM open_requests WHERE id = $1`, [req2])
  assert.equal(r2.status, "AUTO_AWARDED")
  assert.equal(String(r2.awarded_proposal_id), q5, "いいねが一番多い提案")
  assert.equal((await balance("5")).premium, 270, "手数料 30 を引いて渡す（不参加なので全部コイン）")
  const r3 = await db.queryOne<any>(`SELECT status FROM open_requests WHERE id = $1`, [req3])
  assert.equal(r3.status, "EXPIRED")
  const after = await balance("1")
  assert.equal(after.premium, before.premium + 200, "提案なしは全額返却")
  assert.equal(after.paidPremium, before.paidPremium + 200, "戻したコインでもまた募集できる（有料の割合を残す）")
  assert.ok((await notifications(1)).some((n) => n.comment.includes("自動で採用しました")))
  assert.ok((await notifications(1)).some((n) => n.comment.includes("全額返却")))
}
const again = await svc.runOpenRequestJob({ db, ...deps, now: NOW })
assert.equal(again.autoAwarded + again.expired, 0, "2 回目は何もしない")
assert.equal(await totalCoins(), total0)

// ---- 6. 運営 ----
const req5 = (await create("1", { rewardCoins: 100 })).body.data.requestId
const s6 = (await propose(req5, "6")).body.data.proposalId
await actP(s6, "4", "report", { reason: "無断転載" })
const adminList = await call("GET", "/internal/open-requests/admin/list?reported=1")
assert.equal(adminList.body.data.requests.length, 1)
await call("POST", `/internal/open-requests/admin/${req5}`, { moderatorUserId: "9", action: "hide-proposal", proposalId: s6 })
assert.equal((await call("GET", `/internal/open-requests/${req5}`)).body.data.request.proposals.length, 0, "隠した提案は出ない")
assert.equal((await call("POST", `/internal/open-requests/admin/${req5}`, { moderatorUserId: "9", action: "cancel" })).status, 200)
assert.equal(await totalCoins(), total0)
assert.equal((await db.queryOne<any>(`SELECT status FROM open_requests WHERE id = $1`, [req5])).status, "ADMIN_CANCELED")

console.log("open-requests ok")
await mf.dispose()
await d1.dispose()
