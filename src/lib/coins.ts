// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { coinLockKey, getNow } from "./db"
import { grantDailyCoinsBatch, resolveCoinPlanType, takePendingCoinEvents } from "./daily-coins"
export var initialFreeCoinsByPlan = {
  FREE: 100,
  LITE: 500,
  STANDARD: 1e3,
  PREMIUM: 2e3
};
export var tokyoDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
export var dailyGrantKeyPrefix = "daily_generation_access:";
export var toCoinPlanType = (value) => {
  if (value === "LITE" || value === "STANDARD" || value === "PREMIUM") {
    return value;
  }
  return "FREE";
};
export var getJstExpirationAt = (unixSeconds) => {
  const parts = tokyoDateFormatter.formatToParts(new Date(unixSeconds * 1e3));
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "1970");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "01");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "01");
  const jstDayStartUtc = Date.UTC(year, month - 1, day, 0, 0, 0) / 1e3 - 9 * 60 * 60;
  return jstDayStartUtc + 24 * 60 * 60;
};
export var getJstDateKey = (unixSeconds) => {
  return tokyoDateFormatter.format(new Date(unixSeconds * 1e3));
};
export var formatJstDateTime = (unixSeconds) => {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(unixSeconds * 1e3));
};
export var formatCoinAmount = (freeCoins, premiumCoins) => {
  const parts = [];
  if (freeCoins > 0) {
    parts.push(`\u30D5\u30EA\u30FC\u30B3\u30A4\u30F3${freeCoins}\u679A`);
  }
  if (premiumCoins > 0) {
    parts.push(`\u30D7\u30EC\u30DF\u30A2\u30E0\u30B3\u30A4\u30F3${premiumCoins}\u679A`);
  }
  return parts.join("\u3001");
};
export var createGrantEvent = (freeCoins, premiumCoins, expiresAt) => ({
  kind: "GRANT",
  message: expiresAt === null ? `${formatCoinAmount(freeCoins, premiumCoins)}\u304C\u4ED8\u4E0E\u3055\u308C\u307E\u3057\u305F\u3002` : expiresAt === void 0 ? `${formatCoinAmount(freeCoins, premiumCoins)}\u304C\u4ED8\u4E0E\u3055\u308C\u307E\u3057\u305F\u3002\u6709\u52B9\u671F\u9650\u306F\u672C\u65E524:00\u3067\u3059\u3002` : `${formatCoinAmount(freeCoins, premiumCoins)}\u304C\u4ED8\u4E0E\u3055\u308C\u307E\u3057\u305F\u3002\u6709\u52B9\u671F\u9650\u306F${formatJstDateTime(expiresAt)}\u3067\u3059\u3002`,
  freeCoins,
  premiumCoins
});
export var createConsumeEvent = (freeCoins, premiumCoins) => ({
  kind: "CONSUME",
  message: `${formatCoinAmount(freeCoins, premiumCoins)}\u3092\u6D88\u8CBB\u3057\u307E\u3057\u305F\u3002`,
  freeCoins,
  premiumCoins
});
export var createExpireEvent = (freeCoins, premiumCoins) => ({
  kind: "EXPIRE",
  message: `\u6709\u52B9\u671F\u9650\u3092\u904E\u304E\u305F\u305F\u3081\u3001${formatCoinAmount(freeCoins, premiumCoins)}\u304C\u5931\u52B9\u3057\u307E\u3057\u305F\u3002`,
  freeCoins,
  premiumCoins
});
export var grantCoins = async (props) => {
  const freeCoins = Math.floor(Math.max(0, props.freeCoins));
  const premiumCoins = Math.floor(Math.max(0, props.premiumCoins));
  if (freeCoins === 0 && premiumCoins === 0) {
    return { freeGranted: 0, premiumGranted: 0 };
  }
  const expiresAt = props.expiresAt === void 0 ? getJstExpirationAt(props.now) : props.expiresAt;
  // プレミアムコインは日次失効させない（返却・管理付与で当日24:00期限になっていた）。期限を明示したときだけ使う
  const premiumExpiresAt = props.expiresAt === void 0 ? null : props.expiresAt;
  await props.db.lockedQuery(
    [coinLockKey(props.userId)],
    `WITH ensured AS (
        INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        VALUES ($1, 0, 0, $4)
        ON CONFLICT (user_id) DO NOTHING
      ),
      updated_balance AS (
        UPDATE coin_balances
           SET free_balance = coin_balances.free_balance + $2,
               premium_balance = coin_balances.premium_balance + $3,
               updated_at = $4
         WHERE user_id = $1
      ),
      free_lot AS (
        INSERT INTO coin_lots(user_id, coin_type, remaining, expires_at, created_at, updated_at)
        SELECT $1, 'FREE', $2, $8, $4, $4
         WHERE $2 > 0
      ),
      premium_lot AS (
        INSERT INTO coin_lots(user_id, coin_type, remaining, expires_at, created_at, updated_at)
        SELECT $1, 'PREMIUM', $3, $9, $4, $4
         WHERE $3 > 0
      ),
      free_ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, 'FREE', $2, $5, $6, $7, $4, CASE WHEN $2 > 0 THEN $8 ELSE NULL END
         WHERE $2 <> 0
      ),
      premium_ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, 'PREMIUM', $3, $5, $6, $7, $4, CASE WHEN $3 > 0 THEN $9 ELSE NULL END
         WHERE $3 <> 0
      )
      SELECT 1`,
    [
      props.userId,
      freeCoins,
      premiumCoins,
      props.now,
      props.kind,
      props.reason ?? null,
      props.source ?? null,
      expiresAt,
      premiumExpiresAt
    ]
  );
  return {
    freeGranted: freeCoins,
    premiumGranted: premiumCoins
  };
};
export var reduceCoinTypeBalance = async (props) => {
  const amount = Math.floor(Math.max(0, props.amount));
  if (amount === 0) {
    return 0;
  }
  const balanceColumn = props.coinType === "FREE" ? "free_balance" : "premium_balance";
  const result = await props.db.lockedQueryOne(
    [coinLockKey(props.userId)],
    `WITH ensured AS (
        INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        VALUES ($1, 0, 0, $4)
        ON CONFLICT (user_id) DO NOTHING
      ),
      candidate_lots AS (
        SELECT id,
               remaining,
               SUM(remaining) OVER (
                 ORDER BY expires_at ASC NULLS LAST, id ASC
               ) AS running_total
          FROM coin_lots
         WHERE user_id = $1
           AND coin_type = $2
           AND remaining > 0
         ORDER BY expires_at ASC NULLS LAST, id ASC
      ),
      updates AS (
        SELECT id,
               LEAST(remaining, GREATEST($3 - (running_total - remaining), 0))::INTEGER AS spend
          FROM candidate_lots
         WHERE running_total - remaining < $3
      ),
      applied AS (
        UPDATE coin_lots
           SET remaining = coin_lots.remaining - updates.spend,
               updated_at = $4
          FROM updates
         WHERE coin_lots.id = updates.id
           AND updates.spend > 0
        RETURNING updates.spend
      ),
      spent_sum AS (
        SELECT COALESCE(SUM(spend), 0)::INTEGER AS spent
          FROM applied
      ),
      updated_balance AS (
        UPDATE coin_balances
           SET ${balanceColumn} = GREATEST(coin_balances.${balanceColumn} - (SELECT spent FROM spent_sum), 0),
               updated_at = $4
         WHERE user_id = $1
      ),
      ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, $2, -(SELECT spent FROM spent_sum), $5, $6, $7, $4, NULL
         WHERE (SELECT spent FROM spent_sum) > 0
      )
      SELECT spent
        FROM spent_sum`,
    [
      props.userId,
      props.coinType,
      amount,
      props.now,
      props.kind,
      props.reason ?? null,
      props.source ?? null
    ]
  );
  return result?.spent ?? 0;
};
export var expireAvailableCoins = async (db, userId, now) => {
  const result = await db.lockedQueryOne(
    [coinLockKey(userId)],
    `WITH expired AS (
        SELECT id, coin_type, remaining
          FROM coin_lots
         WHERE user_id = $1
           AND remaining > 0
           AND expires_at IS NOT NULL
           AND expires_at <= $2
      ),
      updated_lots AS (
        UPDATE coin_lots
           SET remaining = 0,
               updated_at = $2
         WHERE id IN (SELECT id FROM expired)
        RETURNING id
      ),
      sums AS (
        SELECT COALESCE(SUM(CASE WHEN coin_type = 'FREE' THEN remaining ELSE 0 END), 0)::INTEGER AS expired_free,
               COALESCE(SUM(CASE WHEN coin_type = 'PREMIUM' THEN remaining ELSE 0 END), 0)::INTEGER AS expired_premium
          FROM expired
      ),
      updated_balance AS (
        UPDATE coin_balances
           SET free_balance = GREATEST(coin_balances.free_balance - (SELECT expired_free FROM sums), 0),
               premium_balance = GREATEST(coin_balances.premium_balance - (SELECT expired_premium FROM sums), 0),
               updated_at = $2
         WHERE user_id = $1
           AND EXISTS (SELECT 1 FROM updated_lots)
        RETURNING user_id
      ),
      free_ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1,
               'FREE',
               -expired_free,
               'EXPIRE',
               'Daily coin expiration',
               'expiration',
               $2,
               NULL
          FROM sums
         WHERE expired_free > 0
      ),
      premium_ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1,
               'PREMIUM',
               -expired_premium,
               'EXPIRE',
               'Daily coin expiration',
               'expiration',
               $2,
               NULL
          FROM sums
         WHERE expired_premium > 0
      )
      SELECT expired_free, expired_premium
        FROM sums`,
    [userId, now]
  );
  const expiredFreeCoins = result?.expired_free ?? 0;
  const expiredPremiumCoins = result?.expired_premium ?? 0;
  return {
    expiredFreeCoins,
    expiredPremiumCoins,
    events: expiredFreeCoins > 0 || expiredPremiumCoins > 0 ? [createExpireEvent(expiredFreeCoins, expiredPremiumCoins)] : []
  };
};
export var syncCoinBalancesWithLots = async (db, userId, now) => {
  return db.queryOne(
    `WITH ensured AS (
        INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        VALUES ($1, 0, 0, $2)
        ON CONFLICT (user_id) DO NOTHING
      ),
      actual AS (
        SELECT COALESCE(SUM(CASE WHEN coin_type = 'FREE' THEN remaining ELSE 0 END), 0)::INTEGER AS free_balance,
               COALESCE(SUM(CASE WHEN coin_type = 'PREMIUM' THEN remaining ELSE 0 END), 0)::INTEGER AS premium_balance
          FROM coin_lots
         WHERE user_id = $1
           AND remaining > 0
      ),
      updated AS (
        UPDATE coin_balances
           SET free_balance = (SELECT free_balance FROM actual),
               premium_balance = (SELECT premium_balance FROM actual),
               updated_at = $2
         WHERE user_id = $1
        RETURNING free_balance, premium_balance
      )
      SELECT free_balance, premium_balance
        FROM updated`,
    [userId, now]
  );
};
export var fetchCoinSummary = async (db, userId, options) => {
  const balance = await syncCoinBalancesWithLots(db, userId, getNow());
  const ledgerLimit = Math.min(
    200,
    Math.max(1, Math.floor(options?.includeLedgerLimit ?? 100))
  );
  const ledgerOffset = Math.max(
    0,
    Math.floor(options?.includeLedgerOffset ?? 0)
  );
  const ledger = options?.includeLedger ? await db.query(
    `SELECT id,
                coin_type AS "coinType",
                delta,
                kind,
                reason,
                source,
                created_at AS "createdAt",
                expires_at AS "expiresAt"
           FROM coin_ledger
          WHERE user_id = $1
          ORDER BY id DESC
          LIMIT $2
         OFFSET $3`,
    [userId, ledgerLimit, ledgerOffset]
  ) : [];
  const expiringLots = options?.includeExpiringLots ? await db.query(
    `SELECT coin_type AS "coinType",
                SUM(remaining)::INTEGER AS amount,
                expires_at AS "expiresAt"
           FROM coin_lots
          WHERE user_id = $1
            AND remaining > 0
            AND expires_at IS NOT NULL
            AND expires_at > $2
          GROUP BY coin_type, expires_at
          ORDER BY expires_at ASC, coin_type ASC
          LIMIT 50`,
    [userId, getNow()]
  ) : [];
  const exchangeableBalance = await db.queryOne(
    `SELECT COALESCE(
              SUM(
                CASE
                  WHEN coin_type = 'PREMIUM' AND source_kind = 'SUPPORT'
                    THEN GREATEST(remaining - locked_amount, 0)
                  ELSE 0
                END
              ),
              0
            )::INTEGER AS exchangeable_premium_balance,
            COALESCE(
              SUM(
                CASE
                  WHEN coin_type = 'PREMIUM' AND source_kind = 'SUPPORT'
                    THEN locked_amount
                  ELSE 0
                END
              ),
              0
            )::INTEGER AS locked_exchange_premium_balance
       FROM coin_lots
      WHERE user_id = $1`,
    [userId]
  );
  const freeBalance = balance?.free_balance ?? 0;
  const premiumBalance = balance?.premium_balance ?? 0;
  return {
    freeBalance,
    premiumBalance,
    totalBalance: freeBalance + premiumBalance,
    exchangeablePremiumBalance: exchangeableBalance?.exchangeable_premium_balance ?? 0,
    lockedExchangePremiumBalance: exchangeableBalance?.locked_exchange_premium_balance ?? 0,
    ledger,
    expiringLots
  };
};
export var getCoinSummary = async (db, userId, options) => {
  const now = getNow();
  const expired = await expireAvailableCoins(db, userId, now);
  const summary = await fetchCoinSummary(db, userId, options);
  return {
    ...summary,
    expiredFreeCoins: expired.expiredFreeCoins,
    expiredPremiumCoins: expired.expiredPremiumCoins,
    events: expired.events
  };
};
export var getAdminCoinHistory = async (props) => {
  const userId = props.userId?.trim() ? props.userId.trim() : null;
  const from = typeof props.from === "number" && Number.isFinite(props.from) ? Math.floor(props.from) : null;
  const to = typeof props.to === "number" && Number.isFinite(props.to) ? Math.floor(props.to) : null;
  const offset = Math.max(0, Math.floor(props.offset ?? 0));
  const limit = Math.min(200, Math.max(1, Math.floor(props.limit ?? 100)));
  if (userId !== null) {
    await expireAvailableCoins(props.db, userId, getNow());
  }
  const items = await props.db.query(
    `WITH ranked AS (
       SELECT id,
              user_id AS "userId",
              coin_type AS "coinType",
              delta,
              kind,
              reason,
              source,
              created_at AS "createdAt",
              expires_at AS "expiresAt",
              SUM(CASE WHEN coin_type = 'FREE' THEN delta ELSE 0 END)
                OVER (
                  PARTITION BY user_id
                  ORDER BY created_at ASC, id ASC
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                )::INTEGER AS "runningFreeBalance",
              SUM(CASE WHEN coin_type = 'PREMIUM' THEN delta ELSE 0 END)
                OVER (
                  PARTITION BY user_id
                  ORDER BY created_at ASC, id ASC
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                )::INTEGER AS "runningPremiumBalance"
         FROM coin_ledger
        WHERE ($1::text IS NULL OR user_id = $1)
     )
     SELECT id,
            "userId",
            "coinType",
            delta,
            kind,
            reason,
            source,
            "createdAt",
            "expiresAt",
            "runningFreeBalance",
            "runningPremiumBalance",
            ("runningFreeBalance" + "runningPremiumBalance")::INTEGER AS "runningTotalBalance"
       FROM ranked
      WHERE ($2::bigint IS NULL OR "createdAt" >= $2)
        AND ($3::bigint IS NULL OR "createdAt" <= $3)
      ORDER BY "createdAt" DESC, id DESC
      LIMIT $4
     OFFSET $5`,
    [userId, from, to, limit, offset]
  );
  const countRow = await props.db.queryOne(
    `SELECT COUNT(*)::INTEGER AS count
       FROM coin_ledger
      WHERE ($1::text IS NULL OR user_id = $1)
        AND ($2::bigint IS NULL OR created_at >= $2)
        AND ($3::bigint IS NULL OR created_at <= $3)`,
    [userId, from, to]
  );
  const summary = await props.db.queryOne(
    `SELECT COUNT(DISTINCT user_id)::INTEGER AS matched_user_count,
            COALESCE(SUM(CASE WHEN coin_type = 'FREE' AND kind IN ('INITIAL_GRANT', 'GRANT') AND delta > 0 THEN delta ELSE 0 END), 0)::INTEGER AS free_granted_total,
            COALESCE(SUM(CASE WHEN coin_type = 'PREMIUM' AND kind IN ('INITIAL_GRANT', 'GRANT') AND delta > 0 THEN delta ELSE 0 END), 0)::INTEGER AS premium_granted_total,
            COALESCE(SUM(CASE WHEN coin_type = 'FREE' AND kind = 'CONSUME' AND delta < 0 THEN -delta ELSE 0 END), 0)::INTEGER AS free_consumed_total,
            COALESCE(SUM(CASE WHEN coin_type = 'PREMIUM' AND kind = 'CONSUME' AND delta < 0 THEN -delta ELSE 0 END), 0)::INTEGER AS premium_consumed_total,
            COALESCE(SUM(CASE WHEN coin_type = 'FREE' AND kind = 'EXPIRE' AND delta < 0 THEN -delta ELSE 0 END), 0)::INTEGER AS free_expired_total,
            COALESCE(SUM(CASE WHEN coin_type = 'PREMIUM' AND kind = 'EXPIRE' AND delta < 0 THEN -delta ELSE 0 END), 0)::INTEGER AS premium_expired_total
       FROM coin_ledger
      WHERE ($1::text IS NULL OR user_id = $1)
        AND ($2::bigint IS NULL OR created_at >= $2)
        AND ($3::bigint IS NULL OR created_at <= $3)`,
    [userId, from, to]
  );
  const currentBalance = userId ? await props.db.queryOne(
    `SELECT free_balance, premium_balance
           FROM coin_balances
          WHERE user_id = $1`,
    [userId]
  ) : null;
  const expiringLots = userId ? await props.db.query(
    `SELECT id,
                coin_type AS "coinType",
                remaining AS amount,
                expires_at AS "expiresAt",
                created_at AS "createdAt"
           FROM coin_lots
          WHERE user_id = $1
            AND remaining > 0
          ORDER BY expires_at ASC NULLS LAST, id ASC
          LIMIT 200`,
    [userId]
  ) : [];
  return {
    items,
    totalCount: countRow?.count ?? 0,
    offset,
    limit,
    summary: {
      matchedUserCount: summary?.matched_user_count ?? 0,
      freeGrantedTotal: summary?.free_granted_total ?? 0,
      premiumGrantedTotal: summary?.premium_granted_total ?? 0,
      freeConsumedTotal: summary?.free_consumed_total ?? 0,
      premiumConsumedTotal: summary?.premium_consumed_total ?? 0,
      freeExpiredTotal: summary?.free_expired_total ?? 0,
      premiumExpiredTotal: summary?.premium_expired_total ?? 0
    },
    currentBalance: userId ? {
      freeBalance: currentBalance?.free_balance ?? 0,
      premiumBalance: currentBalance?.premium_balance ?? 0,
      totalBalance: (currentBalance?.free_balance ?? 0) + (currentBalance?.premium_balance ?? 0)
    } : null,
    expiringLots
  };
};
export var ensureInitialCoinGrant = async (props) => {
  // 今日の日次コインを（まだなら）付与する。プランはサーバ側の契約情報と呼び出し元の値の高い方を使い、
  // 1 日 1 ユーザ 1 回・ユーザごとのロック付きで付与する（同時アクセスやプラン判定の揺れで二重に付かない）。
  // 有料プランは 00:00 JST の定期ジョブで付与済みのことが多く、そのお知らせはここで 1 回だけ返す。
  const now = getNow();
  const expired = await expireAvailableCoins(props.db, props.userId, now);
  const planType = await resolveCoinPlanType(props.db, props.userId, props.planType, now);
  const [granted] = await grantDailyCoinsBatch({
    db: props.db,
    entries: [{ userId: props.userId, planType }],
    now,
    source: "generation_page_access",
    recordPendingEvents: false
  });
  const pendingEvents = await takePendingCoinEvents(props.db, props.userId, now);
  const summary = await fetchCoinSummary(props.db, props.userId, {
    includeLedger: props.includeLedger,
    includeExpiringLots: props.includeExpiringLots,
    includeLedgerLimit: props.includeLedgerLimit,
    includeLedgerOffset: props.includeLedgerOffset
  });
  const grantedFreeCoins = granted?.free_delta ?? 0;
  const grantedPremiumCoins = 0;
  const grantEvents = grantedFreeCoins > 0 ? [createGrantEvent(grantedFreeCoins, grantedPremiumCoins)] : [];
  return {
    granted: grantEvents.length > 0,
    grantedPlanType: planType,
    grantedFreeCoins,
    grantedPremiumCoins,
    ...summary,
    expiredFreeCoins: expired.expiredFreeCoins,
    expiredPremiumCoins: expired.expiredPremiumCoins,
    events: [...pendingEvents, ...expired.events, ...grantEvents]
  };
};
export var applyCoinDelta = async (props) => {
  const now = getNow();
  const expired = await expireAvailableCoins(props.db, props.userId, now);
  const freeDelta = Math.floor(props.freeDelta ?? 0);
  const premiumDelta = Math.floor(props.premiumDelta ?? 0);
  await grantCoins({
    db: props.db,
    userId: props.userId,
    freeCoins: freeDelta,
    premiumCoins: premiumDelta,
    kind: props.kind,
    reason: props.reason ?? null,
    source: props.source ?? null,
    now
  });
  const summary = await fetchCoinSummary(props.db, props.userId);
  const grantEvents = freeDelta > 0 || premiumDelta > 0 ? [createGrantEvent(Math.max(freeDelta, 0), Math.max(premiumDelta, 0))] : [];
  return {
    ...summary,
    expiredFreeCoins: expired.expiredFreeCoins,
    expiredPremiumCoins: expired.expiredPremiumCoins,
    events: [...expired.events, ...grantEvents]
  };
};
export var adminAdjustCoins = async (props) => {
  const now = getNow();
  const expired = await expireAvailableCoins(props.db, props.userId, now);
  const freeDelta = Math.floor(props.freeDelta ?? 0);
  const premiumDelta = Math.floor(props.premiumDelta ?? 0);
  const granted = await grantCoins({
    db: props.db,
    userId: props.userId,
    freeCoins: Math.max(freeDelta, 0),
    premiumCoins: Math.max(premiumDelta, 0),
    kind: "GRANT",
    reason: props.reason ?? null,
    source: props.source ?? null,
    now,
    expiresAt: props.expiresAt
  });
  const freeReduced = await reduceCoinTypeBalance({
    db: props.db,
    userId: props.userId,
    coinType: "FREE",
    amount: Math.abs(Math.min(freeDelta, 0)),
    reason: props.reason ?? null,
    source: props.source ?? null,
    now,
    kind: "CONSUME"
  });
  const premiumReduced = await reduceCoinTypeBalance({
    db: props.db,
    userId: props.userId,
    coinType: "PREMIUM",
    amount: Math.abs(Math.min(premiumDelta, 0)),
    reason: props.reason ?? null,
    source: props.source ?? null,
    now,
    kind: "CONSUME"
  });
  const summary = await fetchCoinSummary(props.db, props.userId);
  const events = [...expired.events];
  if (granted.freeGranted > 0 || granted.premiumGranted > 0) {
    events.push(
      createGrantEvent(
        granted.freeGranted,
        granted.premiumGranted,
        props.expiresAt
      )
    );
  }
  if (freeReduced > 0 || premiumReduced > 0) {
    events.push(createConsumeEvent(freeReduced, premiumReduced));
  }
  return {
    ...summary,
    expiredFreeCoins: expired.expiredFreeCoins,
    expiredPremiumCoins: expired.expiredPremiumCoins,
    events,
    freeGranted: granted.freeGranted,
    premiumGranted: granted.premiumGranted,
    freeReduced,
    premiumReduced
  };
};
export var consumeCoins = async (props) => {
  const now = getNow();
  const amount = Math.floor(props.amount);
  if (amount <= 0) {
    return { ok: false, code: "INVALID_AMOUNT" };
  }
  const expired = await expireAvailableCoins(props.db, props.userId, now);
  // 日付をまたいで完了した生成など、今日の日次コインを受け取る前に消費が来ることがある。
  // その場合にプレミアムコインが先に使われないよう、今日の日次コインを先に（まだなら）付与しておく。
  const planType = await resolveCoinPlanType(props.db, props.userId, null, now);
  await grantDailyCoinsBatch({
    db: props.db,
    entries: [{ userId: props.userId, planType }],
    now,
    source: "consume",
    recordPendingEvents: true
  });
  const result = await props.db.lockedQueryOne(
    [coinLockKey(props.userId)],
    `WITH ensured AS (
        INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        VALUES ($1, 0, 0, $3)
        ON CONFLICT (user_id) DO NOTHING
      ),
      free_candidates AS (
        SELECT id,
               remaining,
               SUM(remaining) OVER (ORDER BY expires_at ASC NULLS LAST, id ASC) AS cumulative
          FROM coin_lots
         WHERE user_id = $1
           AND coin_type = 'FREE'
           AND remaining > 0
      ),
      free_updates AS (
        SELECT id,
               LEAST(remaining, GREATEST($2 - (cumulative - remaining), 0))::INTEGER AS spend
          FROM free_candidates
         WHERE GREATEST($2 - (cumulative - remaining), 0) > 0
      ),
      free_total AS (
        SELECT COALESCE(SUM(spend), 0)::INTEGER AS free_spend
          FROM free_updates
      ),
      premium_candidates AS (
        SELECT id,
               remaining,
               SUM(remaining) OVER (ORDER BY expires_at ASC NULLS LAST, id ASC) AS cumulative
          FROM coin_lots
         WHERE user_id = $1
           AND coin_type = 'PREMIUM'
           AND remaining > 0
      ),
      premium_updates AS (
        SELECT id,
               LEAST(
                 remaining,
                 GREATEST(
                   $2 - (SELECT free_spend FROM free_total) - (cumulative - remaining),
                   0
                 )
               )::INTEGER AS spend
          FROM premium_candidates
         WHERE GREATEST(
                 $2 - (SELECT free_spend FROM free_total) - (cumulative - remaining),
                 0
               ) > 0
      ),
      premium_total AS (
        SELECT COALESCE(SUM(spend), 0)::INTEGER AS premium_spend
          FROM premium_updates
      ),
      totals AS (
        SELECT free_total.free_spend,
               premium_total.premium_spend,
               (free_total.free_spend + premium_total.premium_spend)::INTEGER AS total_spend
          FROM free_total
          CROSS JOIN premium_total
      ),
      applied_free AS (
        UPDATE coin_lots
           SET remaining = coin_lots.remaining - free_updates.spend,
               updated_at = $3
          FROM free_updates, totals
         WHERE coin_lots.id = free_updates.id
           AND totals.total_spend >= $2
        RETURNING free_updates.spend
      ),
      applied_premium AS (
        UPDATE coin_lots
           SET remaining = coin_lots.remaining - premium_updates.spend,
               updated_at = $3
          FROM premium_updates, totals
         WHERE coin_lots.id = premium_updates.id
           AND totals.total_spend >= $2
        RETURNING premium_updates.spend
      ),
      updated_balance AS (
        UPDATE coin_balances
           SET free_balance = (
                 SELECT COALESCE(SUM(remaining), 0)::INTEGER
                   FROM coin_lots
                  WHERE user_id = $1
                    AND coin_type = 'FREE'
                    AND remaining > 0
               ),
               premium_balance = (
                 SELECT COALESCE(SUM(remaining), 0)::INTEGER
                   FROM coin_lots
                  WHERE user_id = $1
                    AND coin_type = 'PREMIUM'
                    AND remaining > 0
               ),
               updated_at = $3
         WHERE user_id = $1
           AND (SELECT total_spend FROM totals) >= $2
        RETURNING user_id
      ),
      free_ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, 'FREE', -free_spend, 'CONSUME', $4, $5, $3, NULL
          FROM totals
         WHERE free_spend > 0
           AND total_spend >= $2
      ),
      premium_ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, 'PREMIUM', -premium_spend, 'CONSUME', $4, $5, $3, NULL
          FROM totals
         WHERE premium_spend > 0
           AND total_spend >= $2
      )
      SELECT ((SELECT total_spend FROM totals) >= $2) AS ok,
             (SELECT free_spend FROM totals) AS free_spend,
             (SELECT premium_spend FROM totals) AS premium_spend`,
    [
      props.userId,
      amount,
      now,
      props.reason ?? null,
      props.source ?? null
    ]
  );
  if (!result?.ok) {
    return { ok: false, code: "INSUFFICIENT_COINS" };
  }
  const summary = await fetchCoinSummary(props.db, props.userId);
  const events = [...expired.events];
  if ((result.free_spend ?? 0) > 0 || (result.premium_spend ?? 0) > 0) {
    events.push(createConsumeEvent(result.free_spend ?? 0, result.premium_spend ?? 0));
  }
  return {
    ok: true,
    freeSpent: result.free_spend ?? 0,
    premiumSpent: result.premium_spend ?? 0,
    expiredFreeCoins: expired.expiredFreeCoins,
    expiredPremiumCoins: expired.expiredPremiumCoins,
    events,
    summary: {
      ...summary,
      expiredFreeCoins: expired.expiredFreeCoins,
      expiredPremiumCoins: expired.expiredPremiumCoins,
      events
    }
  };
};
export var getConsumedCoinBreakdownBySource = async (props) => {
  const row = await props.db.queryOne(
    `SELECT COALESCE(SUM(CASE WHEN coin_type = 'FREE' THEN -delta ELSE 0 END), 0)::INTEGER AS free_consumed,
            COALESCE(SUM(CASE WHEN coin_type = 'PREMIUM' THEN -delta ELSE 0 END), 0)::INTEGER AS premium_consumed
       FROM coin_ledger
      WHERE user_id = $1
        AND source = $2
        AND kind = 'CONSUME'
        AND delta < 0`,
    [props.userId, props.source]
  );
  return {
    freeConsumed: row?.free_consumed ?? 0,
    premiumConsumed: row?.premium_consumed ?? 0
  };
};
