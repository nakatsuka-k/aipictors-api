// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
// コインの付与・減算・失効と残高の同期
import { getNow } from "../db"
import { createConsumeEvent, createExpireEvent, createGrantEvent, getJstExpirationAt } from "./format"
import { fetchCoinSummary } from "./summary"
export var grantCoins = async (props) => {
  const freeCoins = Math.floor(Math.max(0, props.freeCoins));
  const premiumCoins = Math.floor(Math.max(0, props.premiumCoins));
  if (freeCoins === 0 && premiumCoins === 0) {
    return { freeGranted: 0, premiumGranted: 0 };
  }
  const expiresAt = props.expiresAt === void 0 ? getJstExpirationAt(props.now) : props.expiresAt;
  // プレミアムコインは日次失効させない（返却・管理付与で当日24:00期限になっていた）。期限を明示したときだけ使う
  const premiumExpiresAt = props.expiresAt === void 0 ? null : props.expiresAt;
  // D1: 1 つのトランザクション（batch）で残高・ロット・台帳をまとめて書く
  const params = [
    props.userId,
    freeCoins,
    premiumCoins,
    props.now,
    props.kind,
    props.reason ?? null,
    props.source ?? null,
    expiresAt,
    premiumExpiresAt
  ];
  await props.db.batch([
    {
      text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        VALUES ($1, 0, 0, $4)
        ON CONFLICT (user_id) DO NOTHING`,
      params
    },
    {
      text: `UPDATE coin_balances
           SET free_balance = coin_balances.free_balance + $2,
               premium_balance = coin_balances.premium_balance + $3,
               updated_at = $4
         WHERE user_id = $1`,
      params
    },
  // Neon 版と同じ id の順（プレミアム → フリー）
    {
      text: `INSERT INTO coin_lots(user_id, coin_type, remaining, expires_at, created_at, updated_at)
        SELECT $1, 'PREMIUM', $3, $9, $4, $4
         WHERE $3 > 0`,
      params
    },
    {
      text: `INSERT INTO coin_lots(user_id, coin_type, remaining, expires_at, created_at, updated_at)
        SELECT $1, 'FREE', $2, $8, $4, $4
         WHERE $2 > 0`,
      params
    },
    {
      text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, 'PREMIUM', $3, $5, $6, $7, $4, CASE WHEN $3 > 0 THEN $9 ELSE NULL END
         WHERE $3 <> 0`,
      params
    },
    {
      text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, 'FREE', $2, $5, $6, $7, $4, CASE WHEN $2 > 0 THEN $8 ELSE NULL END
         WHERE $2 <> 0`,
      params
    }
  ]);
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
  // ロットを期限の近い順に使う。台帳・残高は「使う前のロット」から計算するので、ロットの更新を最後にする（同じトランザクション内）
  const updatesSql = `SELECT id,
               min(remaining, max($3 - (running_total - remaining), 0)) AS spend
          FROM (
            SELECT id,
                   remaining,
                   SUM(remaining) OVER (ORDER BY expires_at ASC NULLS LAST, id ASC) AS running_total
              FROM coin_lots
             WHERE user_id = $1
               AND coin_type = $2
               AND remaining > 0
          )
         WHERE running_total - remaining < $3`;
  const spentSql = `(SELECT COALESCE(SUM(spend), 0) FROM (${updatesSql}) WHERE spend > 0)`;
  const params = [
    props.userId,
    props.coinType,
    amount,
    props.now,
    props.kind,
    props.reason ?? null,
    props.source ?? null
  ];
  const results = await props.db.batch([
    {
      text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        VALUES ($1, 0, 0, $4)
        ON CONFLICT (user_id) DO NOTHING`,
      params
    },
    { text: `SELECT ${spentSql} AS spent`, params },
    {
      text: `UPDATE coin_balances
           SET ${balanceColumn} = max(coin_balances.${balanceColumn} - ${spentSql}, 0),
               updated_at = $4
         WHERE user_id = $1`,
      params
    },
    {
      text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, $2, -${spentSql}, $5, $6, $7, $4, NULL
         WHERE ${spentSql} > 0`,
      params
    },
    {
      text: `UPDATE coin_lots
           SET remaining = coin_lots.remaining - updates.spend,
               updated_at = $4
          FROM (${updatesSql}) AS updates
         WHERE coin_lots.id = updates.id
           AND updates.spend > 0`,
      params
    }
  ]);
  const result = results[1].rows[0];
  return result?.spent ?? 0;
};

export var expireAvailableCoins = async (db, userId, now) => {
  const expiredSql = `SELECT id, coin_type, remaining
          FROM coin_lots
         WHERE user_id = $1
           AND remaining > 0
           AND expires_at IS NOT NULL
           AND expires_at <= $2`;
  const sumsSql = `SELECT COALESCE(SUM(CASE WHEN coin_type = 'FREE' THEN remaining ELSE 0 END), 0) AS expired_free,
               COALESCE(SUM(CASE WHEN coin_type = 'PREMIUM' THEN remaining ELSE 0 END), 0) AS expired_premium
          FROM (${expiredSql})`;
  const params = [userId, now];
  // ほとんどの呼び出しは失効するロットがないので、書き込みの 4 文を投げない
  const hasExpired = await db.queryOne(`${expiredSql} LIMIT 1`, params);
  if (!hasExpired) {
    return { expiredFreeCoins: 0, expiredPremiumCoins: 0, events: [] };
  }
  // 台帳・残高は失効前のロットから計算し、ロットの更新を最後にする（同じトランザクション内）
  const results = await db.batch([
    { text: sumsSql, params },
    {
      text: `UPDATE coin_balances
           SET free_balance = max(coin_balances.free_balance - (SELECT expired_free FROM (${sumsSql})), 0),
               premium_balance = max(coin_balances.premium_balance - (SELECT expired_premium FROM (${sumsSql})), 0),
               updated_at = $2
         WHERE user_id = $1
           AND EXISTS (${expiredSql})`,
      params
    },
    {
      text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, 'FREE', -expired_free, 'EXPIRE', 'Daily coin expiration', 'expiration', $2, NULL
          FROM (${sumsSql})
         WHERE expired_free > 0`,
      params
    },
    {
      text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, 'PREMIUM', -expired_premium, 'EXPIRE', 'Daily coin expiration', 'expiration', $2, NULL
          FROM (${sumsSql})
         WHERE expired_premium > 0`,
      params
    },
    {
      text: `UPDATE coin_lots
           SET remaining = 0,
               updated_at = $2
         WHERE id IN (SELECT id FROM (${expiredSql}))`,
      params
    }
  ]);
  const result = results[0].rows[0];
  const expiredFreeCoins = result?.expired_free ?? 0;
  const expiredPremiumCoins = result?.expired_premium ?? 0;
  return {
    expiredFreeCoins,
    expiredPremiumCoins,
    events: expiredFreeCoins > 0 || expiredPremiumCoins > 0 ? [createExpireEvent(expiredFreeCoins, expiredPremiumCoins)] : []
  };
};

export var syncCoinBalancesWithLots = async (db, userId, now) => {
  const results = await db.batch([
    {
      text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        VALUES ($1, 0, 0, $2)
        ON CONFLICT (user_id) DO NOTHING`,
      params: [userId, now]
    },
    {
      text: `UPDATE coin_balances
           SET free_balance = (SELECT COALESCE(SUM(remaining), 0) FROM coin_lots WHERE user_id = $1 AND coin_type = 'FREE' AND remaining > 0),
               premium_balance = (SELECT COALESCE(SUM(remaining), 0) FROM coin_lots WHERE user_id = $1 AND coin_type = 'PREMIUM' AND remaining > 0),
               updated_at = $2
         WHERE user_id = $1
        RETURNING free_balance, premium_balance`,
      params: [userId, now]
    }
  ]);
  return results[1].rows[0] ?? null;
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
    now,
    // 期限を指定したときだけ使う（指定が無ければ無料コインは当日 24:00、プレミアムは期限なし）
    ...(props.expiresAt !== void 0 && props.expiresAt !== null && { expiresAt: props.expiresAt })
  });
  const summary = await fetchCoinSummary(props.db, props.userId);
  const grantEvents = freeDelta > 0 || premiumDelta > 0 ? [createGrantEvent(Math.max(freeDelta, 0), Math.max(premiumDelta, 0), props.expiresAt ?? void 0)] : [];
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
