// aipictors-api の日次コイン処理を本物の Postgres で検証する（同時実行を含む）
import EmbeddedPostgres from "embedded-postgres"
import pg from "pg"
import assert from "node:assert/strict"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { schemaStatements } = await import(`${API}/lib/db.ts`)
const coins = await import(`${API}/lib/coins.ts`)
const daily = await import(`${API}/lib/daily-coins.ts`)

const dir = `/tmp/coin-test-pg-${process.pid}`
const epg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: 54329, persistent: false })
await epg.initialise()
await epg.start()
await epg.createDatabase("t")
const pool = new pg.Pool({ connectionString: "postgres://postgres:pw@127.0.0.1:54329/t", max: 40 })
pg.types.setTypeParser(20, (v) => Number(v)) // BIGINT を number に（neon と同じ扱い）

const db = {
  async query(text: string, params: unknown[] = []) {
    return (await pool.query(text, params)).rows
  },
  async queryOne(text: string, params: unknown[] = []) {
    return (await pool.query(text, params)).rows[0] ?? null
  },
  async execute(text: string, params: unknown[] = []) {
    await pool.query(text, params)
  },
  async executeResult(text: string, params: unknown[] = []) {
    return { rowCount: (await pool.query(text, params)).rowCount ?? 0 }
  },
  async lockedQuery(keys: string[], text: string, params: unknown[] = []) {
    const c = await pool.connect()
    try {
      await c.query("BEGIN ISOLATION LEVEL READ COMMITTED")
      await c.query(
        `SELECT pg_advisory_xact_lock(h)
           FROM (SELECT DISTINCT hashtextextended(k, 0) AS h FROM unnest($1::text[]) AS k ORDER BY h) AS ordered`,
        [[...new Set(keys)]],
      )
      const r = await c.query(text, params)
      await c.query("COMMIT")
      return r.rows
    } catch (e) {
      await c.query("ROLLBACK")
      throw e
    } finally {
      c.release()
    }
  },
  async lockedQueryOne(keys: string[], text: string, params: unknown[] = []) {
    return (await this.lockedQuery(keys, text, params))[0] ?? null
  },
}
for (const s of schemaStatements) await db.execute(s)

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
     VALUES ($1, $2, $3, $4, FALSE, $5, $5, $6, $1)`,
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
  assert.ok(expireTimes.every((r: { created_at: number }) => r.created_at === sec()))
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

console.log(`\n${passed} passed`)
await pool.end()
await epg.stop()
process.exit(0)
