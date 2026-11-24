// 有料リクエストとプラン: コインの預かり（フリーかプレミアムのどちらか一方・プレミアムコインのみの受付、有料分の記録）・残高不足・二度押し・自分への依頼・同時申し込みと同時受付数、
// お断り/キャンセル/期限切れの全額返却（有料の割合を残す）・二重の返却なし、確定（手数料・報酬・R18・不参加）・二重の確定なし・確定とキャンセルの競合、
// 修正回数、期限の cron、通知、コインの総量が合うこと
import assert from "node:assert/strict"
import { Miniflare } from "miniflare"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { app } = await import(`${API}/app.ts`)
const svc = await import(`${API}/lib/coin-requests/service.ts`)
const { calcSettlement } = await import(`${API}/lib/coin-requests/config.ts`)

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

const env: Record<string, unknown> = {
  DB: d1.DB,
  GENLOG: d1.GENLOG,
  SYSTEM_CORE: CORE,
  SYSTEM_ACTIVITY: ACTIVITY,
  INTERNAL_API_TOKEN: "internal",
  CREATOR_PAYOUT_ENABLED: "1",
  COIN_REQUESTS_ENABLED: "1",
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

// ---- 1. 内訳の計算 ----
{
  // 全部有料のプレミアム 1000、手数料 10% → 報酬 900・コイン 0
  assert.deepEqual(calcSettlement({ freeSpent: 0, premiumSpent: 1000, paidCoins: 1000, feePpm: 100000, eligible: true }), { feeCoins: 100, settleFreeCoins: 0, settlePremiumCoins: 0, earnedCoins: 900 })
  // 無料 100 + プレミアム 400（有料 320）: 手数料 50 = 無料 10 + プレミアム 40 → 無料 90、プレミアム 360 のうち有料 288 を報酬
  assert.deepEqual(calcSettlement({ freeSpent: 100, premiumSpent: 400, paidCoins: 320, feePpm: 100000, eligible: true }), { feeCoins: 50, settleFreeCoins: 90, settlePremiumCoins: 72, earnedCoins: 288 })
  // 対象外（R18・不参加）は報酬 0、全部コイン
  assert.deepEqual(calcSettlement({ freeSpent: 0, premiumSpent: 1000, paidCoins: 1000, feePpm: 100000, eligible: false }), { feeCoins: 100, settleFreeCoins: 0, settlePremiumCoins: 900, earnedCoins: 0 })
  // 端数: 101 コインの手数料は 11（切り上げ）
  assert.equal(calcSettlement({ freeSpent: 0, premiumSpent: 101, paidCoins: 0, feePpm: 100000, eligible: true }).feeCoins, 11)
}

// ---- 2. プラン ----
const bad = await call("POST", "/internal/requests/plans", { userId: "1", title: "x", description: "d", priceCoins: 50 })
assert.equal(bad.body.error, "INVALID_PRICE")
const created = await call("POST", "/internal/requests/plans", {
  userId: "1",
  title: "アイコン 1 枚",
  description: "SNS のアイコンを描きます",
  category: "ICON",
  priceCoins: 500,
  deliveryDays: 7,
  revisionCount: 1,
  maxActive: 2,
  sampleImageUrls: ["https://image.aipictors.com/a.webp", "https://evil.example.com/x.png"],
})
assert.equal(created.status, 200)
const plan = created.body.data.plan
assert.deepEqual(plan.sampleImageUrls, ["https://image.aipictors.com/a.webp"], "外のサイトの画像は入れない")
const listed = await call("GET", "/internal/requests/plans?category=ICON&sort=new")
assert.equal(listed.body.data.plans.length, 1)
const otherEdit = await call("POST", "/internal/requests/plans", { userId: "2", planId: plan.id, title: "乗っ取り", description: "d", priceCoins: 500 })
assert.equal(otherEdit.body.error, "PLAN_NOT_FOUND", "他人のプランは編集できない")

// 見本の画像がないプランは、クリエイターの投稿作品（公開中・全年齢）のサムネイルを workImageUrls で返す（sampleImageUrls は空のまま）
{
  await CORE.prepare(
    "CREATE TABLE works (id INTEGER PRIMARY KEY, userId INTEGER, ageLimit INTEGER, is_deleted INTEGER DEFAULT 0, adminViewMode INTEGER DEFAULT 0, viewMode INTEGER DEFAULT 0, time INTEGER, large_thumbnail_image_url TEXT)",
  ).run()
  const rows: Array<[number, number, number, number, string]> = [
    [1, 0, 0, 100, "https://image.aipictors.com/w-old.webp"],
    [1, 0, 0, 200, "https://image.aipictors.com/w-new.webp"],
    [1, 1, 0, 300, "https://image.aipictors.com/w-r18.webp"],
    [1, 0, 1, 400, "https://image.aipictors.com/w-deleted.webp"],
  ]
  for (const [userId, ageLimit, deleted, time, url] of rows) {
    await CORE.prepare("INSERT INTO works (userId, ageLimit, is_deleted, time, large_thumbnail_image_url) VALUES (?1, ?2, ?3, ?4, ?5)").bind(userId, ageLimit, deleted, time, url).run()
  }
  const noSample = await call("POST", "/internal/requests/plans", { userId: "1", title: "見本なし", description: "d", priceCoins: 300, status: "HIDDEN" })
  const id = noSample.body.data.plan.id
  const detail = await call("GET", `/internal/requests/plans/${id}?viewerUserId=1`)
  assert.deepEqual(detail.body.data.plan.sampleImageUrls, [])
  assert.deepEqual(detail.body.data.plan.workImageUrls, ["https://image.aipictors.com/w-new.webp", "https://image.aipictors.com/w-old.webp"], "新しい順・R18 と削除済みは除く")
  const withSample = await call("GET", `/internal/requests/plans/${plan.id}`)
  assert.equal(withSample.body.data.plan.workImageUrls, undefined, "見本があるプランには付けない")
  const creator = await call("GET", "/internal/requests/creators/1?viewerUserId=1")
  assert.equal(creator.body.data.plans.find((p: any) => p.id === id).workImageUrls.length, 2)
  await call("POST", `/internal/requests/plans/${id}/delete`, { userId: "1" })
}

// ---- 3. 残高不足・自分への依頼 ----
await giveLot("2", "FREE", 50)
await giveLot("2", "PREMIUM", 1000, 800000) // 有料 80%（Web の購入でおまけ 25%）
const total0 = await totalCoins()
{
  const poor = await apply("3", { planId: plan.id, priceCoins: 500 })
  assert.equal(poor.status, 402)
  assert.equal(poor.body.error, "INSUFFICIENT_COINS")
  const self = await apply("1", { planId: plan.id, priceCoins: 500 })
  assert.equal(self.body.error, "SELF_REQUEST")
  const priceChanged = await apply("2", { planId: plan.id, priceCoins: 400 })
  assert.equal(priceChanged.body.error, "PRICE_CHANGED")
  assert.deepEqual(await balance("2"), { free: 50, premium: 1000 })
  assert.equal((await db.queryOne<any>(`SELECT COUNT(*) AS n FROM coin_requests`)).n, 0)
}

// ---- 4. 預かり（混ぜない: フリー 50 では足りないのでプレミアムだけで払う）・二度押し ----
const key = "double-click"
const first = await call("POST", "/internal/requests", { requesterUserId: "2", clientKey: key, body: "お願いします", planId: plan.id, priceCoins: 500 })
const second = await call("POST", "/internal/requests", { requesterUserId: "2", clientKey: key, body: "お願いします", planId: plan.id, priceCoins: 500 })
assert.equal(first.status, 200)
assert.equal(second.body.data.requestId, first.body.data.requestId, "二度押しは同じ依頼")
const req1 = first.body.data.requestId
assert.deepEqual(await balance("2"), { free: 50, premium: 500 }, "プレミアム 500 だけを 1 回だけ（フリー 50 は使わない）")
{
  const row = await db.queryOne<any>(`SELECT * FROM coin_requests WHERE id = $1`, [req1])
  assert.equal(row.free_spent, 0)
  assert.equal(row.premium_spent, 500)
  assert.equal(row.paid_coins, 400, "有料分 = 500 × 80%")
  assert.equal(row.status, "PENDING")
  const n = await notifications(1)
  assert.equal(n.length, 1)
  assert.match(n[0].comment, /user2さんからリクエスト「アイコン 1 枚」が届きました（500コイン）/)
  assert.equal(String(n[0].commentId), req1)
}
assert.equal(await totalCoins(), total0, "預かってもコインの総量は同じ")

// ---- 5. お断り → 全額返却（有料の割合を残す）、二重のお断り・承諾はできない ----
{
  const viewOther = await call("GET", `/internal/requests/${req1}?userId=5`)
  assert.equal(viewOther.status, 404, "当事者以外は見られない")
  const byRequester = await act(req1, "2", "decline")
  assert.equal(byRequester.body.error, "FORBIDDEN")
  const declined = await act(req1, "1", "decline", { reason: "スケジュールが合いません" })
  assert.equal(declined.status, 200)
  assert.equal(declined.body.data.request.status, "DECLINED")
  assert.deepEqual(await balance("2"), { free: 50, premium: 1000 }, "全額返却")
  const lot = await db.queryOne<any>(`SELECT paid_ratio_ppm FROM coin_lots WHERE user_id = '2' AND source_kind = 'REQUEST_REFUND' AND coin_type = 'PREMIUM'`)
  assert.equal(lot.paid_ratio_ppm, 800000, "返したプレミアムは有料の割合 80% のまま")
  const again = await act(req1, "1", "decline")
  assert.equal(again.status, 409)
  const accept = await act(req1, "1", "accept")
  assert.equal(accept.status, 409)
  assert.deepEqual(await balance("2"), { free: 50, premium: 1000 }, "二重に返さない")
  assert.match((await notifications(2)).at(-1).comment, /お断りしました。500コインは全額返却されました/)
}
assert.equal(await totalCoins(), total0)

// ---- 6. 承諾 → 納品 → 修正 → 納品 → 確定（参加中・全年齢 → 報酬） ----
await db.execute(`INSERT INTO creator_payout_profiles(user_id, status, terms_version, joined_at, created_at, updated_at) VALUES ('1', 'JOINED', 'v', $1, $1, $1)`, [NOW])
let req2: string
{
  const r = await apply("2", { planId: plan.id, priceCoins: 500 })
  req2 = r.body.data.requestId
  // 返却ロットの期限で順番が変わるので内訳を確かめる
  const row = await db.queryOne<any>(`SELECT free_spent, premium_spent, paid_coins FROM coin_requests WHERE id = $1`, [req2])
  assert.equal(row.free_spent + row.premium_spent, 500)
  const accepted = await act(req2, "1", "accept", { message: "よろしくお願いします" })
  assert.equal(accepted.body.data.request.status, "ACCEPTED")
  assert.ok(accepted.body.data.request.dueAt > NOW + 6 * 86400)
  const early = await act(req2, "2", "complete")
  assert.equal(early.status, 409, "納品前に確定はできない")
  const notOverdue = await act(req2, "2", "cancel")
  assert.equal(notOverdue.body.error, "NOT_OVERDUE", "制作中は納期を過ぎるまでキャンセルできない")
  const empty = await act(req2, "1", "deliver", { message: "どうぞ" })
  assert.equal(empty.body.error, "DELIVERY_REQUIRED")
  const delivered = await act(req2, "1", "deliver", { message: "納品します", imageUrls: ["https://image.aipictors.com/d1.webp"] })
  assert.equal(delivered.body.data.request.status, "DELIVERED")
  const revised = await act(req2, "2", "revise", { message: "目の色を青に" })
  assert.equal(revised.body.data.request.status, "ACCEPTED")
  assert.equal(revised.body.data.request.revisionLeft, 0)
  await act(req2, "1", "deliver", { imageUrls: ["https://image.aipictors.com/d2.webp"] })
  const noMore = await act(req2, "2", "revise", { message: "もう一回" })
  assert.equal(noMore.body.error, "NO_REVISIONS_LEFT", "修正はプランの回数まで")
  const msg = await act(req2, "2", "message", { body: "ありがとうございます！" })
  assert.equal(msg.status, 200)
  // メッセージへのリアクション: 相手のメッセージに 1 人 1 つ。自分のメッセージ・お知らせ・許可していない絵文字は不可。空で外す
  const sent = msg.body.data.request.messages
  const mine = sent.at(-1)
  const creatorMsg = sent.findLast((m: any) => m.senderUserId === "1")
  const systemMsg = sent.find((m: any) => m.senderUserId === null)
  assert.equal((await act(req2, "2", "react", { messageId: mine.id, emoji: "👍" })).body.error, "MESSAGE_NOT_FOUND", "自分のメッセージには付けない")
  assert.equal((await act(req2, "2", "react", { messageId: systemMsg.id, emoji: "👍" })).body.error, "MESSAGE_NOT_FOUND", "お知らせには付けない")
  assert.equal((await act(req2, "2", "react", { messageId: creatorMsg.id, emoji: "💩" })).body.error, "INVALID_REACTION")
  assert.equal((await act(req2, "3", "react", { messageId: creatorMsg.id, emoji: "👍" })).status, 404, "当事者以外は付けられない")
  await act(req2, "2", "react", { messageId: creatorMsg.id, emoji: "👍" })
  const reacted = await act(req2, "2", "react", { messageId: creatorMsg.id, emoji: "🙏" })
  assert.deepEqual(reacted.body.data.request.messages.find((m: any) => m.id === creatorMsg.id).reactions, [{ userId: "2", emoji: "🙏" }], "付け直すと置き換わる")
  const reactedByCreator = await act(req2, "1", "react", { messageId: mine.id, emoji: "❤️" })
  assert.deepEqual(reactedByCreator.body.data.request.messages.find((m: any) => m.id === mine.id).reactions, [{ userId: "1", emoji: "❤️" }])
  const cleared = await act(req2, "2", "react", { messageId: creatorMsg.id, emoji: "" })
  assert.deepEqual(cleared.body.data.request.messages.find((m: any) => m.id === creatorMsg.id).reactions, [], "空で外す")
  assert.deepEqual(cleared.body.data.request.messages.find((m: any) => m.id === systemMsg.id).reactions, [])
  const before = await balance("1")
  const completed = await act(req2, "2", "complete")
  assert.equal(completed.status, 200)
  const s = completed.body.data.request.settlement
  const expected = calcSettlement({ freeSpent: row.free_spent, premiumSpent: row.premium_spent, paidCoins: row.paid_coins, feePpm: 100000, eligible: true })
  assert.equal(s.feeCoins, 50)
  assert.equal(s.earnedCoins, expected.earnedCoins)
  assert.ok(s.earnedCoins > 0)
  const earning = await db.queryOne<any>(`SELECT * FROM creator_earnings WHERE source = $1`, [`coin-request:${req2}`])
  assert.equal(earning.kind, "REQUEST")
  assert.equal(earning.user_id, "1")
  assert.equal(earning.sender_user_id, "2")
  assert.equal(earning.coins, expected.earnedCoins)
  assert.equal(earning.amount_milliyen, expected.earnedCoins * 500, "0.5 円/枚")
  assert.equal(earning.status, "HELD")
  assert.ok(earning.available_at >= NOW + 7 * 86400 && earning.available_at < NOW + 8 * 86400, "換金と同じ 7 日保留")
  const after = await balance("1")
  assert.equal(after.free - before.free, expected.settleFreeCoins)
  assert.equal(after.premium - before.premium, expected.settlePremiumCoins)
  const twice = await act(req2, "2", "complete")
  assert.equal(twice.status, 409, "二重に確定しない")
  assert.equal((await db.queryOne<any>(`SELECT COUNT(*) AS n FROM creator_earnings WHERE source = $1`, [`coin-request:${req2}`])).n, 1)
  assert.deepEqual(await balance("1"), after)
  const msgs = (await call("GET", `/internal/requests/${req2}?userId=1`)).body.data.request
  assert.equal(msgs.escrow, null, "クリエイターには預かりの内訳を見せない")
  assert.ok(msgs.messages.length >= 6)
}
assert.equal(await totalCoins(), total0, "確定してもコインの総量（手数料・報酬を含む）は同じ")

// ---- 7. R18 の依頼は報酬にしない・不参加の人はコイン ----
await call("POST", "/internal/requests/settings/4", { acceptsFreeRequests: true, minCoins: 300, allowsR18: true, maxActive: 2 })
await giveLot("5", "PREMIUM", 2000, 1000000)
{
  const r18 = await apply("5", { creatorUserId: "4", priceCoins: 1000, isR18: true, body: "R18 の依頼" })
  assert.equal(r18.status, 200)
  await act(r18.body.data.requestId, "4", "accept")
  await act(r18.body.data.requestId, "4", "deliver", { imageUrls: ["https://image.aipictors.com/r.webp"] })
  const done = await act(r18.body.data.requestId, "5", "complete")
  assert.equal(done.body.data.request.settlement.earnedCoins, 0, "R18 は報酬の対象外")
  assert.equal(done.body.data.request.settlement.premiumCoins, 900, "コインで受け取る")
  const below = await apply("5", { creatorUserId: "4", priceCoins: 200 })
  assert.equal(below.body.error, "BELOW_MINIMUM")
  const closed = await apply("5", { creatorUserId: "6", priceCoins: 500 })
  assert.equal(closed.body.error, "NOT_ACCEPTING", "受付をオンにしていない人には自由リクエストできない")
}

// ---- 8. 同時申し込み: 空き 1 に 3 人が同時 → 1 件だけ、他の人のコインは減らない ----
{
  const p = await call("POST", "/internal/requests/plans", { userId: "6", title: "1 枠だけ", description: "d", priceCoins: 300, maxActive: 1 })
  const pid = p.body.data.plan.id
  for (const u of ["2", "3", "5"]) await giveLot(u, "PREMIUM", 300, 1000000)
  const before = { "2": await balance("2"), "3": await balance("3"), "5": await balance("5") }
  const results = await Promise.all(["2", "3", "5"].map((u) => apply(u, { planId: pid, priceCoins: 300 })))
  const ok = results.filter((r) => r.status === 200)
  assert.equal(ok.length, 1, "同時でも受付数を超えない")
  assert.ok(results.filter((r) => r.status !== 200).every((r) => r.body.error === "FULL"))
  let spent = 0
  for (const u of ["2", "3", "5"] as const) {
    const b = await balance(u)
    spent += before[u].free + before[u].premium - (b.free + b.premium)
  }
  assert.equal(spent, 300, "減ったのは受け付けた 1 件分だけ")
  // 取り下げ → 空きができる → 次の人が申し込める
  const okId = ok[0].body.data.requestId
  const owner = (await db.queryOne<any>(`SELECT requester_user_id FROM coin_requests WHERE id = $1`, [okId])).requester_user_id
  const canceled = await act(okId, owner, "cancel")
  assert.equal(canceled.body.data.request.status, "CANCELED")
  const next = await apply(owner === "2" ? "3" : "2", { planId: pid, priceCoins: 300 })
  assert.equal(next.status, 200)
  // 確定とキャンセル（運営）が同時 → どちらか 1 つだけ
  const nid = next.body.data.requestId
  await act(nid, "6", "accept")
  await act(nid, "6", "deliver", { imageUrls: ["https://image.aipictors.com/x.webp"] })
  const t0 = await totalCoins()
  const race = await Promise.all([
    act(nid, owner === "2" ? "3" : "2", "complete"),
    call("POST", `/internal/requests/admin/${nid}`, { moderatorUserId: "99", action: "cancel", reason: "test" }),
  ])
  assert.equal(race.filter((r) => r.status === 200).length, 1, "確定とキャンセルはどちらか 1 回")
  assert.equal(await totalCoins(), t0)
}
assert.equal(await totalCoins(), total0 + 2000 + 900, "足したロット分だけ増える（2000 + 300×3）")

// ---- 9. 期限の cron ----
{
  await giveLot("3", "PREMIUM", 1000, 0)
  const p = await apply("3", { planId: plan.id, priceCoins: 500 })
  const pend = p.body.data.requestId
  const b0 = await balance("3")
  const r = await svc.runRequestJob({ db, ...deps, now: NOW + 3 * 86400 + 10 })
  assert.ok(r.expired >= 1)
  assert.equal((await db.queryOne<any>(`SELECT status, closed_reason FROM coin_requests WHERE id = $1`, [pend])).status, "EXPIRED")
  const b1 = await balance("3")
  assert.equal(b1.premium - b0.premium + b1.free - b0.free, 500, "期限切れは全額返却")
  // 制作中の納期超過（納期 + 3 日）→ 自動キャンセル
  const q = await apply("3", { planId: plan.id, priceCoins: 500 })
  await act(q.body.data.requestId, "1", "accept")
  const remind = await svc.runRequestJob({ db, ...deps, now: NOW + 6 * 86400 + 3600 })
  assert.ok(remind.reminded >= 1, "納期の 24 時間前に知らせる")
  const overdueCancel = await act(q.body.data.requestId, "3", "cancel")
  assert.equal(overdueCancel.body.error, "NOT_OVERDUE")
  await svc.runRequestJob({ db, ...deps, now: NOW + 10 * 86400 + 60 })
  assert.equal((await db.queryOne<any>(`SELECT status, closed_reason FROM coin_requests WHERE id = $1`, [q.body.data.requestId])).closed_reason, "overdue")
  // 納品から 7 日 → 自動で確定
  const d = await apply("3", { planId: plan.id, priceCoins: 500 })
  await act(d.body.data.requestId, "1", "accept")
  await act(d.body.data.requestId, "1", "deliver", { imageUrls: ["https://image.aipictors.com/z.webp"] })
  const auto = await svc.runRequestJob({ db, ...deps, now: NOW + 7 * 86400 + 60 })
  assert.ok(auto.autoCompleted >= 1)
  assert.equal((await db.queryOne<any>(`SELECT status FROM coin_requests WHERE id = $1`, [d.body.data.requestId])).status, "COMPLETED")
  const again = await svc.runRequestJob({ db, ...deps, now: NOW + 7 * 86400 + 120 })
  assert.equal(again.autoCompleted + again.expired + again.overdueCanceled, 0, "2 回目は何もしない")
}
assert.equal(await totalCoins(), total0 + 2900 + 1000)

// ---- 10. 一覧・バッジ・ブロック・運営の一覧 ----
{
  const received = await call("GET", "/internal/requests?userId=1&role=received&status=done")
  assert.ok(received.body.data.requests.length >= 2)
  assert.ok(received.body.data.counts.closed >= 1)
  const badge = await call("GET", "/internal/requests/badge/1")
  assert.equal(typeof badge.body.data.received, "number")
  await CORE.prepare("INSERT INTO blocked_users (user_id, blocked_user_id) VALUES (1, 5)").run()
  const blocked = await apply("5", { planId: plan.id, priceCoins: 500 })
  assert.equal(blocked.body.error, "BLOCKED")
  const report = await act(req2, "2", "report", { reason: "テスト通報" })
  assert.equal(report.status, 200)
  const admin = await call("GET", "/internal/requests/admin/list?reported=1")
  assert.equal(admin.body.data.requests.length, 1)
  assert.ok(admin.body.data.totals.feeCoins > 0)
  const profile = await call("GET", "/internal/requests/creators/4")
  assert.equal(profile.body.data.settings.acceptsFreeRequests, true)
}

// ---- 11. 払うコインはどちらか一方・プレミアムコインのみの受付 ----
{
  const creator = "6"
  const requester = "3"
  const made = await call("POST", "/internal/requests/plans", { userId: creator, title: "プレミアム限定", description: "d", priceCoins: 600, premiumOnly: true })
  const premiumPlan = made.body.data.plan
  assert.equal(premiumPlan.premiumOnly, true)
  // 古いアプリは premiumOnly を送らない: 編集してもプレミアムコインのみのまま
  const edited = await call("POST", "/internal/requests/plans", { userId: creator, planId: premiumPlan.id, title: "プレミアム限定（編集）", description: "d", priceCoins: 600 })
  assert.equal(edited.body.data.plan.premiumOnly, true, "送られてこなければ設定は変えない")
  const anyPlan = (await call("POST", "/internal/requests/plans", { userId: creator, title: "どちらでも", description: "d", priceCoins: 600 })).body.data.plan
  assert.equal(anyPlan.premiumOnly, false, "新規の既定はフリーコインもOK")

  await giveLot(requester, "FREE", 700, 0, NOW + 86400)
  const before = await balance(requester)
  const t0 = await totalCoins()
  // プレミアムコインのみのプランにフリーコインで申し込めない
  const freeToPremium = await apply(requester, { planId: premiumPlan.id, priceCoins: 600, coinType: "FREE" })
  assert.equal(freeToPremium.body.error, "PREMIUM_ONLY")
  assert.deepEqual(await balance(requester), before, "断られたらコインは動かない")
  // フリーコインで足りるならフリーだけ
  const byFree = await apply(requester, { planId: anyPlan.id, priceCoins: 600, coinType: "FREE" })
  assert.equal(byFree.status, 200)
  const freeRow = await db.queryOne<any>(`SELECT free_spent, premium_spent, paid_coins FROM coin_requests WHERE id = $1`, [byFree.body.data.requestId])
  assert.deepEqual([freeRow.free_spent, freeRow.premium_spent, freeRow.paid_coins], [600, 0, 0])
  assert.deepEqual(await balance(requester), { free: before.free - 600, premium: before.premium })
  // フリーが足りないとき、プレミアムで補わない（混ぜない）
  const short = await apply(requester, { planId: anyPlan.id, priceCoins: 600, coinType: "FREE" })
  assert.equal(short.body.error, "INSUFFICIENT_COINS")
  // プレミアムを選べばプレミアムだけ
  const premiumBefore = await balance(requester)
  const byPremium = await apply(requester, { planId: premiumPlan.id, priceCoins: 600, coinType: "PREMIUM" })
  assert.equal(byPremium.status, 200)
  const premiumRow = await db.queryOne<any>(`SELECT free_spent, premium_spent FROM coin_requests WHERE id = $1`, [byPremium.body.data.requestId])
  assert.deepEqual([premiumRow.free_spent, premiumRow.premium_spent], [0, 600])
  assert.deepEqual(await balance(requester), { free: premiumBefore.free, premium: premiumBefore.premium - 600 }, "フリーコインは残る")
  assert.equal(await totalCoins(), t0, "コインの総量は同じ")

  // 自由リクエストの受付もプレミアムコインのみにできる。指定なしの申し込みはプレミアムで払う
  await call("POST", "/internal/requests/settings/6", { acceptsFreeRequests: true, minCoins: 300, maxActive: 3, premiumOnly: true })
  const settings = await call("GET", "/internal/requests/settings/6")
  assert.equal(settings.body.data.premiumOnly, true)
  await call("POST", "/internal/requests/settings/6", { acceptsFreeRequests: true, minCoins: 300, maxActive: 3 })
  assert.equal((await call("GET", "/internal/requests/settings/6")).body.data.premiumOnly, true, "送られてこなければ設定は変えない")
  const freeReqByFree = await apply("2", { creatorUserId: creator, priceCoins: 300, coinType: "FREE" })
  assert.equal(freeReqByFree.body.error, "PREMIUM_ONLY")
  const freeReqAuto = await apply("2", { creatorUserId: creator, priceCoins: 300 })
  assert.equal(freeReqAuto.status, 200)
  const autoRow = await db.queryOne<any>(`SELECT free_spent, premium_spent FROM coin_requests WHERE id = $1`, [freeReqAuto.body.data.requestId])
  assert.deepEqual([autoRow.free_spent, autoRow.premium_spent], [0, 300], "指定なし + プレミアムコインのみ → プレミアム")
  // 指定なし（古いアプリ）でフリーコインが足りるならフリーだけ
  await giveLot("1", "FREE", 600, 0, NOW + 86400)
  const legacy = await apply("1", { planId: anyPlan.id, priceCoins: 600 })
  assert.equal(legacy.status, 200)
  const legacyRow = await db.queryOne<any>(`SELECT free_spent, premium_spent FROM coin_requests WHERE id = $1`, [legacy.body.data.requestId])
  assert.deepEqual([legacyRow.free_spent, legacyRow.premium_spent], [600, 0], "指定なし + フリーで足りる → フリー")
}

console.log("coin-requests: ok")
await mf.dispose()
await d1.dispose()
