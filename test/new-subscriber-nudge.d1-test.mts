// 入ったばかりで生成していない会員へのお知らせ（Stripe と Resend はモック）
import assert from "node:assert/strict"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { buildNewSubscriberNudgeEmail, sendNewSubscriberNudges } = await import(`${API}/lib/new-subscriber-nudge.ts`)

import { createTestD1 } from "./d1.mts"
const d1 = await createTestD1()
const db = d1.db
const env = { DB: d1.DB, STRIPE_SECRET_KEY: "sk_test_dummy", RESEND_API_KEY: "re_dummy", INTERNAL_API_TOKEN: "internal" }

const now = Math.floor(Date.now() / 1000)
const DAY = 86400
let nextId = 1
const sub = async (userId: string, type: string, status: string, createdDaysAgo: number, subId: string, endInDays = 20) => {
  const id = nextId++
  await db.execute(
    `INSERT INTO subscriptions(id, nanoid, user_id, type, status, is_disabled, created_at, current_period_start, current_period_end, stripe_subscription_id)
     VALUES ($1, $2, $3, $4, $5, FALSE, $6, $6, $7, $8)`,
    [id, `n${id}`, userId, type, status, now - createdDaysAgo * DAY, now + endInDays * DAY, subId]
  )
}
let ledgerId = 1
const consume = async (userId: string, daysAgo: number, reason = "image-generation:txt2img") => {
  await db.execute(
    `INSERT INTO coin_ledger(id, user_id, coin_type, delta, kind, reason, source, created_at) VALUES ($1, $2, 'FREE', -10, 'CONSUME', $3, 'x', $4)`,
    [ledgerId++, userId, reason, now - daysAgo * DAY]
  )
}

// 送る: 3 日前に加入し、加入した日に作っただけ
await sub("quiet", "LITE", "paid", 3, "sub_quiet")
await consume("quiet", 2.9)
// 送る: 解約予約中でも期間が残っている・生成以外（推しコイン）にしか使っていない
await sub("pending", "STANDARD", "cancellation_requested", 5, "sub_pending")
await consume("pending", 1, "work-comment-support")
// 送らない: 2 日目以降も生成している
await sub("active", "LITE", "paid", 4, "sub_active")
await consume("active", 1)
// 送らない: 入って 1 日 / 入って 20 日
await sub("fresh", "LITE", "paid", 1, "sub_fresh")
await sub("old", "LITE", "paid", 20, "sub_old")
// 送らない: プランを変えた人（直前まで別の契約があった）
await sub("changed", "LITE", "canceled", 40, "sub_changed_old", -4)
await sub("changed", "STANDARD", "paid", 4, "sub_changed_new")
// 送らない: 配信停止 / 自動更新なしのパス / Stripe 上で支払いが止まっている
await sub("optout", "LITE", "paid", 3, "sub_optout")
await db.execute("INSERT INTO email_optouts(user_id, created_at) VALUES ('optout', $1)", [now])
await sub("prepaid", "LITE", "paid", 3, "prepaid:cs_1")
await sub("pastdue", "LITE", "paid", 3, "sub_pastdue")

const mails: { to: string[]; subject: string; html: string; headers?: Record<string, string> }[] = []
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.startsWith("https://api.resend.com/emails")) {
    mails.push(JSON.parse(String(init?.body)))
    return Response.json({ id: `mail_${mails.length}` })
  }
  assert.ok(url.startsWith("https://api.stripe.com/v1/"), `予期しない fetch: ${url}`)
  const subId = /\/subscriptions\/([^?]+)/.exec(url)?.[1]
  if (subId) {
    return Response.json({ id: subId, customer: `cus_${subId}`, status: subId === "sub_pastdue" ? "past_due" : "active", metadata: subId === "sub_quiet" ? { locale: "ja" } : {} })
  }
  const customerId = /\/customers\/([^?]+)/.exec(url)?.[1]
  if (customerId) return Response.json({ email: `${customerId}@example.com` })
  return Response.json({})
}) as typeof fetch

const first = await sendNewSubscriberNudges(env, db)
assert.equal(first.sent, 2)
assert.deepEqual(mails.map((m) => m.to[0]).sort(), ["cus_sub_pending@example.com", "cus_sub_quiet@example.com"])
const quiet = mails.find((m) => m.to[0] === "cus_sub_quiet@example.com")!
assert.ok(quiet.subject.includes("毎日 500 コイン"))
assert.ok(quiet.html.includes("ライト") && !quiet.html.includes("Thank you"), "言語が分かっているときはその言語だけ")
assert.ok(!quiet.html.includes("優先生成"), "ライトに優先生成は書かない")
assert.ok(quiet.html.includes("/email/unsubscribe?u=quiet"))
assert.ok(quiet.headers?.["List-Unsubscribe"])
const pending = mails.find((m) => m.to[0] === "cus_sub_pending@example.com")!
assert.ok(pending.html.includes("優先生成") && pending.html.includes("Priority generation"), "言語が分からないときは日英の両方")
assert.ok(pending.html.includes("1,000"))

// 2 回目: 同じ契約には送らない
const second = await sendNewSubscriberNudges(env, db)
assert.equal(second.sent, 0)
assert.equal(mails.length, 2)

assert.ok(buildNewSubscriberNudgeEmail({ passType: "PREMIUM", locale: "en", optout: null }).subject.includes("2,000"))
assert.equal((await sendNewSubscriberNudges({ DB: d1.DB }, db)).sent, 0)

console.log("new-subscriber-nudge.d1-test ok")
process.exit(0)
