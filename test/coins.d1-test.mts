// aipictors-api の日次コイン処理を D1（Miniflare）で検証する（同時実行を含む）
import assert from "node:assert/strict"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const coins = await import(`${API}/lib/coins.ts`)
const daily = await import(`${API}/lib/daily-coins.ts`)

const d1 = await createTestD1()
const db = d1.db

// 時刻を固定して進める
let fakeNow = Date.parse("2026-10-27T03:00:00+09:00")
Date.now = () => fakeNow
const sec = () => Math.floor(fakeNow / 1000)

const ledger = (u: string, kind: string) =>
  db.query(`SELECT coin_type, delta FROM coin_ledger WHERE user_id = $1 AND kind = $2 ORDER BY id`, [u, kind])
const balance = async (u: string) => (await coins.getCoinSummary(db, u, {})).totalBalance
const addSub = (u: string, type: string, status: string, endOffsetSec: number) =>
  db.execute(
    `INSERT INTO subscriptions(nanoid, user_id, type, status, is_disabled, created_at, current_period_start, current_period_end, stripe_subscription_id)
     VALUES ($1, $2, $3, $4, 0, $5, $5, $6, $1)`,
    [`sub_${u}_${type}_${status}`, u, type, status, sec() - 30 * 86400, sec() + endOffsetSec],
  )

let passed = 0
const t = async (name: string, fn: () => Promise<void>) => {
  await fn()
  passed++
  console.log(`ok  ${name}`)
}

await t("無料ユーザに 30 並列でアクセスしても 100 枚が 1 回だけ付く", async () => {
  const rs = await Promise.all(Array.from({ length: 30 }, () => coins.ensureInitialCoinGrant({ db, userId: "u1", planType: "FREE" })))
  assert.equal(rs.filter((r) => r.granted).length, 1)
  assert.deepEqual(await ledger("u1", "INITIAL_GRANT"), [{ coin_type: "FREE", delta: 100 }])
  assert.equal(await balance("u1"), 100)
})

await t("契約者は呼び出し元が FREE と言っても契約プラン分が付く（無料分の上乗せなし）", async () => {
  await addSub("u2", "STANDARD", "paid", 10 * 86400)
  await Promise.all([
    coins.ensureInitialCoinGrant({ db, userId: "u2", planType: "FREE" }),
    coins.ensureInitialCoinGrant({ db, userId: "u2", planType: "STANDARD" }),
    coins.ensureInitialCoinGrant({ db, userId: "u2" }),
  ])
  assert.equal(await balance("u2"), 1000)
  assert.equal((await ledger("u2", "INITIAL_GRANT")).length, 1)
})

await t("日中に上位プランに変わったら差額だけ追加される", async () => {
  await coins.ensureInitialCoinGrant({ db, userId: "u3", planType: "FREE" })
  await addSub("u3", "LITE", "paid", 10 * 86400)
  const r = await coins.ensureInitialCoinGrant({ db, userId: "u3", planType: "LITE" })
  assert.equal(r.grantedFreeCoins, 400)
  assert.equal(await balance("u3"), 500)
})

await t("旧実装で今日すでに付与済み（プラン別キー）の人には追加しない", async () => {
  const prefix = daily.dailyGrantKeyPrefix(sec())
  await db.execute(
    `INSERT INTO coin_grants(user_id, grant_key, plan_type, free_coins, premium_coins, created_at) VALUES
       ('u4', $1, 'STANDARD', 1000, 0, $3), ('u4', $2, 'FREE', 100, 0, $3)`,
    [`${prefix}:STANDARD`, `${prefix}:FREE`, sec()],
  )
  await addSub("u4", "STANDARD", "paid", 10 * 86400)
  const r = await coins.ensureInitialCoinGrant({ db, userId: "u4", planType: "STANDARD" })
  assert.equal(r.grantedFreeCoins, 0)
})

await t("更新日の決済待ち（期間終了から 10 時間）はプラン扱い、解約予約で期間終了なら無料", async () => {
  await addSub("u5", "PREMIUM", "paid", -10 * 3600)
  await addSub("u6", "PREMIUM", "cancellation_requested", -10 * 3600)
  await addSub("u7", "PREMIUM", "paid", -40 * 3600)
  assert.equal((await coins.ensureInitialCoinGrant({ db, userId: "u5", planType: "FREE" })).grantedFreeCoins, 2000)
  assert.equal((await coins.ensureInitialCoinGrant({ db, userId: "u6", planType: "FREE" })).grantedFreeCoins, 100)
  assert.equal((await coins.ensureInitialCoinGrant({ db, userId: "u7", planType: "FREE" })).grantedFreeCoins, 100)
})

await t("残高 100 枚に 10 枚 × 20 並列で消費すると、ちょうど 10 回だけ成功する", async () => {
  const rs = await Promise.all(Array.from({ length: 20 }, () => coins.consumeCoins({ db, userId: "u1", amount: 10 })))
  assert.equal(rs.filter((r) => r.ok).length, 10)
  assert.equal(await balance("u1"), 0)
})

await t("00:00 のジョブ: 全員を 1 回だけ失効させ、契約者に付与。同時アクセスがあっても二重にならない", async () => {
  // 前日分の残高を作る（u8: 無料 100 枚、u2: STANDARD 1000 枚は前のテストで付与済み）
  await coins.ensureInitialCoinGrant({ db, userId: "u8", planType: "FREE" })
  fakeNow = Date.parse("2026-10-28T00:00:05+09:00")
  const [job] = await Promise.all([
    daily.runDailyCoinJob(db, sec()),
    ...Array.from({ length: 10 }, () => coins.getCoinSummary(db, "u8", {})),
    ...Array.from({ length: 10 }, () => coins.ensureInitialCoinGrant({ db, userId: "u2", planType: "STANDARD" })),
  ])
  assert.deepEqual(await ledger("u8", "EXPIRE"), [{ coin_type: "FREE", delta: -100 }])
  assert.deepEqual(await ledger("u2", "EXPIRE"), [{ coin_type: "FREE", delta: -1000 }])
  assert.equal(await balance("u8"), 0)
  assert.equal(await balance("u2"), 1000)
  assert.equal((await ledger("u2", "INITIAL_GRANT")).length, 2) // 昨日 1 回 + 今日 1 回
  assert.ok(job.subscribers >= 3)
  const expireTimes = await db.query(`SELECT DISTINCT created_at FROM coin_ledger WHERE kind = 'EXPIRE' AND user_id IN ('u3','u4','u5')`)
  assert.ok(expireTimes.every((r: { created_at: number }) => Number(r.created_at) === sec()))
})

await t("ジョブを再実行しても何も起きない（取りこぼし用の 00:30 実行）", async () => {
  fakeNow += 30 * 60 * 1000
  const job = await daily.runDailyCoinJob(db, sec())
  assert.equal(job.expiredUsers, 0)
  assert.equal(job.grantedUsers, 0)
})

await t("ジョブで付与・失効したお知らせは次のアクセスで 1 回だけ返る", async () => {
  const [a, b] = await Promise.all([
    coins.ensureInitialCoinGrant({ db, userId: "u5", planType: "FREE" }),
    coins.ensureInitialCoinGrant({ db, userId: "u5", planType: "FREE" }),
  ])
  const events = [...a.events, ...b.events]
  assert.equal(events.filter((e) => e.kind === "EXPIRE").length, 1)
  assert.equal(events.filter((e) => e.kind === "GRANT").length, 1)
  assert.match(events.find((e) => e.kind === "GRANT")!.message, /フリーコイン2000枚が付与されました/)
  assert.match(events.find((e) => e.kind === "EXPIRE")!.message, /フリーコイン2000枚が失効しました/)
})

await t("無料ユーザは翌日の初回アクセスで 100 枚", async () => {
  const r = await coins.ensureInitialCoinGrant({ db, userId: "u8", planType: "FREE" })
  assert.equal(r.grantedFreeCoins, 100)
})

await t("前日の生成が日付をまたいで完了しても、プレミアムコインより先に今日の日次コインが使われる", async () => {
  await db.execute(
    `INSERT INTO coin_lots(user_id, coin_type, remaining, expires_at, created_at, updated_at) VALUES ('u9', 'PREMIUM', 50, NULL, $1, $1)`,
    [sec()],
  )
  await db.execute(`INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at) VALUES ('u9', 0, 50, $1)`, [sec()])
  await addSub("u9", "LITE", "paid", 10 * 86400)
  const r = await coins.consumeCoins({ db, userId: "u9", amount: 10 })
  assert.equal(r.ok, true)
  assert.equal(r.freeSpent, 10)
  assert.equal(r.premiumSpent, 0)
  assert.equal(await balance("u9"), 540)
})

await t("返却・管理付与のプレミアムコインは当日24:00で失効しない（フリーは当日まで）", async () => {
  await coins.applyCoinDelta({ db, userId: "u10", freeDelta: 5, premiumDelta: 10, kind: "GRANT", reason: "refund" })
  await coins.adminAdjustCoins({ db, userId: "u10", premiumDelta: 3, reason: "admin" })
  const lots = await db.query(`SELECT coin_type, remaining, expires_at FROM coin_lots WHERE user_id = 'u10' ORDER BY coin_type, remaining DESC`)
  assert.deepEqual(
    lots.map((l) => [l.coin_type, l.remaining, l.expires_at === null]),
    [["FREE", 5, false], ["PREMIUM", 10, true], ["PREMIUM", 3, true]],
  )
  fakeNow += 86400 * 1000
  await coins.expireAvailableCoins(db, "u10", sec())
  const s = await coins.getCoinSummary(db, "u10", {})
  assert.equal(s.premiumBalance, 13)
  assert.equal(s.freeBalance, 0)
})

await t("累計の順位: 多い人の数 + 1。0 なら順位なし。運営アカウントは貢献の順位から除く", async () => {
  const { getSupportSummary, getSupportTotals, CONTRIBUTION_RANKING_EXCLUDED_USER_ID: staff } = await import(`${API}/lib/coin-support.ts`)
  const put = (user: string, sent: number, received: number) =>
    db.execute(
      `INSERT INTO coin_support_totals (user_id, sent_pt_total, received_pt_total, sent_coin_total, received_coin_total, updated_at)
       VALUES ($1, $2, $3, 0, 0, 0)`,
      [user, sent, received],
    )
  await put("r1", 1000, 10)
  await put("r2", 500, 300)
  await put("r3", 0, 200)
  await put(staff, 99999, 0)
  const r1 = await getSupportSummary({ db, userId: "r1" })
  assert.equal(Number(r1.cumulativeSentRank), 1) // 運営は数えない
  assert.equal(Number(r1.cumulativeReceivedRank), 3)
  const r3 = await getSupportSummary({ db, userId: "r3" })
  assert.equal(r3.cumulativeSentRank, null) // 貢献していない
  assert.equal(Number(r3.cumulativeReceivedRank), 2)
  assert.equal((await getSupportSummary({ db, userId: staff })).cumulativeSentRank, null)
  assert.equal((await getSupportSummary({ db, userId: "none" })).cumulativeReceivedRank, null)
  assert.deepEqual(await getSupportTotals({ db, userId: "r2" }), { cumulativeSentPt: 500, cumulativeReceivedPt: 300 })
  assert.deepEqual(await getSupportTotals({ db, userId: "none" }), { cumulativeSentPt: 0, cumulativeReceivedPt: 0 })
})

const { getGeminiAllowance } = await import(`${API}/lib/gemini-allowance.ts`)
const grantPremium = (u: string, n: number) => coins.applyCoinDelta({ db, userId: u, freeDelta: 0, premiumDelta: n, kind: "GRANT", reason: "test" })

await t("Gemini の枠: 適用前はフリーコインから使え、その分は枠に数えない", async () => {
  fakeNow = Date.parse("2026-11-02T23:00:00+09:00")
  await addSub("g1", "LITE", "paid", 40 * 86400)
  await coins.ensureInitialCoinGrant({ db, userId: "g1", planType: "LITE" })
  for (let i = 0; i < 6; i++) {
    const r = await coins.consumeCoins({ db, userId: "g1", amount: 50, reason: "image-generation:gemini-2.5-flash-image" })
    assert.equal(r.freeSpent, 50)
  }
  const a = await getGeminiAllowance({ db, userId: "g1" })
  assert.equal(a.isEnforced, false)
  fakeNow = Date.parse("2026-11-03T00:00:10+09:00")
  const b = await getGeminiAllowance({ db, userId: "g1" })
  assert.equal(b.isEnforced, true)
  assert.equal(b.used, 0)
  assert.equal(b.remaining, 250)
})

await t("Gemini の枠: 枠を超えた分だけプレミアムコインを使い、足りなければ失敗して何も減らない", async () => {
  fakeNow = Date.parse("2026-11-09T00:00:10+09:00")
  await addSub("g2", "STANDARD", "paid", 40 * 86400)
  await coins.ensureInitialCoinGrant({ db, userId: "g2", planType: "STANDARD" })
  await grantPremium("g2", 120)
  const reason = "image-generation:gemini-2.5-flash-image"
  const nb2 = "image-generation:gemini-3.1-flash-image-preview"
  // 週の枠 1000 のうち 950 まで使う（毎日のフリーコインが足りるように日をまたぐ）
  for (let day = 0; day < 2; day++) {
    fakeNow = Date.parse(`2026-11-${String(9 + day).padStart(2, "0")}T12:00:00+09:00`)
    await coins.ensureInitialCoinGrant({ db, userId: "g2", planType: "STANDARD" })
    await coins.applyCoinDelta({ db, userId: "g2", freeDelta: 1000, premiumDelta: 0, kind: "GRANT", reason: "test" })
    for (let i = 0; i < (day === 0 ? 10 : 9); i++) {
      const r = await coins.consumeCoins({ db, userId: "g2", amount: 50, reason })
      assert.deepEqual([r.freeSpent, r.premiumSpent], [50, 0])
    }
  }
  assert.equal((await getGeminiAllowance({ db, userId: "g2" })).remaining, 50)
  // 枠が 50 残っているところに 100 コイン: 50 はフリー、50 はプレミアム
  const mixed = await coins.consumeCoins({ db, userId: "g2", amount: 100, reason: nb2 })
  assert.deepEqual([mixed.freeSpent, mixed.premiumSpent], [50, 50])
  assert.equal((await getGeminiAllowance({ db, userId: "g2" })).remaining, 0)
  // 枠を使い切ったあとはプレミアムのみ。フリーコインが残っていても使わない
  const paid = await coins.consumeCoins({ db, userId: "g2", amount: 50, reason })
  assert.deepEqual([paid.freeSpent, paid.premiumSpent], [0, 50])
  const before = await coins.getCoinSummary(db, "g2", {})
  assert.ok(before.freeBalance > 0)
  assert.equal(before.premiumBalance, 20)
  const short = await coins.consumeCoins({ db, userId: "g2", amount: 50, reason })
  assert.equal(short.ok, false)
  const after = await coins.getCoinSummary(db, "g2", {})
  assert.deepEqual([after.freeBalance, after.premiumBalance], [before.freeBalance, 20])
  // 普通のモデルはフリーコインで今までどおり作れる
  const sd = await coins.consumeCoins({ db, userId: "g2", amount: 40, reason: "image-generation:standard" })
  assert.deepEqual([sd.freeSpent, sd.premiumSpent], [40, 0])
})

await t("Gemini の枠: 月曜 0 時（日本時間）に戻り、プランごとの量になる", async () => {
  fakeNow = Date.parse("2026-11-15T23:59:00+09:00") // 日曜
  await addSub("g3", "PREMIUM", "paid", 40 * 86400)
  await addSub("g4", "LITE", "paid", 40 * 86400)
  assert.equal((await getGeminiAllowance({ db, userId: "g3" })).weeklyLimit, 2000)
  assert.equal((await getGeminiAllowance({ db, userId: "g4" })).weeklyLimit, 250)
  assert.equal((await getGeminiAllowance({ db, userId: "nobody" })).weeklyLimit, 0)
  await coins.ensureInitialCoinGrant({ db, userId: "g3", planType: "PREMIUM" })
  await coins.consumeCoins({ db, userId: "g3", amount: 100, reason: "image-generation:gemini-3.1-flash-image-preview" })
  const sunday = await getGeminiAllowance({ db, userId: "g3" })
  assert.equal(sunday.used, 100)
  assert.equal(sunday.resetsAt, Date.parse("2026-11-16T00:00:00+09:00") / 1000)
  fakeNow = Date.parse("2026-11-16T00:00:05+09:00") // 月曜
  const a = await getGeminiAllowance({ db, userId: "g3" })
  assert.equal(a.used, 0)
  assert.equal(a.remaining, 2000)
  assert.equal(a.resetsAt, Date.parse("2026-11-23T00:00:00+09:00") / 1000)
})

console.log(`\n${passed} passed`)
await d1.dispose()
process.exit(0)
