// カード登録なしの「ライト1日体験」を D1（Miniflare）で検証する
import assert from "node:assert/strict"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const coins = await import(`${API}/lib/coins.ts`)
const trial = await import(`${API}/lib/lite-day-trial.ts`)

const d1 = await createTestD1()
const db = d1.db
const env = { LITE_DAY_TRIAL: "1" }

let fakeNow = Date.parse("2026-11-22T15:00:00+09:00")
Date.now = () => fakeNow
const sec = () => Math.floor(fakeNow / 1000)

const balance = async (u: string) => (await coins.getCoinSummary(db, u, {})).totalBalance
const addSub = (u: string, type: string) =>
  db.execute(
    `INSERT INTO subscriptions(nanoid, user_id, type, status, is_disabled, created_at, current_period_start, current_period_end, stripe_subscription_id)
     VALUES ($1, $2, $3, 'paid', 0, $4, $4, $5, $1)`,
    [`sub_${u}_${type}`, u, type, sec() - 86400, sec() + 20 * 86400],
  )

let passed = 0
const t = async (name: string, fn: () => Promise<void>) => {
  await fn()
  passed++
  console.log(`ok  ${name}`)
}

await t("無料ユーザは始められ、今日の無料 100 枚にライトとの差額 400 枚が足される", async () => {
  await coins.ensureInitialCoinGrant({ db, userId: "u1", planType: "FREE" })
  assert.equal((await trial.getLiteDayTrial(db, env, "u1", sec())).status, "available")
  const r = await trial.startLiteDayTrial({ db, env, userId: "u1", source: "shortage", now: sec() })
  assert.equal(r.error, null)
  assert.equal(r.trial.status, "active")
  assert.equal(r.trial.trialDate, "2026-11-22")
  assert.equal(r.trial.endsAt, Date.parse("2026-11-23T00:00:00+09:00") / 1000)
  assert.equal(await balance("u1"), 500)
})

await t("同時に 10 回押しても 1 回分（差額 400 枚）だけ", async () => {
  await coins.ensureInitialCoinGrant({ db, userId: "u2", planType: "FREE" })
  const rs = await Promise.all(
    Array.from({ length: 10 }, () => trial.startLiteDayTrial({ db, env, userId: "u2", now: sec() })),
  )
  assert.ok(rs.every((r) => r.error === null && r.trial.status === "active"))
  assert.equal(await balance("u2"), 500)
  assert.equal((await db.query("SELECT * FROM lite_day_trials WHERE user_id = 'u2'")).length, 1)
})

await t("体験中に無料の扱いで呼ばれてもコインは減らない・増えない", async () => {
  await coins.ensureInitialCoinGrant({ db, userId: "u1", planType: "FREE" })
  assert.equal(await balance("u1"), 500)
})

await t("プランに入っている人は対象外", async () => {
  await addSub("u3", "LITE")
  const r = await trial.startLiteDayTrial({ db, env, userId: "u3", now: sec() })
  assert.equal(r.error, "HAS_PLAN")
  assert.equal((await db.query("SELECT * FROM lite_day_trials WHERE user_id = 'u3'")).length, 0)
})

await t("受け付けを止めると始められない", async () => {
  const r = await trial.startLiteDayTrial({ db, env: { LITE_DAY_TRIAL: "0" }, userId: "u4", now: sec() })
  assert.equal(r.error, "DISABLED")
})

await t("翌日は used になり、もう始められない（コインは無料の 100 枚に戻る）", async () => {
  fakeNow = Date.parse("2026-11-23T09:00:00+09:00")
  const s = await trial.getLiteDayTrial(db, env, "u1", sec())
  assert.equal(s.status, "used")
  assert.equal(s.trialDate, "2026-11-22")
  const r = await trial.startLiteDayTrial({ db, env, userId: "u1", now: sec() })
  assert.equal(r.error, "ALREADY_USED")
  const g = await coins.ensureInitialCoinGrant({ db, userId: "u1", planType: "FREE" })
  assert.equal(g.grantedFreeCoins, 100)
  assert.equal(await balance("u1"), 100)
})

await t("受け付けを止めても、使った人は used のまま見える", async () => {
  assert.equal((await trial.getLiteDayTrial(db, {}, "u1", sec())).status, "used")
})

console.log(`\n${passed} passed`)
await d1.dispose()
