// @ts-nocheck
// 有料リクエストのコイン: 申し込みで預かる・お断り/キャンセル/期限切れで全額返す・確定でクリエイターに渡す。
// どれも「依頼の行の状態を条件付きで変える → 1 行変わったときだけコインを動かす」を 1 つの batch（トランザクション）で行う。
// 二重の操作・同時の操作でもコインは 1 回しか動かない（変わらなければ guard が batch 全体を取り消す）
import { guard, guardCleanup, isGuardFailure } from "../db-d1"
import { expireAvailableCoins } from "../coins/balance"
import { CREATOR_REWARD_HOLD_DAYS, CREATOR_REWARD_RATE_MILLIYEN } from "../creator-payouts/config"
import {
  ACTIVE_STATUSES,
  CREATOR_ACTIVE_MAX,
  DAY,
  FREE_COIN_EXPIRE_DAYS,
  REQUESTER_PENDING_MAX,
  RESPOND_DAYS,
  calcSettlement,
} from "./config"

const inList = (values) => values.map((v) => `'${v}'`).join(", ")

const lotsSql = (coinType) => `SELECT id, remaining, paid_ratio_ppm,
               SUM(remaining) OVER (ORDER BY expires_at ASC NULLS LAST, id ASC) AS cumulative
          FROM coin_lots
         WHERE user_id = $1 AND coin_type = '${coinType}' AND remaining > 0`
// 1 つの依頼はフリーコインかプレミアムコインのどちらか一方だけで払う（混ぜない）。期限の近いロットから使う
const COIN_TYPES = ["FREE", "PREMIUM"]
const spendUpdatesSql = (coinType) => `SELECT id, paid_ratio_ppm, min(remaining, max($2 - (cumulative - remaining), 0)) AS spend
          FROM (${lotsSql(coinType)}) WHERE max($2 - (cumulative - remaining), 0) > 0`
const spendTotalSql = (coinType) => `(SELECT COALESCE(SUM(spend), 0) FROM (${spendUpdatesSql(coinType)}))`
const paidTotalSql = `(SELECT CAST(COALESCE(SUM(spend * paid_ratio_ppm), 0) AS INTEGER) / 1000000 FROM (${spendUpdatesSql("PREMIUM")}))`

/**
 * 払うコインの種類。指定がなければ（古いアプリなど）、プレミアムコインのみでなく、フリーコインで足りればフリーコイン、足りなければプレミアムコイン
 */
const resolveCoinType = async ({ db, input }) => {
  if (COIN_TYPES.includes(input.coinType)) return input.coinType
  if (input.premiumOnly) return "PREMIUM"
  const row = await db.queryOne(`SELECT free_balance FROM coin_balances WHERE user_id = $1`, [input.requesterUserId])
  return Number(row?.free_balance ?? 0) >= Number(input.priceCoins) ? "FREE" : "PREMIUM"
}

const recalcBalance = (userParam, nowParam) => ({
  text: `UPDATE coin_balances
           SET free_balance = (SELECT COALESCE(SUM(remaining), 0) FROM coin_lots WHERE user_id = ${userParam} AND coin_type = 'FREE' AND remaining > 0),
               premium_balance = (SELECT COALESCE(SUM(remaining), 0) FROM coin_lots WHERE user_id = ${userParam} AND coin_type = 'PREMIUM' AND remaining > 0),
               updated_at = ${nowParam}
         WHERE user_id = ${userParam}`,
})

/**
 * 申し込み: 受付の条件（プラン・同時受付数・承諾待ちの数・残高）を満たすときだけ依頼の行を入れてコインを預かる。
 * 同じ client_key の申し込みは 1 回だけ（二度押し・通信のやり直し）
 */
export const createEscrowedRequest = async ({ db, now, input }) => {
  await expireAvailableCoins(db, input.requesterUserId, now)
  const coinType = await resolveCoinType({ db, input })
  const isPremium = coinType === "PREMIUM"
  const spendTotal = spendTotalSql(coinType)
  // プレミアムコインのみのプラン・受付には、フリーコインで申し込めない（coinType は COIN_TYPES のどちらかなので文に埋め込める）
  const coinOk = (alias) => `(${alias}.premium_only = 0 OR '${coinType}' = 'PREMIUM')`
  const respondBy = now + RESPOND_DAYS * DAY
  const params = [
    input.requesterUserId, // $1
    input.priceCoins, // $2
    now, // $3
    input.creatorUserId, // $4
    input.planId ?? null, // $5
    input.clientKey, // $6
    input.title, // $7
    input.body, // $8
    JSON.stringify(input.referenceImageUrls ?? []), // $9
    input.isR18 ? 1 : 0, // $10
    input.deliveryDays, // $11
    input.revisionCount ?? 0, // $12
    respondBy, // $13
    input.maxActive ?? CREATOR_ACTIVE_MAX, // $14
  ]
  const active = inList(ACTIVE_STATUSES)
  // プランで申し込むときは、プランが受付中・値段が同じ・そのプランの同時受付数に空きがある
  const planOk = `($5 IS NULL OR EXISTS (
        SELECT 1 FROM request_plans p
         WHERE p.id = $5 AND p.user_id = $4 AND p.status = 'ACTIVE' AND p.is_accepting = 1 AND p.price_coins = $2 AND ${coinOk("p")}
           AND ($10 = 0 OR p.allows_r18 = 1)
           AND (SELECT COUNT(*) FROM coin_requests r WHERE r.plan_id = $5 AND r.status IN (${active})) < p.max_active))`
  // 自由リクエストは受付がオン・最低コイン以上・自由リクエストの同時受付数に空きがある
  const freeOk = `($5 IS NOT NULL OR EXISTS (
        SELECT 1 FROM creator_request_settings s
         WHERE s.user_id = $4 AND s.accepts_free_requests = 1 AND ${coinOk("s")} AND $2 >= s.min_coins AND ($10 = 0 OR s.allows_r18 = 1)
           AND (SELECT COUNT(*) FROM coin_requests r WHERE r.creator_user_id = $4 AND r.plan_id IS NULL AND r.status IN (${active})) < s.max_active))`
  const capacityOk = `(SELECT COUNT(*) FROM coin_requests r WHERE r.creator_user_id = $4 AND r.status IN (${active})) < ${CREATOR_ACTIVE_MAX}
        AND (SELECT COUNT(*) FROM coin_requests r WHERE r.creator_user_id = $4 AND r.requester_user_id = $1 AND r.status = 'PENDING') < ${REQUESTER_PENDING_MAX}`
  const source = `'coin-request:' || (SELECT id FROM coin_requests WHERE requester_user_id = $1 AND client_key = $6)`
  try {
    const results = await db.batch([
      { text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at) VALUES ($1, 0, 0, $3) ON CONFLICT (user_id) DO NOTHING`, params },
      {
        text: `INSERT INTO coin_requests(plan_id, requester_user_id, creator_user_id, client_key, title, body, reference_image_urls, is_r18,
                 price_coins, delivery_days, revision_left, free_spent, premium_spent, paid_coins, status, respond_by, created_at, updated_at)
               SELECT $5, $1, $4, $6, $7, $8, $9, $10, $2, $11, $12, ${isPremium ? 0 : spendTotal}, ${isPremium ? spendTotal : 0}, ${isPremium ? paidTotalSql : 0}, 'PENDING', $13, $3, $3
                WHERE $1 <> $4 AND ${spendTotal} >= $2 AND ${planOk} AND ${freeOk} AND ${capacityOk}
               ON CONFLICT (requester_user_id, client_key) DO NOTHING`,
        params,
      },
      guard("changes() = 1"),
      {
        text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
               SELECT $1, '${coinType}', -${spendTotal}, 'CONSUME', 'coin request escrow', ${source}, $3, NULL WHERE ${spendTotal} > 0`,
        params,
      },
      {
        text: `UPDATE coin_lots SET remaining = coin_lots.remaining - updates.spend, updated_at = $3
                 FROM (${spendUpdatesSql(coinType)}) AS updates WHERE coin_lots.id = updates.id`,
        params,
      },
      { ...recalcBalance("$1", "$3"), params },
      { text: `UPDATE request_plans SET order_count = order_count + 1, updated_at = updated_at WHERE id = $5`, params },
      { text: `SELECT id FROM coin_requests WHERE requester_user_id = $1 AND client_key = $6`, params },
      guardCleanup,
    ])
    return { ok: true, requestId: Number(results[results.length - 2].rows[0]?.id) }
  } catch (error) {
    if (!isGuardFailure(error)) throw error
    // 同じ申し込みがもう入っている（二度押し）なら、その依頼を返す
    const existing = await db.queryOne(`SELECT id FROM coin_requests WHERE requester_user_id = $1 AND client_key = $2`, [input.requesterUserId, input.clientKey])
    if (existing) return { ok: true, requestId: Number(existing.id), duplicated: true }
    return { ok: false, code: await diagnoseRejection({ db, input, coinType }) }
  }
}

/** 申し込みを受け付けなかった理由（受付の batch と同じ条件を順に見る） */
const diagnoseRejection = async ({ db, input, coinType }) => {
  if (String(input.requesterUserId) === String(input.creatorUserId)) return "SELF_REQUEST"
  const active = inList(ACTIVE_STATUSES)
  if (input.planId) {
    const plan = await db.queryOne(`SELECT * FROM request_plans WHERE id = $1`, [input.planId])
    if (!plan || plan.status !== "ACTIVE" || String(plan.user_id) !== String(input.creatorUserId)) return "PLAN_NOT_FOUND"
    if (Number(plan.is_accepting) !== 1) return "NOT_ACCEPTING"
    if (Number(plan.price_coins) !== Number(input.priceCoins)) return "PRICE_CHANGED"
    if (input.isR18 && Number(plan.allows_r18) !== 1) return "R18_NOT_ALLOWED"
    if (Number(plan.premium_only) === 1 && coinType !== "PREMIUM") return "PREMIUM_ONLY"
    const count = await db.queryOne(`SELECT COUNT(*) AS n FROM coin_requests WHERE plan_id = $1 AND status IN (${active})`, [input.planId])
    if (Number(count?.n ?? 0) >= Number(plan.max_active)) return "FULL"
  } else {
    const s = await db.queryOne(`SELECT * FROM creator_request_settings WHERE user_id = $1`, [input.creatorUserId])
    if (!s || Number(s.accepts_free_requests) !== 1) return "NOT_ACCEPTING"
    if (Number(input.priceCoins) < Number(s.min_coins)) return "BELOW_MINIMUM"
    if (input.isR18 && Number(s.allows_r18) !== 1) return "R18_NOT_ALLOWED"
    if (Number(s.premium_only) === 1 && coinType !== "PREMIUM") return "PREMIUM_ONLY"
    const count = await db.queryOne(`SELECT COUNT(*) AS n FROM coin_requests WHERE creator_user_id = $1 AND plan_id IS NULL AND status IN (${active})`, [input.creatorUserId])
    if (Number(count?.n ?? 0) >= Number(s.max_active)) return "FULL"
  }
  const total = await db.queryOne(`SELECT COUNT(*) AS n FROM coin_requests WHERE creator_user_id = $1 AND status IN (${active})`, [input.creatorUserId])
  if (Number(total?.n ?? 0) >= CREATOR_ACTIVE_MAX) return "FULL"
  const pending = await db.queryOne(
    `SELECT COUNT(*) AS n FROM coin_requests WHERE creator_user_id = $1 AND requester_user_id = $2 AND status = 'PENDING'`,
    [input.creatorUserId, input.requesterUserId],
  )
  if (Number(pending?.n ?? 0) >= REQUESTER_PENDING_MAX) return "TOO_MANY_PENDING"
  return "INSUFFICIENT_COINS"
}

/**
 * 全額返却: 状態が fromStatuses のどれかのときだけ toStatus に変え、預かったコインを依頼者に戻す。
 * プレミアムは有料の割合（paid_ratio_ppm）を残す（戻ったコインでまた依頼すれば報酬の対象になる）
 */
export const refundRequest = async ({ db, now, requestId, fromStatuses, toStatus, reason, actorUserId = null }) => {
  const params = [requestId, now, toStatus, reason ?? null, actorUserId, now + FREE_COIN_EXPIRE_DAYS * DAY]
  const row = (col) => `(SELECT ${col} FROM coin_requests WHERE id = $1)`
  const source = `'coin-request:' || $1`
  try {
    await db.batch([
      {
        text: `UPDATE coin_requests SET status = $3, closed_reason = $4, closed_at = $2, closed_by_user_id = $5, updated_at = $2
                WHERE id = $1 AND status IN (${inList(fromStatuses)})`,
        params,
      },
      guard("changes() = 1"),
      {
        text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
               SELECT requester_user_id, 0, 0, $2 FROM coin_requests WHERE id = $1 ON CONFLICT (user_id) DO NOTHING`,
        params,
      },
      {
        text: `INSERT INTO coin_lots(user_id, coin_type, remaining, locked_amount, source_kind, source_ref_id, granted_by_user_id, expires_at, created_at, updated_at, paid_ratio_ppm)
               SELECT requester_user_id, 'FREE', free_spent, 0, 'REQUEST_REFUND', 'coin-request:' || id, NULL, $6, $2, $2, 0
                 FROM coin_requests WHERE id = $1 AND free_spent > 0`,
        params,
      },
      {
        text: `INSERT INTO coin_lots(user_id, coin_type, remaining, locked_amount, source_kind, source_ref_id, granted_by_user_id, expires_at, created_at, updated_at, paid_ratio_ppm)
               SELECT requester_user_id, 'PREMIUM', premium_spent, 0, 'REQUEST_REFUND', 'coin-request:' || id, NULL, NULL, $2, $2,
                      min(1000000, (paid_coins * 1000000) / max(premium_spent, 1))
                 FROM coin_requests WHERE id = $1 AND premium_spent > 0`,
        params,
      },
      {
        text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
               SELECT requester_user_id, 'FREE', free_spent, 'GRANT', 'coin request refund', ${source}, $2, $6 FROM coin_requests WHERE id = $1 AND free_spent > 0`,
        params,
      },
      {
        text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
               SELECT requester_user_id, 'PREMIUM', premium_spent, 'GRANT', 'coin request refund', ${source}, $2, NULL FROM coin_requests WHERE id = $1 AND premium_spent > 0`,
        params,
      },
      { ...recalcBalance(row("requester_user_id"), "$2"), params },
      guardCleanup,
    ])
    return { ok: true }
  } catch (error) {
    if (isGuardFailure(error)) return { ok: false, code: "INVALID_STATE" }
    throw error
  }
}

/**
 * 確定: 状態が fromStatuses のときだけ toStatus にし、手数料を引いた分をクリエイターへ。
 * 有料分は（eligible なら）報酬 creator_earnings（kind REQUEST、換金と同じ台帳・保留・締め）、残りはコイン
 */
export const settleRequest = async ({ db, now, request, fromStatuses, toStatus, feePpm, eligible, actorUserId = null, reason = null }) => {
  const s = calcSettlement({
    freeSpent: request.free_spent,
    premiumSpent: request.premium_spent,
    paidCoins: request.paid_coins,
    feePpm,
    eligible,
  })
  const earnedMilliyen = s.earnedCoins * CREATOR_REWARD_RATE_MILLIYEN
  const params = [
    request.id, // $1
    now, // $2
    toStatus, // $3
    s.feeCoins, // $4
    s.earnedCoins, // $5
    earnedMilliyen, // $6
    s.settleFreeCoins, // $7
    s.settlePremiumCoins, // $8
    String(request.creator_user_id), // $9
    String(request.requester_user_id), // $10
    now + FREE_COIN_EXPIRE_DAYS * DAY, // $11
    CREATOR_REWARD_RATE_MILLIYEN, // $12
    now + CREATOR_REWARD_HOLD_DAYS * DAY, // $13
    actorUserId, // $14
    reason, // $15
  ]
  const source = `'coin-request:' || $1`
  try {
    await db.batch([
      {
        text: `UPDATE coin_requests SET status = $3, completed_at = $2, fee_coins = $4, earned_coins = $5, earned_milliyen = $6,
                      settle_free_coins = $7, settle_premium_coins = $8, closed_by_user_id = $14, closed_reason = $15, updated_at = $2
                WHERE id = $1 AND status IN (${inList(fromStatuses)})`,
        params,
      },
      guard("changes() = 1"),
      { text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at) VALUES ($9, 0, 0, $2) ON CONFLICT (user_id) DO NOTHING`, params },
      {
        text: `INSERT INTO coin_lots(user_id, coin_type, remaining, locked_amount, source_kind, source_ref_id, granted_by_user_id, expires_at, created_at, updated_at, paid_ratio_ppm)
               SELECT $9, 'FREE', $7, 0, 'REQUEST', 'coin-request:' || $1, $10, $11, $2, $2, 0 WHERE $7 > 0`,
        params,
      },
      {
        text: `INSERT INTO coin_lots(user_id, coin_type, remaining, locked_amount, source_kind, source_ref_id, granted_by_user_id, expires_at, created_at, updated_at, paid_ratio_ppm)
               SELECT $9, 'PREMIUM', $8, 0, 'REQUEST', 'coin-request:' || $1, $10, NULL, $2, $2, 0 WHERE $8 > 0`,
        params,
      },
      {
        text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
               SELECT $9, 'FREE', $7, 'GRANT', 'coin request received', ${source}, $2, $11 WHERE $7 > 0`,
        params,
      },
      {
        text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
               SELECT $9, 'PREMIUM', $8, 'GRANT', 'coin request received', ${source}, $2, NULL WHERE $8 > 0`,
        params,
      },
      {
        text: `INSERT INTO creator_earnings(user_id, kind, source, sender_user_id, work_id, coins, rate_milliyen, amount_milliyen, status, available_at, created_at, updated_at)
               SELECT $9, 'REQUEST', ${source}, $10, NULL, $5, $12, $6, 'HELD', $13, $2, $2 WHERE $5 > 0`,
        params,
      },
      { ...recalcBalance("$9", "$2"), params },
      {
        text: `UPDATE request_plans SET completed_count = completed_count + 1
                WHERE id = (SELECT plan_id FROM coin_requests WHERE id = $1)`,
        params,
      },
      guardCleanup,
    ])
    return { ok: true, ...s, earnedMilliyen }
  } catch (error) {
    if (isGuardFailure(error)) return { ok: false, code: "INVALID_STATE" }
    throw error
  }
}

/** 状態だけを変える（承諾・納品・修正依頼など。コインは動かない） */
export const transitionRequest = async ({ db, requestId, fromStatuses, set, where = "1 = 1", params: extra = [] }) => {
  const result = await db.batch([
    {
      text: `UPDATE coin_requests SET ${set} WHERE id = $1 AND status IN (${inList(fromStatuses)}) AND ${where}`,
      params: [requestId, ...extra],
    },
  ])
  return { ok: Number(result[0]?.changes ?? 0) === 1 }
}
