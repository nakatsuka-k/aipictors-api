// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
// コインの付与・減算・失効と残高の同期
import { coinLockKey, getNow } from "../db"
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
