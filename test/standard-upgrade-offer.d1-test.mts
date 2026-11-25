// ライト → スタンダードの初月割引（lib/standard-upgrade-offer.ts。Stripe はモック）
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
  STANDARD_UPGRADE_COUPON_ID: "UP980",
  STANDARD_UPGRADE_DISCOUNT_JPY: "1000",
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
  if (url.endsWith("/v1/account")) return Response.json({ capabilities: { paypay_payments: "pending" } })
  if (url.includes("/checkout/sessions")) return Response.json({ url: "https://checkout.stripe.test/s" })
  if (url.includes("/invoices/create_preview")) return Response.json({ amount_due: 830, lines: { data: [] } })
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


await test("対象: ライトの月払いで、上のプランに入ったことがない人", async () => {
  const userId = await insertSubscription("LITE")
  const res = await call("GET", `/internal/subscriptions/upgrade-offer/${userId}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.data.eligible, true)
  assert.equal(res.body.data.firstMonthYen, 980)
  assert.equal(res.body.data.regularYen, 1980)
})

await test("対象外: スタンダード・無料・以前スタンダードだった人", async () => {
  const standard = await insertSubscription("STANDARD")
  assert.equal((await call("GET", `/internal/subscriptions/upgrade-offer/${standard}`)).body.data.reason, "not_lite")
  assert.equal((await call("GET", "/internal/subscriptions/upgrade-offer/777777")).body.data.reason, "no_subscription")
  const lite = await insertSubscription("LITE")
  await db.execute(
    `INSERT INTO subscriptions(nanoid, user_id, type, status, is_disabled, created_at, current_period_start, current_period_end, stripe_subscription_id)
     VALUES ($1, $2, 'STANDARD', 'canceled', 1, $3, $3, $3, 'sub_old')`,
    [`old-${lite}`, lite, now - 86400 * 100],
  )
  assert.equal((await call("GET", `/internal/subscriptions/upgrade-offer/${lite}`)).body.data.reason, "had_higher_plan")
})

await test("プレビュー: 請求日を置き直し・クーポン付き・請求額は請求書の合計", async () => {
  const userId = await insertSubscription("LITE")
  stripeSubscription = monthly()
  const preview = await call("POST", "/internal/subscriptions/change-plan-preview", { userId, passType: "STANDARD" })
  assert.equal(preview.status, 200)
  const body = calls.find((c) => c.url.includes("create_preview"))!.body
  assert.equal(body.get("subscription_details[billing_cycle_anchor]"), "now")
  assert.equal(body.get("discounts[0][coupon]"), "UP980")
  assert.equal(preview.body.data.chargedNowAmountJpy, 830)
  assert.equal(preview.body.data.upgradeOffer.firstMonthYen, 980)
})

await test("プラン変更: 割引を当てて 1 回使ったら次は対象外", async () => {
  const userId = await insertSubscription("LITE")
  stripeSubscription = monthly()
  const changed = await call("POST", "/internal/subscriptions/change-plan", { userId, passType: "STANDARD" })
  assert.equal(changed.status, 200, JSON.stringify(changed.body))
  assert.equal(changed.body.data.upgradeOffer, "lite_to_standard_first_month")
  const update = calls.find((c) => c.method === "POST" && c.url.includes("/subscriptions/"))!.body
  assert.equal(update.get("billing_cycle_anchor"), "now")
  assert.equal(update.get("discounts[0][coupon]"), "UP980")
  assert.equal(update.get("items[0][price_data][unit_amount]"), "1980")
  // ライトに戻してもう一度上げても、割引はつかない
  await db.execute("UPDATE subscriptions SET type = 'LITE' WHERE user_id = $1", [userId])
  assert.equal((await call("GET", `/internal/subscriptions/upgrade-offer/${userId}`)).body.data.reason, "used")
  calls.length = 0
  await call("POST", "/internal/subscriptions/change-plan", { userId, passType: "STANDARD" })
  const again = calls.find((c) => c.method === "POST" && c.url.includes("/subscriptions/"))!.body
  assert.equal(again.get("discounts[0][coupon]"), null)
  assert.equal(again.get("billing_cycle_anchor"), null)
})

await test("プレミアムへの変更・お試し中は請求日を置き直さない", async () => {
  const userId = await insertSubscription("LITE")
  stripeSubscription = monthly()
  await call("POST", "/internal/subscriptions/change-plan", { userId, passType: "PREMIUM" })
  const premium = calls.find((c) => c.method === "POST" && c.url.includes("/subscriptions/"))!.body
  assert.equal(premium.get("discounts[0][coupon]"), null)
  const trialUser = await insertSubscription("LITE", "trialing")
  stripeSubscription = { ...monthly(), status: "trialing" }
  calls.length = 0
  await call("POST", "/internal/subscriptions/change-plan", { userId: trialUser, passType: "STANDARD" })
  const trial = calls.find((c) => c.method === "POST" && c.url.includes("/subscriptions/"))!.body
  assert.equal(trial.get("trial_end"), "now")
  assert.equal(trial.get("billing_cycle_anchor"), null)
  assert.equal(trial.get("discounts[0][coupon]"), "UP980")
})

await test("年払いのライトは対象外（クーポンは付けない）", async () => {
  const userId = await insertSubscription("LITE")
  stripeSubscription = yearly()
  await call("POST", "/internal/subscriptions/change-plan", { userId, passType: "STANDARD" })
  const update = calls.find((c) => c.method === "POST" && c.url.includes("/subscriptions/"))!.body
  assert.equal(update.get("discounts[0][coupon]"), null)
})

process.exit(failed > 0 ? 1 : 0)
