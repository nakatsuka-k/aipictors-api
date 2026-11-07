// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
// コインの消費（生成など）
import { grantDailyCoinsBatch, resolveCoinPlanType } from "../daily-coins"
import { getNow } from "../db"
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
  // D1: 1 つのトランザクション（batch）で実行する。使う量は「使う前のロット」から計算し、
  // 足りるときだけ d1_guard に 1 行入れて、以降の文はその行があるときだけ書く（最後に消す）。
  // プレミアムの使う量はフリーのロットから計算するので、プレミアムのロットを先に更新する。
  const lotsSql = (coinType) => `SELECT id,
               remaining,
               SUM(remaining) OVER (ORDER BY expires_at ASC NULLS LAST, id ASC) AS cumulative
          FROM coin_lots
         WHERE user_id = $1
           AND coin_type = '${coinType}'
           AND remaining > 0`;
  const freeUpdatesSql = `SELECT id,
               min(remaining, max($6 - (cumulative - remaining), 0)) AS spend
          FROM (${lotsSql("FREE")})
         WHERE max($6 - (cumulative - remaining), 0) > 0`;
  const freeTotalSql = `(SELECT COALESCE(SUM(spend), 0) FROM (${freeUpdatesSql}))`;
  const premiumUpdatesSql = `SELECT id,
               min(remaining, max($2 - ${freeTotalSql} - (cumulative - remaining), 0)) AS spend
          FROM (${lotsSql("PREMIUM")})
         WHERE max($2 - ${freeTotalSql} - (cumulative - remaining), 0) > 0`;
  const premiumTotalSql = `(SELECT COALESCE(SUM(spend), 0) FROM (${premiumUpdatesSql}))`;
  const okSql = `(${freeTotalSql} + ${premiumTotalSql}) >= $2`;
  const guarded = "EXISTS (SELECT 1 FROM d1_guard)";
  const params = [
    props.userId,
    amount,
    now,
    props.reason ?? null,
    props.source ?? null,
    maxFreeSpend
  ];
  const results = await props.db.batch([
    {
      text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        VALUES ($1, 0, 0, $3)
        ON CONFLICT (user_id) DO NOTHING`,
      params
    },
    {
      text: `SELECT ${okSql} AS ok, ${freeTotalSql} AS free_spend, ${premiumTotalSql} AS premium_spend`,
      params
    },
    { text: `INSERT INTO d1_guard(ok) SELECT 1 WHERE ${okSql}`, params },
    {
      text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, 'FREE', -${freeTotalSql}, 'CONSUME', $4, $5, $3, NULL
         WHERE ${freeTotalSql} > 0 AND ${guarded}`,
      params
    },
    {
      text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, 'PREMIUM', -${premiumTotalSql}, 'CONSUME', $4, $5, $3, NULL
         WHERE ${premiumTotalSql} > 0 AND ${guarded}`,
      params
    },
    {
      text: `UPDATE coin_lots
           SET remaining = coin_lots.remaining - updates.spend,
               updated_at = $3
          FROM (${premiumUpdatesSql}) AS updates
         WHERE coin_lots.id = updates.id
           AND ${guarded}`,
      params
    },
    {
      text: `UPDATE coin_lots
           SET remaining = coin_lots.remaining - updates.spend,
               updated_at = $3
          FROM (${freeUpdatesSql}) AS updates
         WHERE coin_lots.id = updates.id
           AND ${guarded}`,
      params
    },
    {
      text: `UPDATE coin_balances
           SET free_balance = (SELECT COALESCE(SUM(remaining), 0) FROM coin_lots WHERE user_id = $1 AND coin_type = 'FREE' AND remaining > 0),
               premium_balance = (SELECT COALESCE(SUM(remaining), 0) FROM coin_lots WHERE user_id = $1 AND coin_type = 'PREMIUM' AND remaining > 0),
               updated_at = $3
         WHERE user_id = $1
           AND ${guarded}`,
      params
    },
    { text: "DELETE FROM d1_guard" }
  ]);
  const row = results[1].rows[0];
  const result = row ? { ok: Boolean(row.ok), free_spend: row.free_spend, premium_spend: row.premium_spend } : null;
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
