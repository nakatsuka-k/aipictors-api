// /internal/subscriptions/current/:userId が Stripe をいつ呼ぶかを本物の Postgres で検証する（Stripe はモック）
import assert from "node:assert/strict"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { app } = await import(`${API}/app.ts`)
const { resetCurrentSubscriptionChecks } = await import(`${API}/lib/subscription-stripe.ts`)

import { createTestD1 } from "./d1.mts"
const d1 = await createTestD1()
const db = d1.db
const pool = { query: async (text: string, params: unknown[] = []) => ({ rows: await db.query(text, params), rowCount: 0 }) }
const env = { DB: d1.DB, GENLOG: d1.GENLOG, INTERNAL_API_TOKEN: "internal", STRIPE_SECRET_KEY: "sk_test_dummy" }

// Stripe のモック
let stripeBody: unknown = {}
let stripeCalls = 0
let stripeThrows = false
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  assert.ok(url.startsWith("https://api.stripe.com/v1/subscriptions/"), `予期しない fetch: ${url}`)
  stripeCalls++
  if (stripeThrows) throw new Error("network")
  return Response.json(stripeBody)
}) as typeof fetch

const realNow = Date.now
let now = realNow()
Date.now = () => now

let nextUserId = 1000
const insert = async (status: string) => {
  const userId = String(nextUserId++)
  const sec = Math.floor(now / 1000)
  await pool.query(
    `INSERT INTO subscriptions(nanoid, user_id, type, status, is_disabled, created_at, current_period_start, current_period_end, stripe_subscription_id)
     VALUES ($1, $2, 'STANDARD', $3, 0, $4, $4, $5, $6)`,
    [`sub-${userId}`, userId, status, sec, sec + 86400, `sub_${userId}`],
  )
  return userId
}

const read = async (userId: string) => {
  const background: Promise<unknown>[] = []
  const res = await app.fetch(
    new Request(`http://api.test/internal/subscriptions/current/${userId}`, { headers: { authorization: "Bearer internal" } }),
    env,
    { waitUntil: (p: Promise<unknown>) => background.push(p), passThroughOnException: () => {} },
  )
  assert.equal(res.status, 200)
  const body = (await res.json()) as { error: null; data: Record<string, unknown> | null }
  return { data: body.data, background }
}
const row = async (userId: string) =>
  (await pool.query("SELECT status, is_disabled FROM subscriptions WHERE user_id = $1", [userId])).rows[0]

const stripeActive = { status: "active", cancel_at_period_end: false, cancel_at: null }
const stripeCancelScheduled = { status: "active", cancel_at_period_end: true }

const test = async (name: string, run: () => Promise<void>) => {
  resetCurrentSubscriptionChecks()
  stripeCalls = 0
  stripeThrows = false
  stripeBody = stripeActive
  await run()
  console.log(`ok - ${name}`)
}

try {
  await test("契約中: Stripe の応答を待たず DB の値を返し、裏で 1 回確かめる", async () => {
    const userId = await insert("paid")
    const release: { run?: () => void } = {}
    const blocking = new Promise<void>((resolve) => {
      release.run = resolve
    })
    const fetchBefore = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      await blocking // 応答を返すまで Stripe が止まっていても read は終わる
      return fetchBefore(input)
    }) as typeof fetch

    const { data, background } = await read(userId)
    assert.equal(data?.status, "paid")
    assert.equal(background.length, 1)

    release.run?.()
    await Promise.all(background)
    globalThis.fetch = fetchBefore
    assert.equal(stripeCalls, 1)
    assert.equal((await row(userId)).status, "paid")
  })

  await test("契約中: 10 分は Stripe を呼ばず、過ぎたらまた確かめる", async () => {
    const userId = await insert("paid")
    await Promise.all((await read(userId)).background)
    for (let i = 0; i < 5; i++) {
      assert.deepEqual((await read(userId)).background, [])
    }
    assert.equal(stripeCalls, 1)

    now += 10 * 60 * 1000
    await Promise.all((await read(userId)).background)
    assert.equal(stripeCalls, 2)
  })

  await test("ポータルでの解約予約: 裏の確認で DB に入り、次の取得で見える", async () => {
    const userId = await insert("paid")
    stripeBody = stripeCancelScheduled
    const first = await read(userId)
    assert.equal(first.data?.status, "paid")
    await Promise.all(first.background)
    assert.equal((await row(userId)).status, "cancellation_requested")
    assert.equal((await read(userId)).data?.status, "cancellation_requested")
  })

  await test("Stripe で解約済み: 裏の確認で無効になり、次の取得では契約なし", async () => {
    const userId = await insert("paid")
    stripeBody = { status: "canceled", cancel_at_period_end: false }
    await Promise.all((await read(userId)).background)
    assert.deepEqual(await row(userId), { status: "canceled", is_disabled: true })
    assert.equal((await read(userId)).data, null)
  })

  await test("解約予定: 同期で確かめ、取り消されていれば同じ応答で paid に戻す", async () => {
    const userId = await insert("cancellation_requested")
    const { data, background } = await read(userId)
    assert.equal(stripeCalls, 1)
    assert.deepEqual(background, [])
    assert.equal(data?.status, "paid")
    assert.equal((await row(userId)).status, "paid")
  })

  await test("解約予定: 予約が残っていれば変えず、1 分は呼び直さない", async () => {
    const userId = await insert("cancellation_requested")
    stripeBody = stripeCancelScheduled
    assert.equal((await read(userId)).data?.status, "cancellation_requested")
    assert.equal((await read(userId)).data?.status, "cancellation_requested")
    assert.equal(stripeCalls, 1)

    now += 60 * 1000
    await read(userId)
    assert.equal(stripeCalls, 2)
  })

  await test("解約予定: cancel_at で日付指定の解約が残っていれば戻さない", async () => {
    const userId = await insert("cancellation_requested")
    stripeBody = { status: "active", cancel_at_period_end: false, cancel_at: 4102444800 }
    assert.equal((await read(userId)).data?.status, "cancellation_requested")
    assert.equal((await row(userId)).status, "cancellation_requested")
  })

  await test("解約予定: Stripe のエラー応答や通信の失敗では戻さない", async () => {
    const userId = await insert("cancellation_requested")
    stripeBody = { error: { message: "No such subscription" } }
    assert.equal((await read(userId)).data?.status, "cancellation_requested")

    resetCurrentSubscriptionChecks()
    stripeThrows = true
    assert.equal((await read(userId)).data?.status, "cancellation_requested")
    assert.equal((await row(userId)).status, "cancellation_requested")
  })

  await test("支払い遅延（past_due）は解約の取り消しとして扱わない", async () => {
    const userId = await insert("cancellation_requested")
    stripeBody = { status: "past_due", cancel_at_period_end: false, cancel_at: null }
    assert.equal((await read(userId)).data?.status, "cancellation_requested")
  })

  await test("契約がなければ Stripe を呼ばない", async () => {
    assert.equal((await read("999999")).data, null)
    assert.equal(stripeCalls, 0)
  })
} finally {
  globalThis.fetch = realFetch
  Date.now = realNow
  await d1.dispose()
}
process.exit(0)
