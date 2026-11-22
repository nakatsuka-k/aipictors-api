// @ts-nocheck
// 募集リクエストのコイン: 募集で預かる・取り下げ/締切で提案なし/運営のキャンセルで全額返す・採用で提案者に渡す。
// 有料リクエスト（../coin-requests/escrow.ts）と同じく「募集の行を条件付きで変える → 1 行変わったときだけコインを動かす」を 1 つの batch で行う
import { guard, guardCleanup, isGuardFailure } from "../db-d1"
import { expireAvailableCoins } from "../coins/balance"
import { calcSettlement } from "../coin-requests/config"
import { CREATOR_REWARD_HOLD_DAYS, CREATOR_REWARD_RATE_MILLIYEN } from "../creator-payouts/config"
import { DAY, REQUESTER_OPEN_MAX } from "./config"

// 報酬は購入したプレミアムコイン（有料の割合が 0 より大きいロット）だけで払う。
// 運営の付与・推しで受け取ったコインなど有料の割合が 0 のものは使えない（別のアカウントを通した換金を防ぐ）
const lotsSql = `SELECT id, remaining, paid_ratio_ppm,
               SUM(remaining) OVER (ORDER BY expires_at ASC NULLS LAST, id ASC) AS cumulative
          FROM coin_lots
         WHERE user_id = $1 AND coin_type = 'PREMIUM' AND paid_ratio_ppm > 0 AND remaining > 0`
const spendUpdatesSql = `SELECT id, paid_ratio_ppm, min(remaining, max($2 - (cumulative - remaining), 0)) AS spend
          FROM (${lotsSql}) WHERE max($2 - (cumulative - remaining), 0) > 0`
const spendTotalSql = `(SELECT COALESCE(SUM(spend), 0) FROM (${spendUpdatesSql}))`
const paidTotalSql = `(SELECT CAST(COALESCE(SUM(spend * paid_ratio_ppm), 0) AS INTEGER) / 1000000 FROM (${spendUpdatesSql}))`

const recalcBalance = (userParam, nowParam) => ({
  text: `UPDATE coin_balances
           SET free_balance = (SELECT COALESCE(SUM(remaining), 0) FROM coin_lots WHERE user_id = ${userParam} AND coin_type = 'FREE' AND remaining > 0),
               premium_balance = (SELECT COALESCE(SUM(remaining), 0) FROM coin_lots WHERE user_id = ${userParam} AND coin_type = 'PREMIUM' AND remaining > 0),
               updated_at = ${nowParam}
         WHERE user_id = ${userParam}`,
})

/** 報酬に使えるプレミアムコイン（購入した分）の残り */
export const getPaidPremiumBalance = async ({ db, userId, now }) => {
  const row = await db.queryOne(
    `SELECT COALESCE(SUM(remaining), 0) AS n FROM coin_lots WHERE user_id = $1 AND coin_type = 'PREMIUM' AND paid_ratio_ppm > 0 AND remaining > 0
        AND (expires_at IS NULL OR expires_at > $2)`,
    [String(userId), now],
  )
  return Number(row?.n ?? 0)
}

/**
 * 募集: 同時の募集数・残高を満たすときだけ募集の行を入れてコインを預かる。同じ client_key は 1 回だけ（二度押し）
 */
export const createEscrowedOpenRequest = async ({ db, now, input }) => {
  await expireAvailableCoins(db, input.requesterUserId, now)
  const params = [
    input.requesterUserId, // $1
    input.rewardCoins, // $2
    now, // $3
    input.clientKey, // $4
    input.title, // $5
    input.body, // $6
    JSON.stringify(input.referenceImageUrls ?? []), // $7
    input.isR18 ? 1 : 0, // $8
    input.deadlineAt, // $9
    input.showcaseAllowed ? 1 : 0, // $10
  ]
  const source = `'open-request:' || (SELECT id FROM open_requests WHERE requester_user_id = $1 AND client_key = $4)`
  try {
    const results = await db.batch([
      { text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at) VALUES ($1, 0, 0, $3) ON CONFLICT (user_id) DO NOTHING`, params },
      {
        text: `INSERT INTO open_requests(requester_user_id, client_key, title, body, reference_image_urls, is_r18, reward_coins, premium_spent, paid_coins,
                 status, deadline_at, showcase_allowed, created_at, updated_at)
               SELECT $1, $4, $5, $6, $7, $8, $2, ${spendTotalSql}, ${paidTotalSql}, 'OPEN', $9, $10, $3, $3
                WHERE ${spendTotalSql} >= $2
                  AND (SELECT COUNT(*) FROM open_requests WHERE requester_user_id = $1 AND status = 'OPEN') < ${REQUESTER_OPEN_MAX}
               ON CONFLICT (requester_user_id, client_key) DO NOTHING`,
        params,
      },
      guard("changes() = 1"),
      {
        text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
               SELECT $1, 'PREMIUM', -${spendTotalSql}, 'CONSUME', 'open request escrow', ${source}, $3, NULL WHERE ${spendTotalSql} > 0`,
        params,
      },
      {
        text: `UPDATE coin_lots SET remaining = coin_lots.remaining - updates.spend, updated_at = $3
                 FROM (${spendUpdatesSql}) AS updates WHERE coin_lots.id = updates.id`,
        params,
      },
      { ...recalcBalance("$1", "$3"), params },
      { text: `SELECT id FROM open_requests WHERE requester_user_id = $1 AND client_key = $4`, params },
      guardCleanup,
    ])
    return { ok: true, requestId: Number(results[results.length - 2].rows[0]?.id) }
  } catch (error) {
    if (!isGuardFailure(error)) throw error
    const existing = await db.queryOne(`SELECT id FROM open_requests WHERE requester_user_id = $1 AND client_key = $2`, [input.requesterUserId, input.clientKey])
    if (existing) return { ok: true, requestId: Number(existing.id), duplicated: true }
    const open = await db.queryOne(`SELECT COUNT(*) AS n FROM open_requests WHERE requester_user_id = $1 AND status = 'OPEN'`, [input.requesterUserId])
    if (Number(open?.n ?? 0) >= REQUESTER_OPEN_MAX) return { ok: false, code: "TOO_MANY_OPEN" }
    return { ok: false, code: "INSUFFICIENT_COINS" }
  }
}

/**
 * 全額返却: 募集中（OPEN）のときだけ toStatus に変えて、預かったプレミアムコインを有料の割合ごと依頼者に戻す。
 * where で条件を足せる（依頼者の取り下げは提案がまだ 0 件のときだけ）
 */
export const refundOpenRequest = async ({ db, now, requestId, toStatus, reason = null, actorUserId = null, where = "1 = 1" }) => {
  const params = [requestId, now, toStatus, reason, actorUserId]
  const source = `'open-request:' || $1`
  try {
    await db.batch([
      {
        text: `UPDATE open_requests SET status = $3, closed_reason = $4, closed_at = $2, closed_by_user_id = $5, updated_at = $2
                WHERE id = $1 AND status = 'OPEN' AND ${where}`,
        params,
      },
      guard("changes() = 1"),
      {
        text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
               SELECT requester_user_id, 0, 0, $2 FROM open_requests WHERE id = $1 ON CONFLICT (user_id) DO NOTHING`,
        params,
      },
      {
        text: `INSERT INTO coin_lots(user_id, coin_type, remaining, locked_amount, source_kind, source_ref_id, granted_by_user_id, expires_at, created_at, updated_at, paid_ratio_ppm)
               SELECT requester_user_id, 'PREMIUM', premium_spent, 0, 'REQUEST_REFUND', 'open-request:' || id, NULL, NULL, $2, $2,
                      max(1, min(1000000, (paid_coins * 1000000) / max(premium_spent, 1)))
                 FROM open_requests WHERE id = $1 AND premium_spent > 0`,
        params,
      },
      {
        text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
               SELECT requester_user_id, 'PREMIUM', premium_spent, 'GRANT', 'open request refund', ${source}, $2, NULL FROM open_requests WHERE id = $1 AND premium_spent > 0`,
        params,
      },
      { ...recalcBalance("(SELECT requester_user_id FROM open_requests WHERE id = $1)", "$2"), params },
      guardCleanup,
    ])
    return { ok: true }
  } catch (error) {
    if (isGuardFailure(error)) return { ok: false, code: "INVALID_STATE" }
    throw error
  }
}

/**
 * 採用: 募集中のときだけ toStatus にし、提案に採用の印を付け、手数料を引いた分を提案者へ。
 * 有料分は（eligible なら）報酬 creator_earnings（kind REQUEST）、残りはプレミアムコイン
 */
export const awardOpenRequest = async ({ db, now, request, proposal, toStatus, feePpm, eligible, actorUserId = null, reason = null }) => {
  const s = calcSettlement({ freeSpent: 0, premiumSpent: request.premium_spent, paidCoins: request.paid_coins, feePpm, eligible })
  const earnedMilliyen = s.earnedCoins * CREATOR_REWARD_RATE_MILLIYEN
  const params = [
    request.id, // $1
    now, // $2
    toStatus, // $3
    s.feeCoins, // $4
    s.earnedCoins, // $5
    earnedMilliyen, // $6
    s.settlePremiumCoins, // $7
    String(proposal.user_id), // $8
    String(request.requester_user_id), // $9
    Number(proposal.id), // $10
    CREATOR_REWARD_RATE_MILLIYEN, // $11
    now + CREATOR_REWARD_HOLD_DAYS * DAY, // $12
    actorUserId, // $13
    reason, // $14
  ]
  const source = `'open-request:' || $1`
  try {
    await db.batch([
      {
        text: `UPDATE open_requests SET status = $3, awarded_proposal_id = $10, awarded_user_id = $8, awarded_at = $2, fee_coins = $4, earned_coins = $5,
                      earned_milliyen = $6, settle_premium_coins = $7, closed_by_user_id = $13, closed_reason = $14, closed_at = $2, updated_at = $2
                WHERE id = $1 AND status = 'OPEN'`,
        params,
      },
      guard("changes() = 1"),
      {
        text: `UPDATE open_request_proposals SET is_awarded = 1, updated_at = $2 WHERE id = $10 AND request_id = $1 AND status = 'ACTIVE' AND user_id = $8 AND user_id <> $9`,
        params,
      },
      guard("changes() = 1"),
      { text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at) VALUES ($8, 0, 0, $2) ON CONFLICT (user_id) DO NOTHING`, params },
      {
        text: `INSERT INTO coin_lots(user_id, coin_type, remaining, locked_amount, source_kind, source_ref_id, granted_by_user_id, expires_at, created_at, updated_at, paid_ratio_ppm)
               SELECT $8, 'PREMIUM', $7, 0, 'REQUEST', 'open-request:' || $1, $9, NULL, $2, $2, 0 WHERE $7 > 0`,
        params,
      },
      {
        text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
               SELECT $8, 'PREMIUM', $7, 'GRANT', 'open request awarded', ${source}, $2, NULL WHERE $7 > 0`,
        params,
      },
      {
        text: `INSERT INTO creator_earnings(user_id, kind, source, sender_user_id, work_id, coins, rate_milliyen, amount_milliyen, status, available_at, created_at, updated_at)
               SELECT $8, 'REQUEST', ${source}, $9, NULL, $5, $11, $6, 'HELD', $12, $2, $2 WHERE $5 > 0`,
        params,
      },
      { ...recalcBalance("$8", "$2"), params },
      guardCleanup,
    ])
    return { ok: true, ...s, earnedMilliyen }
  } catch (error) {
    if (isGuardFailure(error)) return { ok: false, code: "INVALID_STATE" }
    throw error
  }
}
