// 日次コイン（プラン別の生成用フリーコイン）の付与・失効
//
// - 付与: JST の日付ごとに 1 ユーザ 1 回。プラン額（FREE 100 / LITE 500 / STANDARD 1000 / PREMIUM 2000）に
//   届くまで付与する（日中に上位プランへ変わったら差額だけ追加。下位に変わっても追加しない）。
//   有料プランの契約者には毎日 00:00 JST の定期ジョブで付与し、無料ユーザは従来どおり初回アクセス時に付与する。
// - 失効: 日次コインはその日の 24:00 JST に失効する。定期ジョブで全ユーザ分をまとめて失効させる
//   （アクセス時にも念のため失効処理を行う）。
// - 付与・失効・消費はユーザごとのロック（db.lockedQuery）で直列化し、同時アクセスでの二重付与・二重失効を防ぐ。
// - 定期ジョブで発生した付与・失効のお知らせは coin_pending_events に貯め、次の ensure-initial-grant で 1 回だけ返す。
import { coinLockKey } from "./db"

export type CoinPlanType = "FREE" | "LITE" | "STANDARD" | "PREMIUM"

export type CoinEvent = {
  kind: "GRANT" | "CONSUME" | "EXPIRE"
  message: string
  freeCoins: number
  premiumCoins: number
}

type Db = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
  queryOne<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | null>
  execute(text: string, params?: unknown[]): Promise<void>
  lockedQuery<T = Record<string, unknown>>(lockKeys: string[], text: string, params?: unknown[]): Promise<T[]>
  lockedQueryOne<T = Record<string, unknown>>(lockKeys: string[], text: string, params?: unknown[]): Promise<T | null>
}

export const dailyFreeCoinsByPlan: Record<CoinPlanType, number> = {
  FREE: 100,
  LITE: 500,
  STANDARD: 1000,
  PREMIUM: 2000,
}

const planRank: Record<CoinPlanType, number> = { FREE: 0, LITE: 1, STANDARD: 2, PREMIUM: 3 }

export const toPlanType = (value: unknown): CoinPlanType => {
  return value === "LITE" || value === "STANDARD" || value === "PREMIUM" ? value : "FREE"
}

export const higherPlan = (a: CoinPlanType, b: CoinPlanType): CoinPlanType => (planRank[a] >= planRank[b] ? a : b)

// 更新日の決済（Stripe は期間終了の少し後に請求する）で一時的にプラン無しに見える間も、プラン扱いにする猶予。
// 解約予約（cancellation_requested）・解約済みには付けない。
export const RENEWAL_GRACE_SECONDS = 36 * 60 * 60

const tokyoDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

export const jstDateKey = (unixSeconds: number) => tokyoDate.format(new Date(unixSeconds * 1000))

// その日の 24:00 JST（= 翌日 00:00 JST）の unix 秒
export const jstEndOfDay = (unixSeconds: number) => {
  const [y, m, d] = jstDateKey(unixSeconds).split("-").map(Number)
  return Date.UTC(y, m - 1, d) / 1000 - 9 * 3600 + 24 * 3600
}

// 1 日分の付与記録のキー。旧実装の "daily_generation_access:<日付>" / "...:<プラン>" も同じ接頭辞なので合算できる
export const dailyGrantKeyPrefix = (unixSeconds: number) => `daily_generation_access:${jstDateKey(unixSeconds)}`
export const dailyGrantKey = (unixSeconds: number) => `${dailyGrantKeyPrefix(unixSeconds)}:DAILY`

const SUBSCRIPTION_PLAN_SQL = `
  SELECT DISTINCT ON (user_id) user_id, type
    FROM subscriptions
   WHERE is_disabled = FALSE
     AND status <> 'canceled'
     AND type IN ('LITE', 'STANDARD', 'PREMIUM')
     AND (
       current_period_end > $2
       OR (status <> 'cancellation_requested' AND current_period_end + $3 > $2)
     )
     AND ($1::text[] IS NULL OR user_id = ANY($1::text[]))
   ORDER BY user_id,
            CASE type WHEN 'PREMIUM' THEN 3 WHEN 'STANDARD' THEN 2 WHEN 'LITE' THEN 1 ELSE 0 END DESC,
            current_period_end DESC`

// サーバ側の契約情報からプランを決める。呼び出し元が渡したプランとの高い方を使う
// （呼び出し元の一時的な取得失敗で FREE 扱いになり、プラン分とは別に無料分が付く問題を防ぐ）
export const resolveCoinPlanType = async (db: Db, userId: string, callerPlan: unknown, now: number) => {
  const row = await db.queryOne<{ type: string }>(SUBSCRIPTION_PLAN_SQL, [[userId], now, RENEWAL_GRACE_SECONDS])
  return higherPlan(toPlanType(callerPlan), toPlanType(row?.type))
}

const grantMessageSql = (freeExpr: string) =>
  `'フリーコイン' || ${freeExpr} || '枚が付与されました。有効期限は本日24:00です。'`

const expireMessageSql = (freeExpr: string, premiumExpr: string) => `'有効期限を過ぎたため、' || concat_ws('、',
    CASE WHEN ${freeExpr} > 0 THEN 'フリーコイン' || ${freeExpr} || '枚' END,
    CASE WHEN ${premiumExpr} > 0 THEN 'プレミアムコイン' || ${premiumExpr} || '枚' END) || 'が失効しました。'`

// 指定ユーザ群に「今日の日次コイン」をプラン額まで付与する（1 文・ロック付き）。
// recordPendingEvents=true のときはお知らせを coin_pending_events に残す（定期ジョブ用）。
export const grantDailyCoinsBatch = async (props: {
  db: Db
  entries: Array<{ userId: string; planType: CoinPlanType }>
  now: number
  source: string
  recordPendingEvents: boolean
}) => {
  if (props.entries.length === 0) {
    return [] as Array<{ user_id: string; free_delta: number }>
  }
  const users = props.entries.map((e) => e.userId)
  const plans = props.entries.map((e) => e.planType)
  const targets = props.entries.map((e) => dailyFreeCoinsByPlan[e.planType])
  return props.db.lockedQuery<{ user_id: string; free_delta: number }>(
    users.map(coinLockKey),
    `WITH input AS (
        SELECT * FROM unnest($1::text[], $2::text[], $3::int[]) AS t(user_id, plan_type, target)
      ),
      today AS (
        SELECT i.user_id, i.plan_type, i.target,
               COALESCE((
                 SELECT SUM(g.free_coins)
                   FROM coin_grants g
                  WHERE g.user_id = i.user_id
                    AND left(g.grant_key, length($4)) = $4
               ), 0)::INTEGER AS granted
          FROM input i
      ),
      pos AS (
        SELECT user_id, plan_type, GREATEST(target - granted, 0)::INTEGER AS free_delta
          FROM today
         WHERE target > granted
      ),
      upsert_grant AS (
        INSERT INTO coin_grants(user_id, grant_key, plan_type, free_coins, premium_coins, created_at)
        SELECT user_id, $5, plan_type, free_delta, 0, $6 FROM pos
        ON CONFLICT (user_id, grant_key) DO UPDATE SET
          plan_type = EXCLUDED.plan_type,
          free_coins = coin_grants.free_coins + EXCLUDED.free_coins
      ),
      balance AS (
        INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        SELECT user_id, free_delta, 0, $6 FROM pos
        ON CONFLICT (user_id) DO UPDATE SET
          free_balance = coin_balances.free_balance + EXCLUDED.free_balance,
          updated_at = EXCLUDED.updated_at
      ),
      lots AS (
        INSERT INTO coin_lots(user_id, coin_type, remaining, expires_at, created_at, updated_at)
        SELECT user_id, 'FREE', free_delta, $7, $6, $6 FROM pos
      ),
      ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT user_id, 'FREE', free_delta, 'INITIAL_GRANT', plan_type || ' daily generation coin grant', $8, $6, $7
          FROM pos
      ),
      events AS (
        INSERT INTO coin_pending_events(user_id, kind, message, free_coins, premium_coins, created_at)
        SELECT user_id, 'GRANT', ${grantMessageSql("free_delta")}, free_delta, 0, $6
          FROM pos
         WHERE $9::boolean
      )
      SELECT user_id, free_delta FROM pos`,
    [users, plans, targets, dailyGrantKeyPrefix(props.now), dailyGrantKey(props.now), props.now, jstEndOfDay(props.now), props.source, props.recordPendingEvents],
  )
}

// 指定ユーザ群の期限切れコインを失効させる（1 文・ロック付き）。
// お知らせは直近 26 時間以内に期限が来たものだけ（長く放置されていた古い失効でお知らせを出さない）
export const expireCoinsBatch = async (props: { db: Db; userIds: string[]; now: number; recordPendingEvents: boolean }) => {
  if (props.userIds.length === 0) {
    return [] as Array<{ user_id: string; expired_free: number; expired_premium: number }>
  }
  return props.db.lockedQuery<{ user_id: string; expired_free: number; expired_premium: number }>(
    props.userIds.map(coinLockKey),
    `WITH expired AS (
        SELECT id, user_id, coin_type, remaining, expires_at
          FROM coin_lots
         WHERE user_id = ANY($1::text[])
           AND remaining > 0
           AND expires_at IS NOT NULL
           AND expires_at <= $2
      ),
      updated_lots AS (
        UPDATE coin_lots SET remaining = 0, updated_at = $2
         WHERE id IN (SELECT id FROM expired)
      ),
      sums AS (
        SELECT user_id,
               SUM(CASE WHEN coin_type = 'FREE' THEN remaining ELSE 0 END)::INTEGER AS expired_free,
               SUM(CASE WHEN coin_type = 'PREMIUM' THEN remaining ELSE 0 END)::INTEGER AS expired_premium,
               bool_or(expires_at > $2 - 93600) AS is_recent
          FROM expired
         GROUP BY user_id
      ),
      updated_balance AS (
        UPDATE coin_balances b
           SET free_balance = GREATEST(b.free_balance - s.expired_free, 0),
               premium_balance = GREATEST(b.premium_balance - s.expired_premium, 0),
               updated_at = $2
          FROM sums s
         WHERE b.user_id = s.user_id
      ),
      free_ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT user_id, 'FREE', -expired_free, 'EXPIRE', 'Daily coin expiration', 'expiration', $2, NULL
          FROM sums WHERE expired_free > 0
      ),
      premium_ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT user_id, 'PREMIUM', -expired_premium, 'EXPIRE', 'Daily coin expiration', 'expiration', $2, NULL
          FROM sums WHERE expired_premium > 0
      ),
      events AS (
        INSERT INTO coin_pending_events(user_id, kind, message, free_coins, premium_coins, created_at)
        SELECT user_id, 'EXPIRE', ${expireMessageSql("expired_free", "expired_premium")}, expired_free, expired_premium, $2
          FROM sums
         WHERE $3::boolean AND is_recent AND (expired_free > 0 OR expired_premium > 0)
      )
      SELECT user_id, expired_free, expired_premium FROM sums`,
    [props.userIds, props.now, props.recordPendingEvents],
  )
}

// 定期ジョブで貯めたお知らせを 1 回だけ取り出す（古すぎるものは配らずに既読にする）
export const takePendingCoinEvents = async (db: Db, userId: string, now: number): Promise<CoinEvent[]> => {
  const rows = await db.query<{
    id: number
    kind: CoinEvent["kind"]
    message: string
    free_coins: number
    premium_coins: number
    created_at: number
  }>(
    `UPDATE coin_pending_events
        SET delivered_at = $2
      WHERE user_id = $1 AND delivered_at IS NULL
      RETURNING id, kind, message, free_coins, premium_coins, created_at`,
    [userId, now],
  )
  return rows
    .filter((r) => Number(r.created_at) > now - 48 * 3600)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((r) => ({ kind: r.kind, message: r.message, freeCoins: r.free_coins, premiumCoins: r.premium_coins }))
}

const chunk = <T>(items: T[], size: number) => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

// 毎日 00:00 JST の定期ジョブ: 全ユーザの期限切れコインを失効 → 有料プラン契約者に今日の日次コインを付与。
// 何度実行しても結果は同じ（失効済み・付与済みのものは対象にならない）ので、失敗時は再実行してよい。
export const runDailyCoinJob = async (db: Db, now: number) => {
  const startedAt = Date.now()
  const jobKey = `daily:${jstDateKey(now)}`
  await db.execute(
    `INSERT INTO coin_job_runs(job_key, started_at) VALUES ($1, $2)
     ON CONFLICT (job_key) DO UPDATE SET started_at = EXCLUDED.started_at, finished_at = NULL`,
    [jobKey, now],
  )

  let expiredUsers = 0
  let expiredFree = 0
  let expiredPremium = 0
  for (let round = 0; round < 200; round++) {
    const users = await db.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM coin_lots
        WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at <= $1
        LIMIT 200`,
      [now],
    )
    if (users.length === 0) {
      break
    }
    const rows = await expireCoinsBatch({ db, userIds: users.map((u) => u.user_id), now, recordPendingEvents: true })
    expiredUsers += rows.length
    for (const r of rows) {
      expiredFree += r.expired_free
      expiredPremium += r.expired_premium
    }
  }

  const subscribers = await db.query<{ user_id: string; type: string }>(SUBSCRIPTION_PLAN_SQL, [
    null,
    now,
    RENEWAL_GRACE_SECONDS,
  ])
  let grantedUsers = 0
  let grantedFree = 0
  for (const part of chunk(subscribers, 100)) {
    const rows = await grantDailyCoinsBatch({
      db,
      entries: part.map((s) => ({ userId: s.user_id, planType: toPlanType(s.type) })),
      now,
      source: "daily_job",
      recordPendingEvents: true,
    })
    grantedUsers += rows.length
    for (const r of rows) {
      grantedFree += r.free_delta
    }
  }

  await db.execute(`DELETE FROM coin_pending_events WHERE created_at < $1`, [now - 7 * 24 * 3600])

  const result = {
    jobKey,
    expiredUsers,
    expiredFree,
    expiredPremium,
    subscribers: subscribers.length,
    grantedUsers,
    grantedFree,
    elapsedMs: Date.now() - startedAt,
  }
  await db.execute(`UPDATE coin_job_runs SET finished_at = $2, result = $3 WHERE job_key = $1`, [
    jobKey,
    Math.floor(Date.now() / 1000),
    JSON.stringify(result),
  ])
  return result
}
