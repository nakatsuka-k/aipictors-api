// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
// 残高と履歴、日次コインの受け取り
import { grantDailyCoinsBatch, resolveCoinPlanType, takePendingCoinEvents } from "../daily-coins"
import { getNow } from "../db"
import { expireAvailableCoins, syncCoinBalancesWithLots } from "./balance"
import { createGrantEvent } from "./format"
export var fetchCoinSummary = async (db, userId, options) => {
  const ledgerLimit = Math.min(
    200,
    Math.max(1, Math.floor(options?.includeLedgerLimit ?? 100))
  );
  const ledgerOffset = Math.max(
    0,
    Math.floor(options?.includeLedgerOffset ?? 0)
  );
  // Neon は 1 文ごとに HTTP の往復になる。互いの結果に依存しないので同時に投げる（順に待つと 5 往復分かかる）
  const [balance, ledger, expiringLots, exchangeableBalance, thanksRows] = await Promise.all([
    syncCoinBalancesWithLots(db, userId, getNow()),
    options?.includeLedger ? db.query(
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
  ) : [],
    options?.includeExpiringLots ? db.query(
    `SELECT coin_type AS "coinType",
                SUM(remaining) AS amount,
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
  ) : [],
    db.queryOne(
    `SELECT COALESCE(
              SUM(
                CASE
                  WHEN coin_type = 'PREMIUM' AND source_kind = 'SUPPORT'
                    THEN max(remaining - locked_amount, 0)
                  ELSE 0
                END
              ),
              0
            ) AS exchangeable_premium_balance,
            COALESCE(
              SUM(
                CASE
                  WHEN coin_type = 'PREMIUM' AND source_kind = 'SUPPORT'
                    THEN locked_amount
                  ELSE 0
                END
              ),
              0
            ) AS locked_exchange_premium_balance
       FROM coin_lots
      WHERE user_id = $1`,
    [userId]
  ),
    // 受け取った感謝コインのキャンペーン（サイトのお礼の表示は、実際に受け取った人にだけ出す）
    db.query(
    `SELECT DISTINCT substr(source, 8) AS campaign
       FROM coin_ledger
      WHERE user_id = $1
        AND source LIKE 'thanks:%'`,
    [userId]
  )
  ]);
  const freeBalance = balance?.free_balance ?? 0;
  const premiumBalance = balance?.premium_balance ?? 0;
  return {
    thanksCampaigns: thanksRows.map((row) => row.campaign),
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
                ) AS "runningFreeBalance",
              SUM(CASE WHEN coin_type = 'PREMIUM' THEN delta ELSE 0 END)
                OVER (
                  PARTITION BY user_id
                  ORDER BY created_at ASC, id ASC
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS "runningPremiumBalance"
         FROM coin_ledger
        WHERE ($1 IS NULL OR user_id = $1)
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
            ("runningFreeBalance" + "runningPremiumBalance") AS "runningTotalBalance"
       FROM ranked
      WHERE ($2 IS NULL OR "createdAt" >= $2)
        AND ($3 IS NULL OR "createdAt" <= $3)
      ORDER BY "createdAt" DESC, id DESC
      LIMIT $4
     OFFSET $5`,
    [userId, from, to, limit, offset]
  );
  const countRow = await props.db.queryOne(
    `SELECT COUNT(*) AS count
       FROM coin_ledger
      WHERE ($1 IS NULL OR user_id = $1)
        AND ($2 IS NULL OR created_at >= $2)
        AND ($3 IS NULL OR created_at <= $3)`,
    [userId, from, to]
  );
  const summary = await props.db.queryOne(
    `SELECT COUNT(DISTINCT user_id) AS matched_user_count,
            COALESCE(SUM(CASE WHEN coin_type = 'FREE' AND kind IN ('INITIAL_GRANT', 'GRANT') AND delta > 0 THEN delta ELSE 0 END), 0) AS free_granted_total,
            COALESCE(SUM(CASE WHEN coin_type = 'PREMIUM' AND kind IN ('INITIAL_GRANT', 'GRANT') AND delta > 0 THEN delta ELSE 0 END), 0) AS premium_granted_total,
            COALESCE(SUM(CASE WHEN coin_type = 'FREE' AND kind = 'CONSUME' AND delta < 0 THEN -delta ELSE 0 END), 0) AS free_consumed_total,
            COALESCE(SUM(CASE WHEN coin_type = 'PREMIUM' AND kind = 'CONSUME' AND delta < 0 THEN -delta ELSE 0 END), 0) AS premium_consumed_total,
            COALESCE(SUM(CASE WHEN coin_type = 'FREE' AND kind = 'EXPIRE' AND delta < 0 THEN -delta ELSE 0 END), 0) AS free_expired_total,
            COALESCE(SUM(CASE WHEN coin_type = 'PREMIUM' AND kind = 'EXPIRE' AND delta < 0 THEN -delta ELSE 0 END), 0) AS premium_expired_total
       FROM coin_ledger
      WHERE ($1 IS NULL OR user_id = $1)
        AND ($2 IS NULL OR created_at >= $2)
        AND ($3 IS NULL OR created_at <= $3)`,
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
  const [expired, planType] = await Promise.all([
    expireAvailableCoins(props.db, props.userId, now),
    resolveCoinPlanType(props.db, props.userId, props.planType, now)
  ]);
  const [granted] = await grantDailyCoinsBatch({
    db: props.db,
    entries: [{ userId: props.userId, planType }],
    now,
    source: "generation_page_access",
    recordPendingEvents: false
  });
  const [pendingEvents, summary] = await Promise.all([
    takePendingCoinEvents(props.db, props.userId, now),
    fetchCoinSummary(props.db, props.userId, {
      includeLedger: props.includeLedger,
      includeExpiringLots: props.includeExpiringLots,
      includeLedgerLimit: props.includeLedgerLimit,
      includeLedgerOffset: props.includeLedgerOffset
    })
  ]);
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

export var getConsumedCoinBreakdownBySource = async (props) => {
  const row = await props.db.queryOne(
    `SELECT COALESCE(SUM(CASE WHEN coin_type = 'FREE' THEN -delta ELSE 0 END), 0) AS free_consumed,
            COALESCE(SUM(CASE WHEN coin_type = 'PREMIUM' THEN -delta ELSE 0 END), 0) AS premium_consumed
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
