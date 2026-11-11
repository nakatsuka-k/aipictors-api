// 年払いの決済・年払いのプラン変更・1 か月休止・コイン購入の上乗せ判定（Stripe はモック）
import assert from "node:assert/strict"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { app } = await import(`${API}/app.ts`)

import { createTestD1 } from "./d1.mts"
const d1 = await createTestD1()
const db = d1.db
const env = {
  DB: d1.DB,
  GENLOG: d1.GENLOG,
  INTERNAL_API_TOKEN: "internal",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  FIRST_MONTH_COUPON_ID: "HALF",
}

type Call = { method: string; url: string; body: URLSearchParams }
const calls: Call[] = []
let stripeSubscription: Record<string, unknown> = {}
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  assert.ok(url.startsWith("https://api.stripe.com/v1/"), `予期しない fetch: ${url}`)
  const method = init?.method ?? "GET"
  const body = new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "")
  calls.push({ method, url, body })
  if (url.includes("/checkout/sessions")) return Response.json({ url: "https://checkout.stripe.test/s" })
  if (url.includes("/invoices/create_preview")) return Response.json({ amount_due: 1000, lines: { data: [] } })
  if (method === "DELETE") return Response.json({ id: "x", status: "canceled" })
  if (url.includes("/subscriptions/")) {
    if (method === "POST") {
      return Response.json({ ...stripeSubscription, status: "active", latest_invoice: { status: "paid", amount_paid: 0 } })
    }
    return Response.json(stripeSubscription)
  }
  return Response.json({})
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

const now = Math.floor(Date.now() / 1000)
let nextUserId = 5000
const insertSubscription = async (type = "STANDARD", status = "paid") => {
  const userId = String(nextUserId++)
  await db.execute(
    `INSERT INTO subscriptions(nanoid, user_id, type, status, is_disabled, created_at, current_period_start, current_period_end, stripe_subscription_id)
     VALUES ($1, $2, $3, $4, 0, $5, $5, $6, $7)`,
    [`sub-${userId}`, userId, type, status, now, now + 86400 * 10, `sub_${userId}`],
  )
  return userId
}
const monthly = (periodEnd = now + 86400 * 10) => ({
  id: "sub_x",
  status: "active",
  current_period_end: periodEnd,
  items: { data: [{ id: "si_1", price: { recurring: { interval: "month" } } }] },
})
const yearly = () => ({
  id: "sub_y",
  status: "active",
  items: { data: [{ id: "si_1", current_period_end: now + 86400 * 300, price: { recurring: { interval: "year" } } }] },
})

let failed = 0
const test = async (name: string, run: () => Promise<void>) => {
  calls.length = 0
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}`)
    console.log(error)
  }
}

await test("年払いの決済: interval=year・年額・初月半額クーポンなし", async () => {
  const res = await call("POST", "/stripe/checkout/subscription", { userId: "9001", passType: "STANDARD", origin: "https://www.test", interval: "year" })
  assert.equal(res.status, 200)
  assert.equal(calls.length, 1)
  const body = calls[0].body
  assert.equal(body.get("line_items[0][price_data][recurring][interval]"), "year")
  assert.equal(body.get("line_items[0][price_data][unit_amount]"), "19800")
  assert.equal(body.get("discounts[0][coupon]"), null)
  assert.equal(body.get("subscription_data[metadata][interval]"), "year")
})

await test("月払いの決済は今までどおり（月額・クーポンあり）", async () => {
  const res = await call("POST", "/stripe/checkout/subscription", { userId: "9002", passType: "LITE", origin: "https://www.test" })
  assert.equal(res.status, 200)
  const body = calls[0].body
  assert.equal(body.get("line_items[0][price_data][recurring][interval]"), "month")
  assert.equal(body.get("line_items[0][price_data][unit_amount]"), "480")
  assert.equal(body.get("discounts[0][coupon]"), "HALF")
})

await test("年払いのプラン変更は年払いのまま・年額で", async () => {
  const userId = await insertSubscription("LITE")
  stripeSubscription = yearly()
  const preview = await call("POST", "/internal/subscriptions/change-plan-preview", { userId, passType: "PREMIUM" })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.data.interval, "year")
  assert.equal(preview.body.data.renewalAmountJpy, 39800)
  const previewCall = calls.find((c) => c.url.includes("create_preview"))!
  assert.equal(previewCall.body.get("subscription_details[items][0][price_data][recurring][interval]"), "year")
  calls.length = 0
  const changed = await call("POST", "/internal/subscriptions/change-plan", { userId, passType: "PREMIUM" })
  assert.equal(changed.status, 200)
  const update = calls.find((c) => c.method === "POST" && c.url.includes("/subscriptions/"))!
  assert.equal(update.body.get("items[0][price_data][recurring][interval]"), "year")
  assert.equal(update.body.get("items[0][price_data][unit_amount]"), "39800")
})

await test("月払いのプラン変更は月額のまま", async () => {
  const userId = await insertSubscription("LITE")
  stripeSubscription = monthly()
  const preview = await call("POST", "/internal/subscriptions/change-plan-preview", { userId, passType: "STANDARD" })
  assert.equal(preview.body.data.interval, "month")
  assert.equal(preview.body.data.renewalAmountJpy, 1980)
})

await test("休止: 期間の終わりの請求を取り消す設定にして記録・二重に押しても 1 回", async () => {
  const userId = await insertSubscription("STANDARD")
  const periodEnd = now + 86400 * 10
  stripeSubscription = monthly(periodEnd)
  const res = await call("POST", "/internal/subscriptions/pause-current", { userId, reason: "not_using" })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.data.pausedFrom, periodEnd)
  assert.equal(res.body.data.resumesAt, periodEnd + 14 * 86400)
  assert.ok(res.body.data.nextBillingAt > periodEnd + 27 * 86400)
  const update = calls.find((c) => c.method === "POST")!
  assert.equal(update.body.get("pause_collection[behavior]"), "void")
  assert.equal(update.body.get("pause_collection[resumes_at]"), String(periodEnd + 14 * 86400))
  const reason = await db.queryOne("SELECT reason, note FROM subscription_cancel_reasons WHERE user_id = $1", [userId])
  assert.equal(reason.reason, "not_using")
  assert.equal(reason.note, "pause")
  calls.length = 0
  const again = await call("POST", "/internal/subscriptions/pause-current", { userId })
  assert.equal(again.status, 200)
  assert.equal(calls.filter((c) => c.method === "POST").length, 0)
  const got = await call("GET", `/internal/subscriptions/pause/${userId}`)
  assert.equal(got.body.data.pausedFrom, periodEnd)
})

await test("休止の取り消し: pause_collection を外して記録を閉じる", async () => {
  const userId = await insertSubscription("STANDARD")
  stripeSubscription = monthly()
  await call("POST", "/internal/subscriptions/pause-current", { userId })
  calls.length = 0
  const res = await call("POST", "/internal/subscriptions/unpause-current", { userId })
  assert.equal(res.status, 200)
  assert.equal(calls[0].body.get("pause_collection"), "")
  const got = await call("GET", `/internal/subscriptions/pause/${userId}`)
  assert.equal(got.body.data, null)
})

await test("休止できない: 年払い・解約予約中", async () => {
  const userId = await insertSubscription("STANDARD")
  stripeSubscription = yearly()
  const res = await call("POST", "/internal/subscriptions/pause-current", { userId })
  assert.equal(res.status, 409)
  const cancelling = await insertSubscription("STANDARD", "cancellation_requested")
  stripeSubscription = monthly()
  const res2 = await call("POST", "/internal/subscriptions/pause-current", { userId: cancelling })
  assert.equal(res2.status, 409)
})

await test("休止中に入り直したら古い契約をすぐ解約する", async () => {
  const { cancelPausedSubscriptionsOnNewSubscription } = await import(`${API}/lib/subscription-pause.ts`)
  const userId = await insertSubscription("STANDARD")
  stripeSubscription = monthly()
  await call("POST", "/internal/subscriptions/pause-current", { userId })
  calls.length = 0
  await cancelPausedSubscriptionsOnNewSubscription("sk", db, userId, "sub_new")
  const del = calls.find((c) => c.method === "DELETE")!
  assert.ok(del.url.endsWith(`/subscriptions/sub_${userId}`))
  const row = await db.queryOne("SELECT status, is_disabled FROM subscriptions WHERE user_id = $1", [userId])
  assert.equal(row.status, "canceled")
  const got = await call("GET", `/internal/subscriptions/pause/${userId}`)
  assert.equal(got.body.data, null)
})

await test("コイン購入の判定: はじめて・プラン", async () => {
  const userId = await insertSubscription("PREMIUM")
  const first = await call("GET", `/stripe/checkout/premium-coins/offer/${userId}`)
  assert.deepEqual(first.body.data, { isFirstPurchase: true, passType: "PREMIUM" })
  await db.execute(
    `INSERT INTO premium_coin_purchases(id, user_id, coins, bonus_coins, total_coins, price_yen, expires_at, created_at, updated_at)
     VALUES ('p1', $1, 100, 0, 100, 80, $2, $2, $2)`,
    [userId, now],
  )
  const second = await call("GET", `/stripe/checkout/premium-coins/offer/${userId}`)
  assert.equal(second.body.data.isFirstPurchase, false)
  const free = await call("GET", "/stripe/checkout/premium-coins/offer/77777")
  assert.deepEqual(free.body.data, { isFirstPurchase: true, passType: null })
})

await test("パス: 決済画面は 1 回払い・月額/年額・metadata kind=prepaid_pass", async () => {
  const res = await call("POST", "/stripe/checkout/prepaid-pass", { userId: "9100", passType: "STANDARD", interval: "year", origin: "https://www.test" })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const body = calls[0].body
  assert.equal(body.get("mode"), "payment")
  assert.equal(body.get("line_items[0][price_data][unit_amount]"), "19800")
  assert.equal(body.get("metadata[kind]"), "prepaid_pass")
  assert.equal(body.get("metadata[interval]"), "year")
  assert.equal(body.get("line_items[0][price_data][recurring][interval]"), null)
})

await test("パス: 自動更新の契約に入っている人は買えない", async () => {
  const userId = await insertSubscription("LITE")
  const res = await call("POST", "/stripe/checkout/prepaid-pass", { userId, passType: "LITE", interval: "month", origin: "https://www.test" })
  assert.equal(res.status, 409)
  assert.equal(calls.length, 0)
})

await test("パス: 反映で契約ができ、同じ決済は 1 回だけ、2 回目の購入は期間が延びる", async () => {
  const { applyPrepaidPassFromSession } = await import(`${API}/lib/prepaid-pass.ts`)
  const userId = "9200"
  const session = (id: string, interval = "month") => ({
    id,
    payment_status: "paid",
    amount_total: 1980,
    payment_intent: `pi_${id}`,
    metadata: { kind: "prepaid_pass", user_id: userId, pass_type: "STANDARD", interval, price_yen: "1980" },
  })
  const first = await applyPrepaidPassFromSession(db, session("cs_a"))
  assert.equal(first.data.created, true)
  const row = await db.queryOne("SELECT * FROM subscriptions WHERE user_id = $1", [userId])
  assert.equal(row.stripe_subscription_id, "prepaid:cs_a")
  assert.equal(row.type, "STANDARD")
  const end1 = Number(row.current_period_end)
  assert.ok(end1 - now > 27 * 86400 && end1 - now < 32 * 86400)
  const again = await applyPrepaidPassFromSession(db, session("cs_a"))
  assert.equal(again.data.created, false)
  const second = await applyPrepaidPassFromSession(db, session("cs_b"))
  assert.equal(second.data.created, true)
  const rows = await db.query("SELECT * FROM subscriptions WHERE user_id = $1", [userId])
  assert.equal(rows.length, 1)
  assert.ok(Number(rows[0].current_period_end) - end1 > 27 * 86400)
  // 現在の契約として返り、Stripe には問い合わせない
  calls.length = 0
  const current = await call("GET", `/internal/subscriptions/current/${userId}`)
  assert.equal(current.body.data.type, "STANDARD")
  assert.equal(calls.length, 0)
  const status = await call("GET", `/stripe/checkout/prepaid-pass/status/${userId}`)
  assert.equal(status.body.data.passType, "STANDARD")
  // 別のプランのパスは期限まで買えない、同じプランは買える
  const other = await call("POST", "/stripe/checkout/prepaid-pass", { userId, passType: "PREMIUM", interval: "month", origin: "https://www.test" })
  assert.equal(other.status, 409)
  const same = await call("POST", "/stripe/checkout/prepaid-pass", { userId, passType: "STANDARD", interval: "month", origin: "https://www.test" })
  assert.equal(same.status, 200)
  // 解約・プラン変更・休止はできない
  assert.equal((await call("POST", "/internal/subscriptions/cancel-current", { userId })).status, 409)
  assert.equal((await call("POST", "/internal/subscriptions/change-plan", { userId, passType: "PREMIUM" })).status, 409)
  assert.equal((await call("POST", "/internal/subscriptions/pause-current", { userId })).status, 409)
})

await test("パス: 未払いの決済は反映しない", async () => {
  const { applyPrepaidPassFromSession } = await import(`${API}/lib/prepaid-pass.ts`)
  const res = await applyPrepaidPassFromSession(db, {
    id: "cs_unpaid",
    payment_status: "unpaid",
    metadata: { kind: "prepaid_pass", user_id: "9300", pass_type: "LITE", interval: "month" },
  })
  assert.equal(res.data.reflected, false)
  const row = await db.queryOne("SELECT * FROM subscriptions WHERE user_id = '9300'")
  assert.equal(row, null)
})

process.exit(failed > 0 ? 1 : 0)
