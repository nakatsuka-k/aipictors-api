// 日次コイン（プラン別の生成用フリーコイン）の付与・失効
//
// - 付与: JST の日付ごとに 1 ユーザ 1 回。プラン額（FREE 100 / LITE 500 / STANDARD 1000 / PREMIUM 2000）に
//   届くまで付与する（日中に上位プランへ変わったら差額だけ追加。下位に変わっても追加しない）。
//   有料プランの契約者には毎日 00:00 JST の定期ジョブで付与し、無料ユーザは従来どおり初回アクセス時に付与する。
// - 失効: 日次コインはその日の 24:00 JST に失効する。定期ジョブで全ユーザ分をまとめて失効させる
//   （アクセス時にも念のため失効処理を行う）。
// - 付与・失効・消費は D1 の batch（1 つのトランザクション）で書く。D1 は書き込みを 1 本ずつ順に実行するので、
//   同時アクセスでも二重付与・二重失効にならない。
// - 定期ジョブで発生した付与・失効のお知らせは coin_pending_events に貯め、次の ensure-initial-grant で 1 回だけ返す。

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
  batch(statements: Array<{ text: string; params?: unknown[] }>): Promise<Array<{ rows: any[]; changes: number }>>
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
  SELECT user_id, type FROM (
  SELECT user_id, type,
         ROW_NUMBER() OVER (
           PARTITION BY user_id
           ORDER BY CASE type WHEN 'PREMIUM' THEN 3 WHEN 'STANDARD' THEN 2 WHEN 'LITE' THEN 1 ELSE 0 END DESC,
                    current_period_end DESC
         ) AS rn
    FROM subscriptions
   WHERE is_disabled = FALSE
     AND status <> 'canceled'
     AND type IN ('LITE', 'STANDARD', 'PREMIUM')
     AND (
       current_period_end > $2
       OR (status <> 'cancellation_requested' AND current_period_end + $3 > $2)
     )
     AND ($1 IS NULL OR user_id IN (SELECT value FROM json_each($1)))
  ) WHERE rn = 1
   ORDER BY user_id`

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
  const input = JSON.stringify(props.entries.map((e, index) => ({ u: users[index], p: plans[index], t: targets[index] })))
  // 付与する量（pos）は「書く前の coin_grants」から計算するので、coin_grants の更新を最後にする（同じトランザクション内）
  const posSql = `SELECT user_id, plan_type, max(target - granted, 0) AS free_delta
      FROM (
        SELECT i.user_id, i.plan_type, i.target,
               COALESCE((
                 SELECT SUM(g.free_coins)
                   FROM coin_grants g
                  WHERE g.user_id = i.user_id
                    AND substr(g.grant_key, 1, length($4)) = $4
               ), 0) AS granted
          FROM (
            SELECT json_extract(value, '$.u') AS user_id,
                   json_extract(value, '$.p') AS plan_type,
                   json_extract(value, '$.t') AS target
              FROM json_each($1)
          ) AS i
      )
     WHERE target > granted`
  const params = [input, null, null, dailyGrantKeyPrefix(props.now), dailyGrantKey(props.now), props.now, jstEndOfDay(props.now), props.source, props.recordPendingEvents]
  const results = await props.db.batch([
    { text: posSql, params },
    {
      text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        SELECT user_id, free_delta, 0, $6 FROM (${posSql}) WHERE true
        ON CONFLICT (user_id) DO UPDATE SET
          free_balance = coin_balances.free_balance + EXCLUDED.free_balance,
          updated_at = EXCLUDED.updated_at`,
      params
    },
    {
      text: `INSERT INTO coin_lots(user_id, coin_type, remaining, expires_at, created_at, updated_at)
        SELECT user_id, 'FREE', free_delta, $7, $6, $6 FROM (${posSql})`,
      params
    },
    {
      text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT user_id, 'FREE', free_delta, 'INITIAL_GRANT', plan_type || ' daily generation coin grant', $8, $6, $7
          FROM (${posSql})`,
      params
    },
    {
      text: `INSERT INTO coin_pending_events(user_id, kind, message, free_coins, premium_coins, created_at)
        SELECT user_id, 'GRANT', ${grantMessageSql("free_delta")}, free_delta, 0, $6
          FROM (${posSql})
         WHERE $9`,
      params
    },
    {
      text: `INSERT INTO coin_grants(user_id, grant_key, plan_type, free_coins, premium_coins, created_at)
        SELECT user_id, $5, plan_type, free_delta, 0, $6 FROM (${posSql}) WHERE true
        ON CONFLICT (user_id, grant_key) DO UPDATE SET
          plan_type = EXCLUDED.plan_type,
          free_coins = coin_grants.free_coins + EXCLUDED.free_coins`,
      params
    }
  ])
  return results[0].rows as Array<{ user_id: string; free_delta: number }>
}

// 指定ユーザ群の期限切れコインを失効させる（1 文・ロック付き）。
// お知らせは直近 26 時間以内に期限が来たものだけ（長く放置されていた古い失効でお知らせを出さない）
export const expireCoinsBatch = async (props: { db: Db; userIds: string[]; now: number; recordPendingEvents: boolean }) => {
  if (props.userIds.length === 0) {
    return [] as Array<{ user_id: string; expired_free: number; expired_premium: number }>
  }
  const expiredSql = `SELECT id, user_id, coin_type, remaining, expires_at
          FROM coin_lots
         WHERE user_id IN (SELECT value FROM json_each($1))
           AND remaining > 0
           AND expires_at IS NOT NULL
           AND expires_at <= $2`
  const sumsSql = `SELECT user_id,
               SUM(CASE WHEN coin_type = 'FREE' THEN remaining ELSE 0 END) AS expired_free,
               SUM(CASE WHEN coin_type = 'PREMIUM' THEN remaining ELSE 0 END) AS expired_premium,
               max(expires_at > $2 - 93600) AS is_recent
          FROM (${expiredSql})
         GROUP BY user_id`
  const params = [props.userIds, props.now, props.recordPendingEvents]
  // 台帳・残高・お知らせは失効前のロットから計算し、ロットの更新を最後にする（同じトランザクション内）
  const results = await props.db.batch([
    { text: `SELECT user_id, expired_free, expired_premium FROM (${sumsSql})`, params },
    {
      text: `UPDATE coin_balances AS b
           SET free_balance = max(b.free_balance - s.expired_free, 0),
               premium_balance = max(b.premium_balance - s.expired_premium, 0),
               updated_at = $2
          FROM (${sumsSql}) AS s
         WHERE b.user_id = s.user_id`,
      params
    },
    {
      text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT user_id, 'FREE', -expired_free, 'EXPIRE', 'Daily coin expiration', 'expiration', $2, NULL
          FROM (${sumsSql}) WHERE expired_free > 0`,
      params
    },
    {
      text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT user_id, 'PREMIUM', -expired_premium, 'EXPIRE', 'Daily coin expiration', 'expiration', $2, NULL
          FROM (${sumsSql}) WHERE expired_premium > 0`,
      params
    },
    {
      text: `INSERT INTO coin_pending_events(user_id, kind, message, free_coins, premium_coins, created_at)
        SELECT user_id, 'EXPIRE', ${expireMessageSql("expired_free", "expired_premium")}, expired_free, expired_premium, $2
          FROM (${sumsSql})
         WHERE $3 AND is_recent AND (expired_free > 0 OR expired_premium > 0)`,
      params
    },
    {
      text: `UPDATE coin_lots SET remaining = 0, updated_at = $2
         WHERE id IN (SELECT id FROM (${expiredSql}))`,
      params
    }
  ])
  return results[0].rows as Array<{ user_id: string; expired_free: number; expired_premium: number }>
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
