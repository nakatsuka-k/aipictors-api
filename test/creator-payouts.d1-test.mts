// クリエイター報酬（推しの換金）: 報酬の記録（有料・おまけ除外・R18 除外）、取り消し、月の締め（保留・最低額・上限・源泉・承認）、
// 送金（二重送金の防止・やり直し）、返金・チャージバックの差し戻し、口座登録、Amazon ギフト券の廃止
import assert from "node:assert/strict"
import { Miniflare } from "miniflare"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { app } = await import(`${API}/app.ts`)
const { signPayload } = await import(`${API}/lib/stripe.ts`)
const cp = await import(`${API}/lib/creator-payouts/index.ts`)
const { createPremiumCoinPurchase } = await import(`${API}/lib/premium-coins.ts`)

const d1 = await createTestD1()
const db = d1.db

const coreMf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["CORE"] })
const CORE = await coreMf.getD1Database("CORE")
await CORE.prepare("CREATE TABLE wp_users (ID INTEGER PRIMARY KEY, user_registered TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0)").run()
await CORE.prepare("CREATE TABLE ip_bindings (ip TEXT NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (ip, user_id))").run()
await CORE.prepare("CREATE TABLE works (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL, ageLimit INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0)").run()

// ---- Stripe のモック ----
type Transfer = { id: string; amount: number; destination: string; transfer_group: string; reversed: boolean }
const stripe = {
  accounts: new Map<string, any>(),
  transfers: [] as Transfer[],
  failNextTransfer: null as null | { status: number; code: string; type?: string },
  idempotency: new Map<string, any>(),
  calls: [] as string[],
}
let nextAccount = 1
const stripeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  const method = init?.method ?? "GET"
  stripe.calls.push(`${method} ${url.pathname}`)
  const form = new URLSearchParams(String(init?.body ?? ""))
  const key = (init?.headers as Record<string, string>)?.["Idempotency-Key"]
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
  if (key && stripe.idempotency.has(key)) return ok(stripe.idempotency.get(key))
  const remember = (body: unknown) => {
    if (key) stripe.idempotency.set(key, body)
    return ok(body)
  }
  if (method === "POST" && url.pathname === "/v1/accounts") {
    const id = `acct_test_${nextAccount++}`
    const account = { id, email: form.get("email"), details_submitted: false, payouts_enabled: false, capabilities: { transfers: "inactive" }, business_type: null }
    stripe.accounts.set(id, account)
    return remember(account)
  }
  if (method === "GET" && url.pathname.startsWith("/v1/accounts/")) return ok(stripe.accounts.get(url.pathname.split("/")[3]))
  if (method === "POST" && url.pathname === "/v1/account_links") return ok({ url: `https://connect.stripe.test/setup/${form.get("account")}`, expires_at: 0 })
  if (method === "POST" && url.pathname.endsWith("/login_links")) return ok({ url: "https://connect.stripe.test/express" })
  if (method === "GET" && url.pathname === "/v1/transfers") {
    return ok({ data: stripe.transfers.filter((t) => t.transfer_group === url.searchParams.get("transfer_group")) })
  }
  if (method === "POST" && url.pathname === "/v1/transfers") {
    if (stripe.failNextTransfer) {
      const f = stripe.failNextTransfer
      stripe.failNextTransfer = null
      return new Response(JSON.stringify({ error: { code: f.code, type: f.type ?? "invalid_request_error", message: f.code } }), { status: f.status })
    }
    const transfer = { id: `tr_${stripe.transfers.length + 1}`, amount: Number(form.get("amount")), destination: String(form.get("destination")), transfer_group: String(form.get("transfer_group")), reversed: false }
    stripe.transfers.push(transfer)
    return remember(transfer)
  }
  throw new Error(`予期しない Stripe の呼び出し: ${method} ${url.pathname}`)
}
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).startsWith("https://api.stripe.com/")) return stripeFetch(input, init)
  if (String(input).startsWith("https://api.resend.com/")) return new Response(JSON.stringify({ id: "re_1" }), { status: 200 })
  throw new Error(`予期しない fetch: ${String(input)}`)
}) as typeof fetch

const env: Record<string, unknown> = {
  DB: d1.DB,
  GENLOG: d1.GENLOG,
  SYSTEM_CORE: CORE,
  INTERNAL_API_TOKEN: "internal",
  STRIPE_SECRET_KEY: "sk_live_dummy",
  STRIPE_CONNECT_SECRET_KEY: "sk_test_connect",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_WEBHOOK_SECRET_CONNECT: "whsec_connect",
  CREATOR_PAYOUT_ENABLED: "1",
  CREATOR_PAYOUT_STRIPE_MODE: "test",
  CREATOR_PAYOUT_TEST_USER_IDS: "",
  CREATOR_PAYOUT_APPROVAL_MODE: "all",
  RESEND_API_KEY: "re_test",
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
let nextEventId = 1
const webhook = async (path: string, secret: string, type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const payload = JSON.stringify({ id: `evt_${nextEventId++}`, type, data: { object }, ...extra })
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = await signPayload(secret, `${timestamp}.${payload}`)
  const res = await app.fetch(
    new Request(`http://api.test${path}`, { method: "POST", headers: { "stripe-signature": `t=${timestamp},v1=${signature}` }, body: payload }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  )
  return res.status
}

let passed = 0
const t = async (name: string, fn: () => Promise<void>) => {
  await fn()
  passed++
  console.log(`ok  ${name}`)
}

const DAY = 86400
const realNow = () => Math.floor(Date.now() / 1000)
let nextUser = 100
let nextWork = 1
let nextPurchase = 1
const newUser = async (daysAgo = 365) => {
  const id = nextUser++
  await CORE.prepare("INSERT INTO wp_users(ID, user_registered) VALUES (?, ?)").bind(id, new Date((realNow() - daysAgo * DAY) * 1000).toISOString()).run()
  return String(id)
}
const newWork = async (userId: string, ageLimit = 0) => {
  const id = nextWork++
  await CORE.prepare("INSERT INTO works(id, userId, ageLimit) VALUES (?, ?, ?)").bind(id, Number(userId), ageLimit).run()
  return String(id)
}
// ウェブでコインを買う（coins が有料、bonus がおまけ）
const buy = async (userId: string, coins: number, bonus: number, priceYen = Math.ceil(coins * 0.8)) => {
  const n = nextPurchase++
  return createPremiumCoinPurchase({ db, userId, stripeEventId: `evt_buy_${n}`, stripeSessionId: `cs_${n}`, stripePaymentIntentId: `pi_${n}`, stripeChargeId: `ch_${n}`, coins, bonusCoins: bonus, priceYen })
}
const join = async (userId: string) => {
  const r = await call("POST", "/internal/creator-payouts/join", { userId, termsVersion: cp.CREATOR_REWARD_TERMS_VERSION })
  assert.equal(r.status, 200, JSON.stringify(r.body))
}
const support = async (senderUserId: string, recipientUserId: string, amount: number, opts: { workId?: string | null; source?: string; coinType?: string } = {}) => {
  const r = await call("POST", "/internal/coins/support", {
    senderUserId,
    recipientUserId,
    coinType: opts.coinType ?? "PREMIUM",
    amount,
    source: opts.source ?? `profile-support:${Math.random().toString(36).slice(2)}:PREMIUM`,
    workId: opts.workId ?? null,
  })
  return r
}
const premiumBalance = async (userId: string) =>
  Number((await db.queryOne(`SELECT premium_balance AS b FROM coin_balances WHERE user_id = $1`, [userId]))?.b ?? 0)
const earnings = (userId: string) =>
  db.query(`SELECT kind, coins, amount_milliyen, status, payout_id, available_at FROM creator_earnings WHERE user_id = $1 ORDER BY id`, [userId])
const payout = (id: string) => db.queryOne(`SELECT * FROM creator_payouts WHERE id = $1`, [id])
// 送金できる口座を持っている状態にする（テストモード）
const onboard = async (userId: string, businessType: "individual" | "company" = "individual") => {
  env.CREATOR_PAYOUT_TEST_USER_IDS = `${env.CREATOR_PAYOUT_TEST_USER_IDS},${userId}`
  const link = await call("POST", "/internal/creator-payouts/onboarding-link", { userId, returnUrl: "https://www.aipictors.com/settings/creator-rewards?return=1", refreshUrl: "https://www.aipictors.com/settings/creator-rewards?refresh=1" })
  assert.equal(link.status, 200, JSON.stringify(link.body))
  const accountId = link.body.data.url.split("/").pop()
  Object.assign(stripe.accounts.get(accountId), { details_submitted: true, payouts_enabled: true, capabilities: { transfers: "active" }, business_type: businessType, email: `${userId}@example.com` })
  const r = await call("POST", "/internal/creator-payouts/refresh", { userId })
  assert.equal(r.status, 200)
  return accountId
}
// 時刻を進めた状態で関数を呼ぶ
const at = (unix: number) => unix

// ---------------- 報酬の記録 ----------------
await t("参加していない人への推しは今までどおり全部コイン（報酬なし）", async () => {
  const fan = await newUser(); const creator = await newUser()
  await buy(fan, 1000, 0)
  const r = await support(fan, creator, 100)
  assert.equal(r.status, 200)
  assert.equal(r.body.data.earnedCoins, 0)
  assert.equal(await premiumBalance(creator), 100)
  assert.equal((await earnings(creator)).length, 0)
})

await t("参加者への全年齢作品の推し: 有料コインは報酬（0.5 円/枚）になり、コインでは渡さない。pt は今までどおり", async () => {
  const fan = await newUser(); const creator = await newUser()
  await join(creator)
  const work = await newWork(creator, 0)
  await buy(fan, 1000, 0)
  const r = await support(fan, creator, 100, { workId: work })
  assert.equal(r.body.data.earnedCoins, 100)
  assert.equal(r.body.data.recipientPtAdded, 1000)
  assert.equal(await premiumBalance(creator), 0)
  assert.equal(await premiumBalance(fan), 900)
  const rows = await earnings(creator)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].coins, 100)
  assert.equal(rows[0].amount_milliyen, 50000)
  assert.equal(rows[0].status, "HELD")
  assert.ok(Math.abs(Number(rows[0].available_at) - realNow() - 7 * DAY) < 120)
})

await t("おまけ（ボーナス）分は報酬にならない: 1,000 + おまけ 250 を全部推すと 1,000 枚分だけ報酬", async () => {
  const fan = await newUser(); const creator = await newUser()
  await join(creator)
  const work = await newWork(creator, 3) // R15 は対象
  await buy(fan, 1000, 250)
  const r = await support(fan, creator, 1250, { workId: work })
  assert.equal(r.body.data.earnedCoins, 1000)
  assert.equal(await premiumBalance(creator), 250)
})

await t("R18 / R18G の作品への推しは報酬にならない（コインで渡す）", async () => {
  const fan = await newUser(); const creator = await newUser()
  await join(creator)
  await buy(fan, 1000, 0)
  for (const ageLimit of [1, 2]) {
    const work = await newWork(creator, ageLimit)
    const r = await support(fan, creator, 10, { workId: work })
    assert.equal(r.body.data.earnedCoins, 0)
  }
  // コメントの推し（source に作品 ID）でも同じ
  const r18 = await newWork(creator, 1)
  const r = await support(fan, creator, 10, { source: `work-comment:${r18}:${fan}:${Date.now()}` })
  assert.equal(r.body.data.earnedCoins, 0)
  assert.equal(await premiumBalance(creator), 30)
  assert.equal((await earnings(creator)).length, 0)
})

await t("作品コメントの推しは source の作品で判定する。他人の作品を名乗っても報酬にならない", async () => {
  const fan = await newUser(); const creator = await newUser(); const other = await newUser()
  await join(creator)
  await buy(fan, 1000, 0)
  const own = await newWork(creator, 0)
  assert.equal((await support(fan, creator, 10, { source: `work-comment:${own}:${fan}:1` })).body.data.earnedCoins, 10)
  const others = await newWork(other, 0)
  assert.equal((await support(fan, creator, 10, { workId: others })).body.data.earnedCoins, 0)
})

await t("プロフィールの推し: R18 作品を公開している人には報酬にしない。全年齢だけの人には報酬", async () => {
  const fan = await newUser(); const safe = await newUser(); const adult = await newUser()
  await join(safe); await join(adult)
  await newWork(safe, 0); await newWork(adult, 0); await newWork(adult, 1)
  await buy(fan, 1000, 0)
  assert.equal((await support(fan, safe, 20)).body.data.earnedCoins, 20)
  assert.equal((await support(fan, adult, 20)).body.data.earnedCoins, 0)
})

await t("無料コイン・運営が配ったコイン（感謝コイン）・推しで受け取ったコインの推しは報酬にならない", async () => {
  const fan = await newUser(); const creator = await newUser(); const middle = await newUser()
  await join(creator)
  await newWork(creator, 0)
  // 感謝コイン（SYSTEM のロット）
  await call("POST", "/internal/coins/grant", { userId: fan, premiumCoins: 500, reason: "thanks", source: "thanks:test" })
  assert.equal((await support(fan, creator, 100)).body.data.earnedCoins, 0)
  // 無料コイン
  await call("POST", "/internal/coins/grant", { userId: fan, freeCoins: 100, reason: "test" })
  assert.equal((await support(fan, creator, 50, { coinType: "FREE" })).body.data.earnedCoins, 0)
  // 推しで受け取ったコイン（参加していない middle が受け取って creator へ回す）
  const buyer = await newUser()
  await buy(buyer, 1000, 0)
  await support(buyer, middle, 300)
  assert.equal((await support(middle, creator, 300)).body.data.earnedCoins, 0)
})

await t("有料と無料のロットが混ざると、使った有料分だけが報酬になる（期限の近い購入コインから使う）", async () => {
  const fan = await newUser(); const creator = await newUser()
  await join(creator)
  await newWork(creator, 0)
  await call("POST", "/internal/coins/grant", { userId: fan, premiumCoins: 300, reason: "thanks" }) // 期限なし → 後で使う
  await buy(fan, 200, 0) // 3 か月期限 → 先に使う
  const r = await support(fan, creator, 250)
  assert.equal(r.body.data.earnedCoins, 200)
  assert.equal(await premiumBalance(creator), 50)
})

await t("アプリ内課金のコイン（STORE_PURCHASE）は、おまけを除いた枚数だけ報酬", async () => {
  const fan = await newUser(); const creator = await newUser()
  await join(creator)
  await newWork(creator, 0)
  const g = await call("POST", "/internal/coins/grant", { userId: fan, premiumCoins: 1100, paidPremiumCoins: 1000, sourceKind: "STORE_PURCHASE", reason: "アプリ内課金", source: "app_store" })
  assert.equal(g.status, 200)
  assert.equal((await support(fan, creator, 1100)).body.data.earnedCoins, 999) // 1000/1100 の割合を 100 万分率で切り捨て
})

await t("推しの取り消し（コメント作成の失敗）: 報酬を取り消し、送った人には有料の割合を残して返す", async () => {
  const fan = await newUser(); const creator = await newUser()
  await join(creator)
  await newWork(creator, 0)
  await buy(fan, 100, 0)
  const source = `profile-support:revert-${fan}:PREMIUM`
  await support(fan, creator, 100, { source })
  const r = await call("POST", "/internal/coins/support/revert", { senderUserId: fan, recipientUserId: creator, source })
  assert.equal(r.status, 200)
  assert.equal(await premiumBalance(fan), 100)
  assert.equal(await premiumBalance(creator), 0)
  assert.deepEqual((await earnings(creator)).map((e: any) => e.status), ["REVERSED"])
  // 返したコインをもう一度推すとまた報酬になる
  assert.equal((await support(fan, creator, 100)).body.data.earnedCoins, 100)
})

await t("止めているとき（CREATOR_PAYOUT_ENABLED が 1 以外）は参加も報酬もしない", async () => {
  const fan = await newUser(); const creator = await newUser()
  await join(creator)
  await buy(fan, 100, 0)
  env.CREATOR_PAYOUT_ENABLED = "0"
  try {
    assert.equal((await support(fan, creator, 10)).body.data.earnedCoins, 0)
    const r = await call("POST", "/internal/creator-payouts/join", { userId: await newUser(), termsVersion: cp.CREATOR_REWARD_TERMS_VERSION })
    assert.equal(r.status, 403)
  } finally {
    env.CREATOR_PAYOUT_ENABLED = "1"
  }
})

await t("規約の版が違う同意は受け付けない", async () => {
  const r = await call("POST", "/internal/creator-payouts/join", { userId: await newUser(), termsVersion: "2000-01-01" })
  assert.equal(r.status, 409)
})

// ---------------- 金額の計算 ----------------
await t("金額: 源泉 10.21%（個人）・法人は 0・手数料 500 円・上限までの選び方", async () => {
  assert.deepEqual(cp.calcPayoutAmounts({ grossYen: 3000, taxKind: "INDIVIDUAL", withholdingPpm: 102100 }), { grossYen: 3000, withholdingYen: 306, feeYen: 500, netYen: 2194 })
  assert.deepEqual(cp.calcPayoutAmounts({ grossYen: 100000, taxKind: "CORPORATION", withholdingPpm: 102100 }), { grossYen: 100000, withholdingYen: 0, feeYen: 500, netYen: 99500 })
  assert.equal(cp.calcWithholdingYen(12345, "INDIVIDUAL", 102100), 1260)
  const rows = [
    { amount_milliyen: 60000000 },
    { amount_milliyen: -1000000 },
    { amount_milliyen: 50000000 },
    { amount_milliyen: 10000000 },
  ]
  const { selected, grossMilliyen } = cp.selectEarningsForPayout(rows, 100000)
  // マイナスは必ず入れる。古い順に入れて、上限を超える行が来たらそこで止める（60,000 − 1,000、50,000 からあとは次の月）
  assert.equal(grossMilliyen, 59000000)
  assert.equal(selected.length, 2)
  const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000)
  // 締めは 10 日と 25 日。その日の 0:00 までに保留が明けた分
  assert.deepEqual(cp.getClosingPeriod(ts("2027-01-10T10:00:00+09:00")), { period: "2027-01-10", cutoff: ts("2027-01-10T00:00:00+09:00") })
  assert.deepEqual(cp.getClosingPeriod(ts("2027-01-25T10:00:00+09:00")), { period: "2027-01-25", cutoff: ts("2027-01-25T00:00:00+09:00") })
  assert.deepEqual(cp.getClosingPeriod(ts("2027-01-05T10:00:00+09:00")), { period: "2026-12-25", cutoff: ts("2026-12-25T00:00:00+09:00") })
  assert.equal(cp.payoutIdFor("2026-12-25", "42"), "cp_20261225_42")
  assert.equal(cp.payoutIdFor("2026-12", "42"), "cp_202612_42")
  assert.equal(cp.CREATOR_REWARD_HOLD_DAYS, 7)
  // 次の締め
  assert.equal(cp.nextCloseAt(ts("2026-11-16T06:00:00+09:00")), ts("2026-11-25T10:00:00+09:00"))
  assert.equal(cp.nextCloseAt(ts("2026-11-25T10:00:00+09:00")), ts("2026-12-10T10:00:00+09:00"))
  assert.equal(cp.nextCloseAt(ts("2026-12-26T00:00:00+09:00")), ts("2027-01-10T10:00:00+09:00"))
  // 11/16 の推し → 11/23 に保留明け → 11/25 の締め。11/18 の推し → 11/25 明け（その日の 0:00 より後）→ 12/10
  const now16 = ts("2026-11-16T06:00:00+09:00")
  assert.equal(cp.firstCloseForAvailableAt(now16 + 7 * 86400, now16), ts("2026-11-25T10:00:00+09:00"))
  assert.equal(cp.firstCloseForAvailableAt(ts("2026-11-25T06:00:00+09:00"), now16), ts("2026-12-10T10:00:00+09:00"))
  assert.equal(cp.firstCloseForAvailableAt(ts("2026-11-24T23:59:00+09:00"), now16), ts("2026-11-25T10:00:00+09:00"))
  // 1 回の上限: 月 10 万円からその月の締めを引く。本人確認から 30 日以内は 3 万円まで
  const old = now16 - 40 * 86400
  assert.equal(cp.payoutLimitYen({ monthUsedYen: 0, payoutsEnabledAt: old, now: now16 }), 100000)
  assert.equal(cp.payoutLimitYen({ monthUsedYen: 70000, payoutsEnabledAt: old, now: now16 }), 30000)
  assert.equal(cp.payoutLimitYen({ monthUsedYen: 120000, payoutsEnabledAt: old, now: now16 }), 0)
  assert.equal(cp.payoutLimitYen({ monthUsedYen: 0, payoutsEnabledAt: now16 - 10 * 86400, now: now16 }), 30000)
  assert.equal(cp.payoutLimitYen({ monthUsedYen: 0, payoutsEnabledAt: null, now: now16 }), 30000)
})

// ---------------- 締めと送金 ----------------
// 報酬を直接入れる（保留明けの時刻を指定）
const addEarning = async (userId: string, coins: number, availableAt: number, senderUserId = "999") =>
  db.execute(
    `INSERT INTO creator_earnings(user_id, kind, source, sender_user_id, coins, rate_milliyen, amount_milliyen, status, available_at, created_at, updated_at)
     VALUES ($1, 'SUPPORT', 'test', $2, $3, 500, $3 * 500, 'HELD', $4, $4, $4)`,
    [userId, senderUserId, coins, availableAt],
  )
const closeAt = Math.floor(Date.parse("2027-02-10T10:00:00+09:00") / 1000)
const janEnd = Math.floor(Date.parse("2027-01-31T12:00:00+09:00") / 1000)
const febStart = Math.floor(Date.parse("2027-02-10T06:00:00+09:00") / 1000)

await t("締め: 保留明け（締めの日の 0:00 まで）だけ・最低額未満と口座未登録は繰り越し・承認制なら承認待ち", async () => {
  const a = await newUser(); const small = await newUser(); const noAccount = await newUser()
  for (const u of [a, small, noAccount]) await join(u)
  await onboard(a); await onboard(small)
  // 有名なファン 3 人から（1 人に偏らない）
  await addEarning(a, 4000, janEnd, "1001"); await addEarning(a, 4000, janEnd, "1002"); await addEarning(a, 4000, janEnd, "1003")
  await addEarning(a, 4000, febStart) // 2 月に明ける分は次回
  await addEarning(small, 5000, janEnd) // 2,500 円 < 3,000 円
  await addEarning(noAccount, 20000, janEnd)
  const dry = await call("POST", "/internal/creator-payouts/admin/close", { period: "2027-01" })
  assert.equal(dry.status, 200)
  assert.equal((await db.query(`SELECT 1 FROM creator_payouts`)).length, 0) // 試算は書かない
  const result = await cp.closeMonthlyPayouts({ db, core: CORE, env, now: closeAt })
  const byUser = Object.fromEntries(result.results.map((r: any) => [r.userId, r]))
  assert.equal(byUser[a].action, "created")
  assert.equal(byUser[a].status, "AWAITING_APPROVAL")
  assert.equal(byUser[a].grossYen, 6000)
  assert.equal(byUser[a].withholdingYen, 612)
  assert.equal(byUser[a].netYen, 4888)
  assert.equal(byUser[small].action, "below_minimum")
  assert.equal(byUser[noAccount].action, "account_not_ready")
  const statuses = (await earnings(a)).map((e: any) => e.status)
  assert.deepEqual(statuses, ["IN_PAYOUT", "IN_PAYOUT", "IN_PAYOUT", "HELD"])
  // もう一度締めても同じ（二重に作らない）
  const again = await cp.closeMonthlyPayouts({ db, core: CORE, env, now: closeAt })
  assert.equal(again.results.filter((r: any) => r.action === "created").length, 0)
  assert.equal((await db.query(`SELECT 1 FROM creator_payouts WHERE user_id = $1`, [a])).length, 1)
})

await t("承認するとすぐ送金。同時に何回送っても Stripe への送金は 1 回。初回承認のあとは承認キューを通らない（first モード）", async () => {
  const a = await newUser()
  await join(a)
  const account = await onboard(a)
  await addEarning(a, 3000, janEnd, "2001"); await addEarning(a, 3000, janEnd, "2002"); await addEarning(a, 3000, janEnd, "2003")
  await cp.closeMonthlyPayouts({ db, core: CORE, env, now: closeAt })
  const id = cp.payoutIdFor("2027-02-10", a)
  // 承認前に送ろうとしても送らない
  assert.equal((await cp.sendReadyPayouts({ db, env, now: closeAt, payoutId: id })).sent, 0)
  const before = stripe.transfers.length
  const approve = await call("POST", `/internal/creator-payouts/admin/payouts/${id}/approve`, { moderatorUserId: "1" })
  assert.equal(approve.status, 200)
  // 承認と同時に cron も走った想定
  await Promise.all([cp.sendReadyPayouts({ db, env, now: closeAt }), cp.sendReadyPayouts({ db, env, now: closeAt }), cp.sendReadyPayouts({ db, env, now: closeAt })])
  const sent = stripe.transfers.filter((tr) => tr.transfer_group === id)
  assert.equal(stripe.transfers.length - before, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].destination, account)
  assert.equal(sent[0].amount, 4500 - 459 - 500)
  const p: any = await payout(id)
  assert.equal(p.status, "SENT")
  assert.ok((await earnings(a)).every((e: any) => e.status === "PAID"))
  // 送金のお知らせはメールで 1 回
  assert.equal((await db.query(`SELECT 1 FROM email_campaign_sends WHERE campaign = $1`, [`creator-payout:${id}:sent`])).length, 1)
  // 次の月: first モードなら承認済みの人は READY
  env.CREATOR_PAYOUT_APPROVAL_MODE = "first"
  try {
    const feb = Math.floor(Date.parse("2027-02-20T12:00:00+09:00") / 1000)
    await addEarning(a, 3000, feb, "2001"); await addEarning(a, 3000, feb, "2002"); await addEarning(a, 3000, feb, "2003")
    const res = await cp.closeMonthlyPayouts({ db, core: CORE, env, now: Math.floor(Date.parse("2027-03-10T10:00:00+09:00") / 1000) })
    const mine = res.results.find((r: any) => r.userId === a)
    assert.equal(mine.status, "READY")
  } finally {
    env.CREATOR_PAYOUT_APPROVAL_MODE = "all"
  }
})

await t("送金が残高不足で失敗 → FAILED（やり直し可）→ 翌日の cron で送れる。上限 3 回", async () => {
  const a = await newUser()
  await join(a); await onboard(a)
  await db.execute(`UPDATE creator_payout_profiles SET approved_at = 1 WHERE user_id = $1`, [a])
  await addEarning(a, 3000, janEnd, "3001"); await addEarning(a, 3000, janEnd, "3002"); await addEarning(a, 3000, janEnd, "3003")
  env.CREATOR_PAYOUT_APPROVAL_MODE = "first"
  try {
    await cp.closeMonthlyPayouts({ db, core: CORE, env, now: closeAt })
  } finally {
    env.CREATOR_PAYOUT_APPROVAL_MODE = "all"
  }
  const id = cp.payoutIdFor("2027-02-10", a)
  stripe.failNextTransfer = { status: 400, code: "balance_insufficient" }
  const first = await cp.sendReadyPayouts({ db, env, now: closeAt, payoutId: id })
  assert.equal(first.failed, 1)
  let p: any = await payout(id)
  assert.equal(p.status, "FAILED")
  assert.match(p.last_error, /^retryable:balance_insufficient/)
  // 同じ日のうちはやり直さない
  assert.equal((await cp.sendReadyPayouts({ db, env, now: closeAt + 3600, payoutId: id })).results.length, 0)
  const next = await cp.sendReadyPayouts({ db, env, now: closeAt + DAY, payoutId: id })
  assert.equal(next.sent, 1)
  p = await payout(id)
  assert.equal(p.status, "SENT")
  assert.equal(Number(p.attempts), 2)
})

await t("口座の誤りなどやり直せない失敗は止めて、運営と本人に知らせる", async () => {
  const a = await newUser()
  await join(a); await onboard(a)
  await db.execute(`UPDATE creator_payout_profiles SET approved_at = 1 WHERE user_id = $1`, [a])
  await addEarning(a, 3000, janEnd, "4001"); await addEarning(a, 3000, janEnd, "4002"); await addEarning(a, 3000, janEnd, "4003")
  env.CREATOR_PAYOUT_APPROVAL_MODE = "first"; env.CREATOR_PAYOUT_ADMIN_EMAIL = "admin@example.com"
  try {
    await cp.closeMonthlyPayouts({ db, core: CORE, env, now: closeAt })
    const id = cp.payoutIdFor("2027-02-10", a)
    stripe.failNextTransfer = { status: 400, code: "account_invalid" }
    await cp.sendReadyPayouts({ db, env, now: closeAt, payoutId: id, notify: cp.createPayoutNotifier(env, db) })
    const p: any = await payout(id)
    assert.equal(p.status, "FAILED")
    assert.match(p.last_error, /^fatal:/)
    assert.equal((await cp.sendReadyPayouts({ db, env, now: closeAt + 2 * DAY, payoutId: id })).results.length, 0)
    assert.equal((await db.query(`SELECT 1 FROM email_campaign_sends WHERE campaign LIKE $1`, [`creator-payout:${id}:failed:%`])).length, 2)
  } finally {
    env.CREATOR_PAYOUT_APPROVAL_MODE = "all"; delete env.CREATOR_PAYOUT_ADMIN_EMAIL
  }
})

await t("SENDING のまま止まった振込は、Stripe に送金があれば SENT、なければ READY に戻す（二重に送らない）", async () => {
  const a = await newUser()
  await join(a); const account = await onboard(a)
  await db.execute(`UPDATE creator_payout_profiles SET approved_at = 1 WHERE user_id = $1`, [a])
  await addEarning(a, 3000, janEnd, "5001"); await addEarning(a, 3000, janEnd, "5002"); await addEarning(a, 3000, janEnd, "5003")
  env.CREATOR_PAYOUT_APPROVAL_MODE = "first"
  try {
    await cp.closeMonthlyPayouts({ db, core: CORE, env, now: closeAt })
  } finally {
    env.CREATOR_PAYOUT_APPROVAL_MODE = "all"
  }
  const id = cp.payoutIdFor("2027-02-10", a)
  // 送金は Stripe に届いたが、こちらの記録の前に落ちた
  stripe.transfers.push({ id: "tr_crashed", amount: 1, destination: account, transfer_group: id, reversed: false })
  await db.execute(`UPDATE creator_payouts SET status = 'SENDING', updated_at = $2 WHERE id = $1`, [id, closeAt - 7200])
  await cp.sendReadyPayouts({ db, env, now: closeAt })
  assert.equal(stripe.transfers.filter((tr) => tr.transfer_group === id).length, 1)
  const p: any = await payout(id)
  assert.equal(p.status, "SENT")
  assert.equal(p.stripe_transfer_id, "tr_crashed")
})

await t("不正の疑い（同じ IP・登録したばかりの推した人・1 人からの偏り）は承認待ちにして理由を残す", async () => {
  const creator = await newUser(); const fan = await newUser(2)
  await join(creator); await onboard(creator)
  await db.execute(`UPDATE creator_payout_profiles SET approved_at = 1 WHERE user_id = $1`, [creator])
  await CORE.prepare("INSERT INTO ip_bindings(ip, user_id) VALUES ('1.2.3.4', ?), ('1.2.3.4', ?)").bind(Number(creator), Number(fan)).run()
  await db.execute(
    `INSERT INTO creator_earnings(user_id, kind, source, sender_user_id, coins, rate_milliyen, amount_milliyen, status, available_at, created_at, updated_at)
     VALUES ($1, 'SUPPORT', 'test', $2, 20000, 500, 10000000, 'HELD', $3, $4, $4)`,
    [creator, fan, janEnd, realNow()],
  )
  env.CREATOR_PAYOUT_APPROVAL_MODE = "first"
  try {
    const res = await cp.closeMonthlyPayouts({ db, core: CORE, env, now: closeAt })
    const mine = res.results.find((r: any) => r.userId === creator)
    assert.equal(mine.status, "AWAITING_APPROVAL")
    const codes = [...new Set(mine.flags.map((f: any) => f.code))].sort()
    if (codes.length !== 3) console.log(JSON.stringify(mine.flags))
    assert.deepEqual(codes, ["new_sender_account", "shared_ip", "single_sender"])
  } finally {
    env.CREATOR_PAYOUT_APPROVAL_MODE = "all"
  }
})

await t("振込をやめる: release は翌月以降へ繰り越し、reverse は報酬を取り消し", async () => {
  const a = await newUser(); const b = await newUser()
  for (const u of [a, b]) { await join(u); await onboard(u) }
  for (const u of [a, b]) { await addEarning(u, 3000, janEnd, "6001"); await addEarning(u, 3000, janEnd, "6002"); await addEarning(u, 3000, janEnd, "6003") }
  await cp.closeMonthlyPayouts({ db, core: CORE, env, now: closeAt })
  const r1 = await call("POST", `/internal/creator-payouts/admin/payouts/${cp.payoutIdFor("2027-02-10", a)}/cancel`, { moderatorUserId: "1", mode: "release" })
  const r2 = await call("POST", `/internal/creator-payouts/admin/payouts/${cp.payoutIdFor("2027-02-10", b)}/cancel`, { moderatorUserId: "1", mode: "reverse", reason: "self support" })
  assert.equal(r1.status, 200); assert.equal(r2.status, 200)
  assert.ok((await earnings(a)).every((e: any) => e.status === "HELD" && e.payout_id === null))
  assert.ok((await earnings(b)).every((e: any) => e.status === "REVERSED"))
  // 送金済みはやめられない
  const sentRow: any = await db.queryOne(`SELECT id AS pid FROM creator_payouts WHERE status = 'SENT' LIMIT 1`)
  const r3 = await call("POST", `/internal/creator-payouts/admin/payouts/${sentRow.pid}/cancel`, { moderatorUserId: "1", mode: "reverse" })
  assert.equal(r3.status, 409)
})

await t("上限: 1 か月 100,000 円を超えた分は次の月へ", async () => {
  const a = await newUser()
  await join(a); await onboard(a, "company")
  for (let i = 0; i < 3; i++) await addEarning(a, 80000, janEnd, String(7000 + i)) // 40,000 円 × 3
  const res = await cp.closeMonthlyPayouts({ db, core: CORE, env, now: closeAt })
  const mine = res.results.find((r: any) => r.userId === a)
  assert.equal(mine.grossYen, 80000)
  assert.equal(mine.withholdingYen, 0) // 法人
  assert.deepEqual((await earnings(a)).map((e: any) => e.status), ["IN_PAYOUT", "IN_PAYOUT", "HELD"])
})

await t("月 2 回の締め: 25 日はその月の 10 日の分を引いた残りまで。本人確認から 30 日以内は 1 回 3 万円まで", async () => {
  const a = await newUser()
  await join(a); await onboard(a, "company")
  for (let i = 0; i < 3; i++) await addEarning(a, 80000, janEnd, String(7100 + i)) // 40,000 円 × 3
  const close10 = await cp.closeMonthlyPayouts({ db, core: CORE, env, now: closeAt })
  assert.equal(close10.results.find((r: any) => r.userId === a).grossYen, 80000)
  const close25 = await cp.closeMonthlyPayouts({ db, core: CORE, env, now: Math.floor(Date.parse("2027-02-25T10:00:00+09:00") / 1000) })
  // 残りは 20,000 円だが次の行は 40,000 円なので 3 月へ
  assert.equal(close25.results.find((r: any) => r.userId === a).action, "monthly_limit_reached")
  const close0310 = await cp.closeMonthlyPayouts({ db, core: CORE, env, now: Math.floor(Date.parse("2027-03-10T10:00:00+09:00") / 1000) })
  assert.equal(close0310.results.find((r: any) => r.userId === a).grossYen, 40000)
  // 新しい口座（本人確認が済んだばかり）
  const b = await newUser()
  await join(b); await onboard(b, "company")
  const enabledAt = Number((await db.queryOne(`SELECT payouts_enabled_at FROM creator_payout_profiles WHERE user_id = $1`, [b])).payouts_enabled_at)
  assert.ok(enabledAt > 0)
  // 口座登録の前からたまっていた 10,000 円 × 4。登録直後の締めでは 3 万円まで
  for (let i = 0; i < 4; i++) await addEarning(b, 20000, enabledAt - 30 * DAY, String(7200 + i))
  const res = await cp.closeMonthlyPayouts({ db, core: CORE, env, now: cp.nextCloseAt(enabledAt), period: "new-account-test" })
  assert.equal(res.results.find((r: any) => r.userId === b).grossYen, 30000)
})

// ---------------- 返金・チャージバック ----------------
await t("コイン購入の返金: 保留中の報酬は取り消し、購入した有料コインの枚数まで", async () => {
  const fan = await newUser(); const creator = await newUser()
  await join(creator); await newWork(creator, 0)
  const purchase = await buy(fan, 300, 100)
  await support(fan, creator, 400) // 有料 300 枚分が報酬
  const n = nextPurchase - 1
  const status = await webhook("/webhooks/stripe/premium-coins", "whsec_test", "charge.refunded", { id: `ch_${n}`, payment_intent: `pi_${n}` })
  assert.equal(status, 200)
  assert.ok(purchase.created)
  assert.deepEqual((await earnings(creator)).map((e: any) => [e.status, e.coins]), [["REVERSED", 300]])
})

await t("チャージバック: 振込待ちの振込からは外して計算し直し、振込済みは次回から差し引く", async () => {
  const fan = await newUser(); const creator = await newUser(); const paidCreator = await newUser()
  for (const u of [creator, paidCreator]) { await join(u); await onboard(u); await newWork(u, 0) }
  await buy(fan, 10000, 0)
  const n = nextPurchase - 1
  // 推しの報酬（creator は振込待ち、paidCreator は振込済み）を作る
  await support(fan, creator, 4000)
  await support(fan, creator, 4000)
  await support(fan, paidCreator, 2000)
  await db.execute(`UPDATE creator_earnings SET available_at = $1 WHERE sender_user_id = $2`, [janEnd, fan])
  await addEarning(creator, 8000, janEnd, "8001")
  await addEarning(paidCreator, 6000, janEnd, "8002"); await addEarning(paidCreator, 6000, janEnd, "8003")
  await cp.closeMonthlyPayouts({ db, core: CORE, env, now: closeAt })
  const paidId = cp.payoutIdFor("2027-02-10", paidCreator)
  await cp.approvePayout({ db, payoutId: paidId, moderatorUserId: "1" })
  await cp.sendReadyPayouts({ db, env, now: closeAt, payoutId: paidId })
  assert.equal(((await payout(paidId)) as any).status, "SENT")
  const status = await webhook("/webhooks/stripe/premium-coins", "whsec_test", "charge.dispute.created", { id: "dp_1", charge: `ch_${n}`, payment_intent: `pi_${n}` })
  assert.equal(status, 200)
  // creator: 推しの 8,000 枚分が外れ、残りは 8,000 枚 = 4,000 円で振込は続く
  const p: any = await payout(cp.payoutIdFor("2027-02-10", creator))
  assert.equal(p.status, "AWAITING_APPROVAL")
  assert.equal(Number(p.gross_yen), 4000)
  assert.equal(Number(p.net_yen), 4000 - 408 - 500)
  // paidCreator: 2,000 枚分（1,000 円）を次回から差し引くマイナスの行
  const claw = (await earnings(paidCreator)).filter((e: any) => e.kind === "CLAWBACK")
  assert.equal(claw.length, 1)
  assert.equal(Number(claw[0].amount_milliyen), -1000000)
  assert.equal(claw[0].status, "HELD")
})

// ---------------- 口座登録 ----------------
await t("口座登録: テストモードでは許可した人だけ。アカウントは 1 人 1 つ、webhook で状態が変わる", async () => {
  const a = await newUser()
  await join(a)
  const denied = await call("POST", "/internal/creator-payouts/onboarding-link", { userId: a, returnUrl: "https://www.aipictors.com/x", refreshUrl: "https://www.aipictors.com/x" })
  assert.equal(denied.status, 403)
  env.CREATOR_PAYOUT_TEST_USER_IDS = `${env.CREATOR_PAYOUT_TEST_USER_IDS},${a}`
  const bad = await call("POST", "/internal/creator-payouts/onboarding-link", { userId: a, returnUrl: "https://evil.example/x", refreshUrl: "https://www.aipictors.com/x" })
  assert.equal(bad.status, 400)
  const l1 = await call("POST", "/internal/creator-payouts/onboarding-link", { userId: a, returnUrl: "https://www.aipictors.com/x", refreshUrl: "https://www.aipictors.com/x" })
  const l2 = await call("POST", "/internal/creator-payouts/onboarding-link", { userId: a, returnUrl: "https://www.aipictors.com/x", refreshUrl: "https://www.aipictors.com/x" })
  assert.equal(l1.body.data.url, l2.body.data.url)
  const accountId = l1.body.data.url.split("/").pop()
  let summary = (await call("GET", `/internal/creator-payouts/summary/${a}`)).body.data
  assert.equal(summary.profile.payoutReady, false)
  const status = await webhook("/webhooks/stripe/connect", "whsec_connect", "account.updated", {
    id: accountId, details_submitted: true, payouts_enabled: true, capabilities: { transfers: "active" }, business_type: "company", company: { structure: "sole_proprietorship" }, email: "x@example.com",
  }, { livemode: false, account: accountId })
  assert.equal(status, 200)
  summary = (await call("GET", `/internal/creator-payouts/summary/${a}`)).body.data
  assert.equal(summary.profile.payoutReady, true)
  assert.equal(summary.profile.taxKind, "INDIVIDUAL") // 個人事業主は個人として源泉徴収
  // 本番のモードに切り替えると、テストのアカウントは使えない（作り直し）
  env.CREATOR_PAYOUT_STRIPE_MODE = "live"; env.STRIPE_CONNECT_SECRET_KEY = "sk_live_connect"
  try {
    summary = (await call("GET", `/internal/creator-payouts/summary/${a}`)).body.data
    assert.equal(summary.profile.payoutReady, false)
    assert.equal(summary.profile.hasAccount, false)
  } finally {
    env.CREATOR_PAYOUT_STRIPE_MODE = "test"; env.STRIPE_CONNECT_SECRET_KEY = "sk_test_connect"
  }
})

await t("本人のまとめ: 保留中・保留明け・振込待ち・振込済みの額と明細", async () => {
  const fan = await newUser(); const creator = await newUser()
  await join(creator); await newWork(creator, 0)
  await buy(fan, 1000, 0)
  await support(fan, creator, 600)
  await addEarning(creator, 1000, realNow() - DAY)
  const s = (await call("GET", `/internal/creator-payouts/summary/${creator}`)).body.data
  assert.equal(s.joined, true)
  assert.equal(s.balances.holdingYen, 300)
  assert.equal(s.balances.availableYen, 500)
  assert.equal(s.earnings.length, 2)
  assert.equal(s.config.rateMilliyen, 500)
  assert.equal(s.config.feeYen, 500)
})

// ---------------- Amazon ギフト券の廃止 ----------------
await t("Amazon ギフト券の交換申請・承認は 410（廃止）", async () => {
  const r = await call("POST", "/internal/coins/amazon-exchange", { userId: "1", packageId: "AMAZON_1000", coinAmount: 1000, amazonPointYen: 300 })
  assert.equal(r.status, 410)
  const a = await call("POST", "/internal/coins/amazon-exchange/x/approve", { amazonGiftCode: "X", moderatorUserId: "1" })
  assert.equal(a.status, 410)
})

await t("cron: 10 日と 25 日は締めてから送る。それ以外の日は送るだけ", async () => {
  const r = await cp.runCreatorPayoutJob(env, db, Math.floor(Date.parse("2027-04-11T10:00:00+09:00") / 1000))
  assert.equal(r.closed, null)
  const r2 = await cp.runCreatorPayoutJob(env, db, Math.floor(Date.parse("2027-04-10T10:00:00+09:00") / 1000))
  assert.equal(r2.closed.period, "2027-04-10")
  const r3 = await cp.runCreatorPayoutJob(env, db, Math.floor(Date.parse("2027-04-25T10:00:00+09:00") / 1000))
  assert.equal(r3.closed.period, "2027-04-25")
})

console.log(`${passed} passed`)
await coreMf.dispose()
await d1.dispose()
void at
