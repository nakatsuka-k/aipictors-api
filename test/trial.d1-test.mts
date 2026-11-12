// ライトの 7 日間無料お試し: 対象の判定・決済画面の内容・カードの fingerprint の重複・お試し中の扱い・終了前のメール（Stripe と Resend はモック）
import assert from "node:assert/strict"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { app } = await import(`${API}/app.ts`)
const { signPayload } = await import(`${API}/lib/stripe.ts`)
const { resolveCoinPlanType } = await import(`${API}/lib/daily-coins.ts`)

import { createTestD1 } from "./d1.mts"
const d1 = await createTestD1()
const db = d1.db
const env: Record<string, unknown> = {
  DB: d1.DB,
  GENLOG: d1.GENLOG,
  INTERNAL_API_TOKEN: "internal",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  FIRST_MONTH_COUPON_ID: "HALF",
  LITE_TRIAL_DAYS: "7",
  RESEND_API_KEY: "re_test",
}

type Call = { method: string; url: string; body: URLSearchParams; json: any }
const calls: Call[] = []
// Stripe の契約（id ごと）。fingerprint はここで決める
const stripeSubscriptions = new Map<string, Record<string, unknown>>()
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  const method = init?.method ?? "GET"
  const raw = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : ""
  if (url === "https://api.resend.com/emails") {
    calls.push({ method, url, body: new URLSearchParams(), json: JSON.parse(raw) })
    return Response.json({ id: "email_1" })
  }
  assert.ok(url.startsWith("https://api.stripe.com/v1/"), `予期しない fetch: ${url}`)
  calls.push({ method, url, body: new URLSearchParams(raw), json: null })
  if (url.includes("/checkout/sessions")) return Response.json({ url: "https://checkout.stripe.test/s" })
  if (url.includes("/customers/")) return Response.json({ id: "cus_1", email: "trial@example.com" })
  const match = url.match(/\/subscriptions\/(sub_[A-Za-z0-9_]+)/)
  if (match) {
    const sub = stripeSubscriptions.get(match[1])
    if (!sub) return Response.json({ error: { message: "No such subscription", code: "resource_missing" } })
    if (method === "DELETE") {
      sub.status = "canceled"
      return Response.json(sub)
    }
    if (method === "POST") return Response.json({ ...sub, latest_invoice: { status: "paid", amount_paid: 980 } })
    return Response.json(sub)
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
  return { status: res.status, body: (await res.json()) as { error: string | null; data: any; code?: string; reason?: string } }
}

let nextEventId = 1
const webhook = async (type: string, object: Record<string, unknown>) => {
  const payload = JSON.stringify({ id: `evt_${nextEventId++}`, type, data: { object } })
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = await signPayload("whsec_test", `${timestamp}.${payload}`)
  const res = await app.fetch(
    new Request("http://api.test/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      body: payload,
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  )
  return { status: res.status, body: (await res.json()) as { error: string | null; data: any } }
}

const now = Math.floor(Date.now() / 1000)
const DAY = 86400

// お試しの契約を Stripe 側に用意して、¥0 の請求の成功を届ける
const startTrialFor = async (userId: string, subscriptionId: string, fingerprint: string | null) => {
  stripeSubscriptions.set(subscriptionId, {
    id: subscriptionId,
    status: "trialing",
    customer: "cus_1",
    cancel_at_period_end: false,
    trial_start: now,
    trial_end: now + 7 * DAY,
    default_payment_method: fingerprint ? { id: "pm_1", card: { fingerprint } } : null,
    items: { data: [{ id: "si_1", price: { recurring: { interval: "month" } } }] },
  })
  return webhook("invoice.payment_succeeded", {
    id: `in_trial_${subscriptionId}`,
    status: "paid",
    subscription: subscriptionId,
    billing_reason: "subscription_create",
    amount_paid: 0,
    created: now,
    subscription_details: { metadata: { kind: "subscription", user_id: userId, pass_type: "LITE", subscription_nanoid: `nano-${subscriptionId}`, interval: "month", trial: "1" } },
    lines: { data: [{ period: { start: now, end: now + 7 * DAY } }] },
  })
}
const paidInvoice = (userId: string, subscriptionId: string, billingReason: string, invoiceId: string, extra: Record<string, unknown> = {}) => ({
  id: invoiceId,
  status: "paid",
  subscription: subscriptionId,
  billing_reason: billingReason,
  amount_paid: 480,
  created: now + 7 * DAY,
  subscription_details: { metadata: { kind: "subscription", user_id: userId, pass_type: "LITE", subscription_nanoid: `nano-${subscriptionId}`, interval: "month", trial: "1" } },
  lines: { data: [{ period: { start: now + 7 * DAY, end: now + 37 * DAY } }] },
  ...extra,
})
const premiumBalance = async (userId: string) =>
  Number((await db.queryOne<{ premium_balance: number }>("SELECT premium_balance FROM coin_balances WHERE user_id = $1", [userId]))?.premium_balance ?? 0)

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

await test("対象: 一度もプランに入ったことがない人だけ", async () => {
  const fresh = await call("GET", "/stripe/checkout/trial/100")
  assert.deepEqual(
    { eligible: fresh.body.data.eligible, reason: fresh.body.data.reason, trialDays: fresh.body.data.trialDays, passType: fresh.body.data.passType, price: fresh.body.data.priceYenAfterTrial, latest: fresh.body.data.latestTrial },
    { eligible: true, reason: null, trialDays: 7, passType: "LITE", price: 480, latest: null },
  )
  // 解約済み（過去に入っていた）・アプリのストアの契約・自動更新なしのパスも対象外
  await db.execute(
    `INSERT INTO subscriptions(nanoid, user_id, type, status, is_disabled, created_at, current_period_start, current_period_end, stripe_subscription_id)
     VALUES ('old-101', '101', 'STANDARD', 'canceled', 1, $1, $1, $2, 'sub_old101'),
            ('store-102', '102', 'LITE', 'paid', 0, $1, $1, $3, 'GPA.1234-5678'),
            ('prepaid-103', '103', 'LITE', 'paid', 0, $1, $1, $2, 'prepaid:cs_103')`,
    [now - 100 * DAY, now - 70 * DAY, now + 10 * DAY],
  )
  for (const userId of ["101", "102", "103"]) {
    const res = await call("GET", `/stripe/checkout/trial/${userId}`)
    assert.equal(res.body.data.eligible, false, userId)
    assert.equal(res.body.data.reason, "has_subscription_history", userId)
  }
})

await test("お試しの決済画面: 7 日間無料・その後 ¥480/月・クーポンなし・支払い方法なしで終わったら解約", async () => {
  const res = await call("POST", "/stripe/checkout/subscription", { userId: "110", passType: "LITE", origin: "https://www.test", trial: true })
  assert.equal(res.status, 200)
  assert.equal(calls.length, 1)
  const body = calls[0].body
  assert.equal(body.get("subscription_data[trial_period_days]"), "7")
  assert.equal(body.get("subscription_data[trial_settings][end_behavior][missing_payment_method]"), "cancel")
  assert.equal(body.get("payment_method_collection"), "always")
  assert.equal(body.get("line_items[0][price_data][unit_amount]"), "480")
  assert.equal(body.get("line_items[0][price_data][recurring][interval]"), "month")
  assert.equal(body.get("discounts[0][coupon]"), null)
  assert.equal(body.get("subscription_data[metadata][trial]"), "1")
  assert.equal(body.get("success_url"), "https://www.test/plus/success?trial=1")
  const message = body.get("custom_text[submit][message]") ?? ""
  assert.match(message, /7日間は無料/)
  assert.match(message, /月額¥480が自動で課金/)
  assert.match(message, /いつでも解約/)
  assert.match(message, /charged ¥480\/month automatically/)
  assert.match(message, /cancel anytime/)
  assert.ok(message.length <= 1200)
})

await test("お試しはライトの月払いだけ。対象外の人は 409（決済画面を作らない）", async () => {
  const standard = await call("POST", "/stripe/checkout/subscription", { userId: "111", passType: "STANDARD", origin: "https://www.test", trial: true })
  assert.equal(standard.status, 400)
  assert.equal(standard.body.code, "trial_invalid_plan")
  const yearly = await call("POST", "/stripe/checkout/subscription", { userId: "111", passType: "LITE", origin: "https://www.test", interval: "year", trial: true })
  assert.equal(yearly.status, 400)
  const used = await call("POST", "/stripe/checkout/subscription", { userId: "101", passType: "LITE", origin: "https://www.test", trial: true })
  assert.equal(used.status, 409)
  assert.equal(used.body.code, "trial_not_eligible")
  assert.equal(used.body.reason, "has_subscription_history")
  assert.equal(calls.length, 0)
})

await test("お試しを付けないライト月払いは今までどおり初月半額（対象の人でも）", async () => {
  const res = await call("POST", "/stripe/checkout/subscription", { userId: "112", passType: "LITE", origin: "https://www.test" })
  assert.equal(res.status, 200)
  const body = calls[0].body
  assert.equal(body.get("discounts[0][coupon]"), "HALF")
  assert.equal(body.get("subscription_data[trial_period_days]"), null)
  assert.equal(body.get("success_url"), "https://www.test/plus/success")
})

await test("LITE_TRIAL_DAYS が空ならお試しは止まる", async () => {
  env.LITE_TRIAL_DAYS = ""
  const offer = await call("GET", "/stripe/checkout/trial/113")
  assert.equal(offer.body.data.eligible, false)
  assert.equal(offer.body.data.reason, "disabled")
  const res = await call("POST", "/stripe/checkout/subscription", { userId: "113", passType: "LITE", origin: "https://www.test", trial: true })
  assert.equal(res.status, 409)
  env.LITE_TRIAL_DAYS = "7"
})

await test("お試しの開始: ライト会員として扱う（trialing・期間は 7 日）・fingerprint を記録・コインは付けない", async () => {
  const res = await startTrialFor("200", "sub_trial200", "fp_AAA")
  assert.equal(res.status, 200)
  const row = await db.queryOne<any>("SELECT * FROM subscriptions WHERE user_id = '200'")
  assert.equal(row.type, "LITE")
  assert.equal(row.status, "trialing")
  assert.equal(Number(row.is_disabled), 0)
  assert.equal(Number(row.current_period_end), now + 7 * DAY)
  assert.equal(Number(row.trial_end), now + 7 * DAY)
  const trial = await db.queryOne<any>("SELECT * FROM subscription_trials WHERE user_id = '200'")
  assert.equal(trial.status, "trialing")
  assert.equal(trial.card_fingerprint, "fp_AAA")
  // 今の契約として返る・毎日のコインのプランはライト
  const current = await call("GET", "/internal/subscriptions/current/200")
  assert.equal(current.body.data.type, "LITE")
  assert.equal(await resolveCoinPlanType(db, "200", "FREE", now), "LITE")
  // ¥0 の請求では継続ボーナスなどのコインは付かない
  const ledger = await db.query("SELECT id FROM coin_ledger WHERE user_id = '200'")
  assert.equal(ledger.length, 0)
  // もう対象外（使用済み）
  const offer = await call("GET", "/stripe/checkout/trial/200")
  assert.equal(offer.body.data.eligible, false)
  assert.equal(offer.body.data.reason, "trial_used")
  assert.equal(offer.body.data.latestTrial.status, "trialing")
})

await test("別の人が同じカード（fingerprint）でお試しを始めたら、すぐ解約して会員にしない", async () => {
  const res = await startTrialFor("201", "sub_trial201", "fp_AAA")
  assert.equal(res.status, 200)
  const cancel = calls.find((c) => c.method === "DELETE")
  assert.ok(cancel?.url.includes("/subscriptions/sub_trial201"))
  // 請求書を作る指定はしていない（請求は発生しない）
  assert.equal(cancel?.body.get("invoice_now"), null)
  assert.equal(await db.queryOne("SELECT id FROM subscriptions WHERE user_id = '201'"), null)
  const trial = await db.queryOne<any>("SELECT * FROM subscription_trials WHERE user_id = '201'")
  assert.equal(trial.status, "rejected_duplicate_card")
  // 画面には理由が返る。別のカードでやり直せるので対象のまま
  const offer = await call("GET", "/stripe/checkout/trial/201")
  assert.equal(offer.body.data.latestTrial.status, "rejected_duplicate_card")
  assert.equal(offer.body.data.eligible, true)
  // Stripe からの解約の通知が来ても変わらない
  await webhook("customer.subscription.deleted", { id: "sub_trial201" })
  assert.equal((await db.queryOne<any>("SELECT status FROM subscription_trials WHERE user_id = '201'")).status, "rejected_duplicate_card")
  // 別のカードなら始められる
  await startTrialFor("201", "sub_trial201b", "fp_BBB")
  assert.equal((await db.queryOne<any>("SELECT status FROM subscriptions WHERE user_id = '201'")).status, "trialing")
})

await test("同じ人が決済画面を 2 つ開いて両方で始めたら、2 つ目はすぐ解約", async () => {
  await startTrialFor("200", "sub_trial200b", "fp_CCC")
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.includes("/subscriptions/sub_trial200b")))
  assert.equal((await db.queryOne<any>("SELECT status FROM subscription_trials WHERE stripe_subscription_id = 'sub_trial200b'")).status, "rejected_repeat")
  // 1 つ目のお試しはそのまま
  assert.equal((await db.queryOne<any>("SELECT status FROM subscriptions WHERE user_id = '200'")).status, "trialing")
  // 断られたカードは記録として使わない（fp_CCC の持ち主は別のアカウントで始められる）
  await startTrialFor("202", "sub_trial202", "fp_CCC")
  assert.equal((await db.queryOne<any>("SELECT status FROM subscription_trials WHERE user_id = '202'")).status, "trialing")
})

await test("fingerprint が取れない支払い方法（カード以外）は通す", async () => {
  await startTrialFor("203", "sub_trial203", null)
  await startTrialFor("204", "sub_trial204", null)
  assert.equal((await db.queryOne<any>("SELECT status FROM subscription_trials WHERE user_id = '204'")).status, "trialing")
})

await test("終了 3 日前のメール: 終了日・その後の料金・解約の方法。1 回だけ。解約予約済みには送らない", async () => {
  const sub = stripeSubscriptions.get("sub_trial200")!
  const res = await webhook("customer.subscription.trial_will_end", sub)
  assert.equal(res.status, 200)
  const mail = calls.find((c) => c.url === "https://api.resend.com/emails")!
  assert.deepEqual(mail.json.to, ["trial@example.com"])
  assert.match(mail.json.subject, /無料お試しは .+ に終了します（以後 月額¥480）/)
  assert.match(mail.json.html, /月額 ¥480（税込）/)
  assert.match(mail.json.html, /解約する/)
  assert.match(mail.json.html, /https:\/\/www\.aipictors\.com\/plus/)
  assert.match(mail.json.html, /¥480\/month/)
  assert.ok(Number((await db.queryOne<any>("SELECT reminder_sent_at FROM subscription_trials WHERE stripe_subscription_id = 'sub_trial200'")).reminder_sent_at) > 0)
  calls.length = 0
  await webhook("customer.subscription.trial_will_end", sub)
  assert.equal(calls.filter((c) => c.url === "https://api.resend.com/emails").length, 0)
  // 解約予約済み
  const scheduled = stripeSubscriptions.get("sub_trial202")!
  await webhook("customer.subscription.trial_will_end", { ...scheduled, cancel_at_period_end: true })
  assert.equal(calls.filter((c) => c.url === "https://api.resend.com/emails").length, 0)
})

await test("お試しのあとの最初の支払い: 有料に移行・継続ボーナスは付けない。次の更新からは付く", async () => {
  await webhook("invoice.payment_succeeded", paidInvoice("200", "sub_trial200", "subscription_cycle", "in_first_200"))
  const trial = await db.queryOne<any>("SELECT * FROM subscription_trials WHERE stripe_subscription_id = 'sub_trial200'")
  assert.equal(trial.status, "converted")
  const row = await db.queryOne<any>("SELECT * FROM subscriptions WHERE user_id = '200'")
  assert.equal(row.status, "paid")
  assert.equal(Number(row.current_period_end), now + 37 * DAY)
  assert.equal(await premiumBalance("200"), 0)
  await webhook("invoice.payment_succeeded", paidInvoice("200", "sub_trial200", "subscription_cycle", "in_second_200"))
  assert.equal(await premiumBalance("200"), 100)
})

await test("お試し中に解約して終わったら canceled。もう一度お試しはできない", async () => {
  await webhook("customer.subscription.deleted", { id: "sub_trial202" })
  assert.equal((await db.queryOne<any>("SELECT status FROM subscription_trials WHERE user_id = '202'")).status, "canceled")
  const row = await db.queryOne<any>("SELECT * FROM subscriptions WHERE user_id = '202'")
  assert.equal(Number(row.is_disabled), 1)
  const res = await call("POST", "/stripe/checkout/subscription", { userId: "202", passType: "LITE", origin: "https://www.test", trial: true })
  assert.equal(res.status, 409)
  // 同じカードを別の人が使うのも不可のまま
  await startTrialFor("205", "sub_trial205", "fp_CCC")
  assert.equal((await db.queryOne<any>("SELECT status FROM subscription_trials WHERE user_id = '205'")).status, "rejected_duplicate_card")
})

await test("お試し中のプラン変更は、お試しをその場で終えて請求する。休止はできない", async () => {
  const preview = await call("POST", "/internal/subscriptions/change-plan-preview", { userId: "203", passType: "STANDARD" })
  assert.equal(preview.status, 200)
  assert.equal(calls.find((c) => c.url.includes("create_preview"))?.body.get("subscription_details[trial_end]"), "now")
  calls.length = 0
  const changed = await call("POST", "/internal/subscriptions/change-plan", { userId: "203", passType: "STANDARD" })
  assert.equal(changed.status, 200)
  const update = calls.find((c) => c.method === "POST" && c.url.includes("/subscriptions/sub_trial203"))!
  assert.equal(update.body.get("trial_end"), "now")
  const pause = await call("POST", "/internal/subscriptions/pause-current", { userId: "204" })
  assert.equal(pause.status, 409)
  assert.match(pause.body.error ?? "", /無料お試し中は休止できません/)
})

await test("お試しではない契約は今までどおり（初回は paid・更新で継続ボーナス）", async () => {
  stripeSubscriptions.set("sub_normal300", { id: "sub_normal300", status: "active", customer: "cus_1" })
  const metadata = { kind: "subscription", user_id: "300", pass_type: "STANDARD", subscription_nanoid: "nano-300", interval: "month" }
  await webhook("invoice.payment_succeeded", { ...paidInvoice("300", "sub_normal300", "subscription_create", "in_300a"), amount_paid: 490, subscription_details: { metadata } })
  assert.equal((await db.queryOne<any>("SELECT status FROM subscriptions WHERE user_id = '300'")).status, "paid")
  assert.equal(await db.queryOne("SELECT id FROM subscription_trials WHERE user_id = '300'"), null)
  assert.equal(await premiumBalance("300"), 0)
  await webhook("invoice.payment_succeeded", { ...paidInvoice("300", "sub_normal300", "subscription_cycle", "in_300b"), amount_paid: 980, subscription_details: { metadata } })
  assert.equal(await premiumBalance("300"), 300)
})

process.exit(failed > 0 ? 1 : 0)
