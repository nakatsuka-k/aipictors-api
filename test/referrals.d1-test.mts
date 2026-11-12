// 紹介特典: ひも付けと登録の特典・はじめての生成 / 投稿 / 支払いの特典・月の上限・不正の弾き方（aipictors-system の core は別の D1 で用意する）
import assert from "node:assert/strict"
import { Miniflare } from "miniflare"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { app } = await import(`${API}/app.ts`)
const { signPayload } = await import(`${API}/lib/stripe.ts`)
const { grantReferralActionRewards, jstMonthStart } = await import(`${API}/lib/referrals.ts`)
const { applyPrepaidPass } = await import(`${API}/lib/prepaid-pass.ts`)

import { createTestD1 } from "./d1.mts"
const d1 = await createTestD1()
const db = d1.db
const genlog = d1.genlog

// aipictors-system の core（使う表だけ）
const coreMf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["CORE"] })
const CORE = await coreMf.getD1Database("CORE")
await CORE.prepare("CREATE TABLE wp_users (ID INTEGER PRIMARY KEY, user_registered TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0)").run()
await CORE.prepare("CREATE TABLE ip_bindings (ip TEXT NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (ip, user_id))").run()
await CORE.prepare("CREATE TABLE works (id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER NOT NULL)").run()

const env = {
  DB: d1.DB,
  GENLOG: d1.GENLOG,
  SYSTEM_CORE: CORE,
  INTERNAL_API_TOKEN: "internal",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
}
globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(`予期しない fetch: ${String(input)}`)
}) as typeof fetch

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
let nextEventId = 1
const webhook = async (type: string, object: Record<string, unknown>) => {
  const payload = JSON.stringify({ id: `evt_${nextEventId++}`, type, data: { object } })
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = await signPayload("whsec_test", `${timestamp}.${payload}`)
  const res = await app.fetch(
    new Request("http://api.test/webhooks/stripe", { method: "POST", headers: { "stripe-signature": `t=${timestamp},v1=${signature}` }, body: payload }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  )
  return res.status
}

const now = Math.floor(Date.now() / 1000)
const DAY = 86400
let nextUserId = 7000
// 登録したばかりの人（hoursAgo 時間前に登録）
const newUser = async (hoursAgo = 0) => {
  const id = nextUserId++
  await CORE.prepare("INSERT INTO wp_users(ID, user_registered) VALUES (?, ?)").bind(id, new Date((now - hoursAgo * 3600) * 1000).toISOString()).run()
  return String(id)
}
const codeOf = async (userId: string, seen: { deviceId?: string; ip?: string } = {}) =>
  (await call("POST", "/internal/referrals/summary", { userId, ...seen })).body.data.code as string
const attach = async (userId: string, code: string, seen: { deviceId?: string; ip?: string } = {}) =>
  (await call("POST", "/internal/referrals/attach", { userId, code, ...seen })).body.data as { attached: boolean; reason: string; grantedCoins: number; retry?: boolean }
const freeBalance = async (userId: string) =>
  Number((await db.queryOne<{ free_balance: number }>("SELECT free_balance FROM coin_balances WHERE user_id = $1", [userId]))?.free_balance ?? 0)
const rejections = async (userId: string) =>
  (await db.query<{ reason: string }>("SELECT reason FROM referral_rejections WHERE referred_user_id = $1 ORDER BY id", [userId])).map((row) => row.reason)
const generate = async (userId: string) =>
  genlog.execute(
    `INSERT INTO generated_queues(user_id, request_content, request_time, status, nanoid, platform, uuid) VALUES ($1, '{}', '2026-11-12 00:00:00', 'generated', $2, 'web', $2)`,
    [Number(userId), `n-${userId}-${Math.random()}`],
  )
const paidInvoice = (userId: string, amountPaid: number, billingReason = "subscription_create") => ({
  id: `in_${userId}_${amountPaid}_${billingReason}`,
  status: "paid",
  subscription: `sub_${userId}`,
  billing_reason: billingReason,
  amount_paid: amountPaid,
  created: now,
  subscription_details: { metadata: { kind: "subscription", user_id: userId, pass_type: "LITE", subscription_nanoid: `nano-${userId}`, interval: "month" } },
  lines: { data: [{ period: { start: now, end: now + 30 * DAY } }] },
})
// 定期処理（referrerUserId を渡すとその人の紹介だけ。渡さなければ全員分）
const runCron = (referrerUserId?: string) => grantReferralActionRewards({ db, genlog, core: CORE, referrerUserId })

let failed = 0
const test = async (name: string, run: () => Promise<void>) => {
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}`)
    console.log(error)
  }
}

const referrer = "6000"
let referrerCode = ""

await test("紹介コード: 1 人 1 つ・英小文字と数字 8 文字・何度聞いても同じ", async () => {
  const first = await call("POST", "/internal/referrals/summary", { userId: referrer, deviceId: "device-referrer-1", ip: "203.0.113.1" })
  assert.equal(first.status, 200)
  referrerCode = first.body.data.code
  assert.match(referrerCode, /^[a-z0-9]{8}$/)
  assert.deepEqual(first.body.data.rewards, { signup: 300, action: 300, paid: 2000 })
  assert.equal(first.body.data.monthlyLimit, 20)
  assert.equal(first.body.data.coinTtlDays, 7)
  assert.equal(first.body.data.invitedCount, 0)
  assert.equal(await codeOf(referrer), referrerCode)
  assert.notEqual(await codeOf("6001"), referrerCode)
})

await test("リンクから登録した人に 300 フリーコイン（7 日有効）。同じ組み合わせは 1 回だけ", async () => {
  const user = await newUser()
  const result = await attach(user, referrerCode, { deviceId: "device-aaaa-1", ip: "198.51.100.1" })
  assert.deepEqual(result, { attached: true, reason: "attached", grantedCoins: 300 })
  assert.equal(await freeBalance(user), 300)
  const lot = await db.queryOne<any>("SELECT expires_at FROM coin_lots WHERE user_id = $1 AND coin_type = 'FREE'", [user])
  assert.ok(Math.abs(Number(lot.expires_at) - (now + 7 * DAY)) < 60)
  const again = await attach(user, referrerCode, { deviceId: "device-aaaa-1", ip: "198.51.100.1" })
  assert.equal(again.attached, false)
  assert.equal(again.reason, "already")
  assert.equal(await freeBalance(user), 300)
  // 別の人のコードにも付け替えられない
  const other = await attach(user, await codeOf("6001"))
  assert.equal(other.reason, "already")
  // 紹介した人にはまだ何も付かない
  assert.equal(await freeBalance(referrer), 0)
  // コードの大文字・前後の空白は同じコードとして扱う
  const user2 = await newUser()
  assert.equal((await attach(user2, ` ${referrerCode.toUpperCase()} `, { deviceId: "device-bbbb-1", ip: "198.51.100.2" })).attached, true)
})

await test("自分自身・存在しないコード・前からあるアカウントは不可（弾いた記録が残る）", async () => {
  await CORE.prepare("INSERT INTO wp_users(ID, user_registered) VALUES (?, ?)").bind(Number(referrer), new Date((now - 3600) * 1000).toISOString()).run()
  assert.equal((await attach(referrer, referrerCode)).reason, "self")
  const user = await newUser()
  assert.equal((await attach(user, "zzzzzzzz")).reason, "unknown_code")
  assert.equal((await attach(user, "../etc")).reason, "unknown_code")
  const old = await newUser(24 * 30)
  assert.equal((await attach(old, referrerCode)).reason, "not_new_account")
  assert.equal(await freeBalance(old), 0)
  // 登録から 72 時間以内なら対象
  const recent = await newUser(71)
  assert.equal((await attach(recent, referrerCode, { ip: "198.51.100.3" })).attached, true)
  assert.deepEqual(await rejections(referrer), ["self"])
  assert.deepEqual(await rejections(old), ["not_new_account"])
  // 同じ人が何度試しても記録は増えない
  await attach(old, referrerCode)
  assert.deepEqual(await rejections(old), ["not_new_account"])
})

await test("登録時刻がまだ読めないときは付けずに、あとでもう一度試せる", async () => {
  const result = await attach("999001", referrerCode)
  assert.equal(result.attached, false)
  assert.equal(result.retry, true)
  assert.deepEqual(await rejections("999001"), [])
})

await test("同じ端末・同じ IP からの量産は弾く", async () => {
  // 紹介した人と同じ端末
  const sameDeviceAsReferrer = await newUser()
  assert.equal((await attach(sameDeviceAsReferrer, referrerCode, { deviceId: "device-referrer-1", ip: "198.51.100.10" })).reason, "same_device")
  // 紹介した人と同じ IP
  const sameIpAsReferrer = await newUser()
  assert.equal((await attach(sameIpAsReferrer, referrerCode, { deviceId: "device-cccc-1", ip: "203.0.113.1" })).reason, "same_ip")
  // 同じ端末で 2 つ目のアカウント
  const first = await newUser()
  assert.equal((await attach(first, referrerCode, { deviceId: "device-dddd-1", ip: "198.51.100.20" })).attached, true)
  const second = await newUser()
  assert.equal((await attach(second, referrerCode, { deviceId: "device-dddd-1", ip: "198.51.100.21" })).reason, "same_device")
  // 同じ IP は 2 人まで（3 人目から弾く）
  const ipUsers = [await newUser(), await newUser()]
  assert.equal((await attach(ipUsers[0], referrerCode, { deviceId: "device-eeee-1", ip: "198.51.100.20" })).attached, true)
  assert.equal((await attach(ipUsers[1], referrerCode, { deviceId: "device-eeee-2", ip: "198.51.100.20" })).reason, "same_ip")
  // 生成で同じ IP を使ったことがある（ip_bindings）
  const bound = await newUser()
  await CORE.prepare("INSERT INTO ip_bindings(ip, user_id) VALUES ('192.0.2.9', ?), ('192.0.2.9', ?)").bind(Number(referrer), Number(bound)).run()
  assert.equal((await attach(bound, referrerCode, { deviceId: "device-ffff-1", ip: "198.51.100.30" })).reason, "ip_overlap")
  for (const userId of [sameDeviceAsReferrer, sameIpAsReferrer, second, ipUsers[1], bound]) {
    assert.equal(await freeBalance(userId), 0, userId)
  }
  const stats = await call("GET", "/internal/referrals/stats?days=7")
  const byReason = Object.fromEntries(stats.body.data.rejections.map((row: any) => [row.reason, Number(row.count)]))
  assert.equal(byReason.same_device, 2)
  assert.equal(byReason.same_ip, 2)
  assert.equal(byReason.ip_overlap, 1)
  assert.equal(byReason.self, 1)
})

await test("はじめての生成で紹介した人に 300（1 回だけ・お知らせを残す）。投稿でも付く", async () => {
  const owner = "6100"
  const code = await codeOf(owner)
  const generator = await newUser()
  const poster = await newUser()
  const idle = await newUser()
  for (const [index, user] of [generator, poster, idle].entries()) {
    assert.equal((await attach(user, code, { ip: `198.51.101.${index + 1}` })).attached, true)
  }
  assert.deepEqual(await runCron(owner), { checked: 3, granted: 0 })
  await generate(generator)
  await CORE.prepare("INSERT INTO works(userId) VALUES (?)").bind(Number(poster)).run()
  // 全員分の定期処理で付く
  assert.equal((await runCron()).granted, 2)
  assert.equal(await freeBalance(owner), 600)
  // もう一度生成・投稿しても増えない
  await generate(generator)
  await CORE.prepare("INSERT INTO works(userId) VALUES (?)").bind(Number(generator)).run()
  assert.deepEqual(await runCron(owner), { checked: 1, granted: 0 })
  assert.equal(await freeBalance(owner), 600)
  const kinds = await db.query<any>("SELECT action_kind FROM referrals WHERE referrer_user_id = $1 AND action_kind IS NOT NULL ORDER BY id", [owner])
  assert.deepEqual(kinds.map((row) => row.action_kind), ["generation", "post"])
  const events = await db.query<any>("SELECT message, free_coins FROM coin_pending_events WHERE user_id = $1", [owner])
  assert.equal(events.length, 2)
  assert.match(events[0].message, /紹介特典/)
  const lots = await db.query<any>("SELECT expires_at FROM coin_lots WHERE user_id = $1 AND coin_type = 'FREE'", [owner])
  assert.ok(lots.every((lot) => Math.abs(Number(lot.expires_at) - (now + 7 * DAY)) < 60))
  // 紹介ページの数字
  const summary = (await call("POST", "/internal/referrals/summary", { userId: owner })).body.data
  assert.deepEqual(
    { invited: summary.invitedCount, action: summary.actionCount, paid: summary.paidCount, coins: summary.coinsEarned, used: summary.monthlyUsed },
    { invited: 3, action: 2, paid: 0, coins: 600, used: 3 },
  )
  // 紹介ページを開いたときにも確かめる（定期処理を待たない）
  await generate(idle)
  const opened = (await call("POST", "/internal/referrals/summary", { userId: owner })).body.data
  assert.equal(opened.actionCount, 3)
  assert.equal(await freeBalance(owner), 900)
})

await test("はじめての支払い（¥1 以上）で紹介した人に 2,000。無料お試しの開始（¥0）では付かない・2 回目の支払いでは付かない", async () => {
  const owner = "6200"
  const code = await codeOf(owner)
  const payer = await newUser()
  await attach(payer, code, { ip: "198.51.102.1" })
  assert.equal(await webhook("invoice.payment_succeeded", paidInvoice(payer, 0)), 200)
  assert.equal(await freeBalance(owner), 0)
  assert.equal(await webhook("invoice.payment_succeeded", paidInvoice(payer, 480, "subscription_cycle")), 200)
  assert.equal(await freeBalance(owner), 2000)
  assert.equal(await webhook("invoice.payment_succeeded", { ...paidInvoice(payer, 480, "subscription_cycle"), id: "in_next" }), 200)
  assert.equal(await freeBalance(owner), 2000)
  const summary = (await call("POST", "/internal/referrals/summary", { userId: owner })).body.data
  assert.equal(summary.paidCount, 1)
  assert.equal(summary.coinsEarned, 2000)
  // 紹介されていない人の支払いでは何も起きない
  assert.equal(await webhook("invoice.payment_succeeded", paidInvoice("6299", 980)), 200)
  // 自動更新なしのパスの購入でも付く
  const passBuyer = await newUser()
  await attach(passBuyer, code, { ip: "198.51.102.2" })
  await applyPrepaidPass(db, { sessionId: "cs_pass_1", userId: passBuyer, passType: "LITE", interval: "month", priceYen: 480 })
  assert.equal(await freeBalance(owner), 4000)
})

await test("特典を付ける前に同じ IP の利用が分かったら、その紹介は無効にして付けない", async () => {
  const owner = "6300"
  const code = await codeOf(owner)
  const user = await newUser()
  assert.equal((await attach(user, code, { ip: "198.51.103.1" })).attached, true)
  await CORE.prepare("INSERT INTO ip_bindings(ip, user_id) VALUES ('192.0.2.50', ?), ('192.0.2.50', ?)").bind(Number(owner), Number(user)).run()
  await generate(user)
  await runCron()
  assert.equal(await webhook("invoice.payment_succeeded", paidInvoice(user, 480)), 200)
  assert.equal(await freeBalance(owner), 0)
  assert.equal((await db.queryOne<any>("SELECT status FROM referrals WHERE referred_user_id = $1", [user])).status, "rejected")
  assert.deepEqual(await rejections(user), ["ip_overlap"])
})

await test("紹介した人が受け取れるのは月 20 人分まで。超えた人にも登録の 300 は付く", async () => {
  const owner = "6400"
  const code = await codeOf(owner)
  const users: string[] = []
  for (let i = 0; i < 21; i++) {
    const user = await newUser()
    users.push(user)
    assert.equal((await attach(user, code, { ip: `198.51.104.${i + 1}` })).attached, true)
    await generate(user)
  }
  assert.equal(await freeBalance(users[20]), 300)
  await runCron()
  assert.equal(await freeBalance(owner), 20 * 300)
  assert.equal(await webhook("invoice.payment_succeeded", paidInvoice(users[20], 480)), 200)
  assert.equal(await freeBalance(owner), 20 * 300)
  assert.deepEqual(await rejections(users[20]), ["monthly_limit"])
  const summary = (await call("POST", "/internal/referrals/summary", { userId: owner })).body.data
  assert.equal(summary.monthlyUsed, 20)
  assert.equal(summary.invitedCount, 21)
  // 先月の分は数えない（月が変わればまた 20 人分）
  await db.execute("UPDATE referrals SET created_at = $2 WHERE referrer_user_id = $1", [owner, jstMonthStart(now) - 10])
  const next = await newUser()
  await attach(next, code, { ip: "198.51.104.99" })
  assert.equal(Number((await db.queryOne<any>("SELECT referrer_capped FROM referrals WHERE referred_user_id = $1", [next])).referrer_capped), 0)
})

await coreMf.dispose()
process.exit(failed > 0 ? 1 : 0)
