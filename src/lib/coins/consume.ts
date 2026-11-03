// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
// コインの消費（生成など）
import { grantDailyCoinsBatch, resolveCoinPlanType } from "../daily-coins"
import { coinLockKey, getNow } from "../db"
import { getGeminiAllowance, isGeminiCoinReason } from "../gemini-allowance"
import { expireAvailableCoins } from "./balance"
import { createConsumeEvent } from "./format"
import { fetchCoinSummary } from "./summary"
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
  // Gemini はフリーコインから使える量に週の枠がある（超えた分はプレミアムコイン）
  let maxFreeSpend = amount;
  if (isGeminiCoinReason(props.reason)) {
    const allowance = await getGeminiAllowance({ db: props.db, userId: props.userId, now });
    if (allowance.isEnforced) {
      maxFreeSpend = Math.min(amount, allowance.remaining);
    }
  }
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
               LEAST(remaining, GREATEST($6::INTEGER - (cumulative - remaining), 0))::INTEGER AS spend
          FROM free_candidates
         WHERE GREATEST($6::INTEGER - (cumulative - remaining), 0) > 0
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
      props.source ?? null,
      maxFreeSpend
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
