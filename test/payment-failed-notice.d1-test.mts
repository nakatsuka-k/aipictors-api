// 更新の支払いに失敗した人へのお知らせ（Stripe と Resend はモック）
import assert from "node:assert/strict"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { buildPaymentFailedEmail, sendPaymentFailedNotices } = await import(`${API}/lib/payment-failed-notice.ts`)

import { createTestD1 } from "./d1.mts"
const d1 = await createTestD1()
const db = d1.db
const env = { DB: d1.DB, STRIPE_SECRET_KEY: "sk_test_dummy", RESEND_API_KEY: "re_dummy" }

const now = Math.floor(Date.now() / 1000)
const insert = async (id: number, userId: string, type: string, subId: string) => {
  await db.execute(
    `INSERT INTO subscriptions(id, nanoid, user_id, type, status, is_disabled, created_at, current_period_start, current_period_end, stripe_subscription_id)
     VALUES ($1, $2, $3, $4, 'paid', FALSE, $5, $5, $6, $7)`,
    [id, `n${id}`, userId, type, now - 86400 * 40, now - 86400 * 10, subId]
  )
}
await insert(1, "u1", "LITE", "sub_open")
await insert(2, "u2", "STANDARD", "sub_paused")
await insert(3, "u3", "STANDARD", "sub_noinvoice")

const invoice = (id: string) => ({ id, status: "open", amount_due: 1980, hosted_invoice_url: `https://invoice.stripe.test/${id}`, next_payment_attempt: now + 86400 })
const mails: { to: string[]; subject: string; html: string }[] = []
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.startsWith("https://api.resend.com/emails")) {
    mails.push(JSON.parse(String(init?.body)))
    return Response.json({ id: `mail_${mails.length}` })
  }
  assert.ok(url.startsWith("https://api.stripe.com/v1/"), `予期しない fetch: ${url}`)
  if (url.includes("/subscriptions?status=past_due")) {
    return Response.json({
      data: [
        { id: "sub_open", customer: "cus_1", metadata: { locale: "ja" }, latest_invoice: { ...invoice("in_1"), amount_due: 480 } },
        { id: "sub_paused", customer: "cus_2", metadata: {}, pause_collection: { behavior: "void" }, latest_invoice: invoice("in_2") },
        { id: "sub_noinvoice", customer: "cus_3", metadata: {}, latest_invoice: { ...invoice("in_3"), status: "paid" } },
        { id: "sub_unknown", customer: "cus_4", metadata: {}, latest_invoice: invoice("in_4") },
      ],
    })
  }
  if (url.includes("/customers/")) return Response.json({ email: "user@example.com" })
  return Response.json({})
}) as typeof fetch

// 1 回目: 請求書が未払いで、休止中でなく、こちらに契約の行がある人だけに送る
const first = await sendPaymentFailedNotices(env, db)
assert.equal(first.sent, 1)
assert.equal(mails.length, 1)
assert.deepEqual(mails[0].to, ["user@example.com"])
assert.ok(mails[0].subject.includes("お支払いが完了していません"))
assert.ok(mails[0].html.includes("https://invoice.stripe.test/in_1"))
assert.ok(mails[0].html.includes("¥480"))
assert.ok(mails[0].html.includes("ライト"))
assert.ok(!mails[0].html.includes("Thank you"), "言語が分かっているときはその言語だけ")

// 2 回目: 同じ請求書には送らない
const second = await sendPaymentFailedNotices(env, db)
assert.equal(second.sent, 0)
assert.equal(mails.length, 1)

// 言語が分からないときは日英の両方、URL はエスケープする
const both = buildPaymentFailedEmail({ passType: "STANDARD", amount: 1980, invoiceUrl: "https://x.test/?a=1&b=2", nextAttempt: null, locale: null })
assert.ok(both.html.includes("スタンダード") && both.html.includes("Standard"))
assert.ok(both.html.includes("https://x.test/?a=1&amp;b=2"))

// 設定がないときは何もしない
assert.equal((await sendPaymentFailedNotices({ DB: d1.DB }, db)).sent, 0)

console.log("payment-failed-notice.d1-test ok")
process.exit(0)
