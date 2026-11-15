// @ts-nocheck
// 画面に出す報酬のまとめ（本人用・管理画面用）
import { getNow } from "../db"
import {
  CREATOR_PAYOUT_CLOSE_DAY,
  CREATOR_PAYOUT_CLOSE_DAYS,
  CREATOR_PAYOUT_NEW_ACCOUNT_DAYS,
  CREATOR_PAYOUT_NEW_ACCOUNT_MAX_YEN,
  CREATOR_PAYOUT_FEE_YEN,
  CREATOR_PAYOUT_MAX_YEN,
  CREATOR_PAYOUT_MIN_YEN,
  CREATOR_REWARD_HOLD_DAYS,
  CREATOR_REWARD_RATE_MILLIYEN,
  CREATOR_REWARD_TERMS_VERSION,
  canUseStripeOnboarding,
  getCreatorPayoutConfig,
  firstCloseForAvailableAt,
  milliyenToYen,
  nextCloseAt,
} from "./config"
import { getProfile, isPayoutReady } from "./profiles"

const toNum = (v) => Number(v ?? 0)

export const getPublicConfig = (env) => {
  const config = getCreatorPayoutConfig(env)
  return {
    enabled: config.enabled,
    termsVersion: CREATOR_REWARD_TERMS_VERSION,
    rateMilliyen: CREATOR_REWARD_RATE_MILLIYEN,
    holdDays: CREATOR_REWARD_HOLD_DAYS,
    minYen: CREATOR_PAYOUT_MIN_YEN,
    maxYen: CREATOR_PAYOUT_MAX_YEN,
    feeYen: CREATOR_PAYOUT_FEE_YEN,
    withholdingPpm: config.withholdingPpm,
    closeDay: CREATOR_PAYOUT_CLOSE_DAY,
    closeDays: CREATOR_PAYOUT_CLOSE_DAYS,
    newAccountDays: CREATOR_PAYOUT_NEW_ACCOUNT_DAYS,
    newAccountMaxYen: CREATOR_PAYOUT_NEW_ACCOUNT_MAX_YEN,
    stripeMode: config.stripeMode,
  }
}

/** 本人の報酬のまとめ（読み取りは 4 文。明細は新しい順に limit 件） */
export const getCreatorRewardSummary = async ({ db, env, userId, now = getNow(), limit = 50 }) => {
  const config = getCreatorPayoutConfig(env)
  const uid = String(userId)
  const [profile, totals, earnings, payouts] = await Promise.all([
    getProfile(db, uid),
    db.query(
      `SELECT status, CASE WHEN status = 'HELD' AND available_at > $2 THEN 1 ELSE 0 END AS holding,
              COALESCE(SUM(amount_milliyen), 0) AS amount, COALESCE(SUM(coins), 0) AS coins, COUNT(*) AS n
         FROM creator_earnings WHERE user_id = $1 GROUP BY 1, 2`,
      [uid, now],
    ),
    db.query(
      `SELECT id AS earning_id, kind, source, work_id, coins, amount_milliyen, status, available_at, payout_id, reversed_reason, created_at AS earned_at
         FROM creator_earnings WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
      [uid, Math.max(1, Math.min(200, limit))],
    ),
    db.query(
      `SELECT id AS payout_id, period, status, gross_yen, withholding_yen, fee_yen, net_yen, earnings_count, last_error, sent_at AS sent, created_at AS created
         FROM creator_payouts WHERE user_id = $1 ORDER BY period DESC LIMIT 24`,
      [uid],
    ),
  ])
  const sum = (pred) => totals.filter(pred).reduce((s, r) => s + toNum(r.amount), 0)
  const livemode = Boolean(config.stripeSecretKey?.startsWith("sk_live_"))
  return {
    config: getPublicConfig(env),
    joined: profile?.status === "JOINED",
    profile: profile
      ? {
          status: profile.status,
          termsVersion: profile.termsVersion,
          joinedAt: profile.joinedAt,
          hasAccount: Boolean(profile.stripeAccountId && profile.stripeLivemode === livemode),
          detailsSubmitted: profile.detailsSubmitted,
          payoutReady: isPayoutReady(profile, livemode),
          taxKind: profile.taxKind,
          requirements: profile.requirements,
          needsNewTerms: profile.termsVersion !== CREATOR_REWARD_TERMS_VERSION,
        }
      : null,
    onboardingAvailable: canUseStripeOnboarding(config, uid),
    balances: {
      // 保留中（まだ保留の日数がたっていない）
      holdingYen: milliyenToYen(sum((r) => r.status === "HELD" && toNum(r.holding) === 1)),
      // 保留明け（次の締めで振込の対象）
      availableYen: milliyenToYen(sum((r) => r.status === "HELD" && toNum(r.holding) === 0)),
      // 締め済み・振込待ち
      inPayoutYen: milliyenToYen(sum((r) => r.status === "IN_PAYOUT")),
      paidYen: milliyenToYen(sum((r) => r.status === "PAID")),
      reversedYen: milliyenToYen(sum((r) => r.status === "REVERSED")),
      totalCoins: totals.filter((r) => r.status !== "REVERSED").reduce((s, r) => s + toNum(r.coins), 0),
    },
    nextCloseAt: nextCloseAt(now),
    earnings: earnings.map((r) => ({
      id: toNum(r.earning_id),
      kind: r.kind,
      workId: r.work_id ?? null,
      fromProfile: String(r.source ?? "").startsWith("profile-support:") || String(r.source ?? "").startsWith("app-support:"),
      coins: toNum(r.coins),
      amountYen: toNum(r.amount_milliyen) / 1000,
      status: r.status === "HELD" && toNum(r.available_at) > now ? "HOLDING" : r.status,
      availableAt: toNum(r.available_at),
      // 振込予定（最短）: 保留が明けたあとの最初の締め。最低額・上限で次回以降になることがある
      expectedCloseAt: r.status === "HELD" && toNum(r.amount_milliyen) > 0 ? firstCloseForAvailableAt(toNum(r.available_at), now) : null,
      reversedReason: r.reversed_reason ?? null,
      createdAt: toNum(r.earned_at),
    })),
    payouts: payouts.map((r) => ({
      id: String(r.payout_id),
      period: r.period,
      status: r.status,
      grossYen: toNum(r.gross_yen),
      withholdingYen: toNum(r.withholding_yen),
      feeYen: toNum(r.fee_yen),
      netYen: toNum(r.net_yen),
      earningsCount: toNum(r.earnings_count),
      sentAt: r.sent ? toNum(r.sent) : null,
      createdAt: toNum(r.created),
      // 本人に見せる失敗の理由は大まかに
      error: r.status === "FAILED" ? "送金に失敗しました。運営が確認しています" : null,
    })),
  }
}

/** 管理画面: 振込の一覧 */
export const listPayoutsForAdmin = async ({ db, status = null, limit = 100, offset = 0 }) => {
  const rows = await db.query(
    `SELECT p.id AS payout_id, p.user_id, p.period, p.status, p.gross_yen, p.withholding_yen, p.fee_yen, p.net_yen, p.earnings_count,
            p.flags_json, p.stripe_account_id, p.stripe_livemode, p.stripe_transfer_id, p.attempts, p.last_error,
            p.approved_at AS approved, p.approved_by_user_id, p.sent_at AS sent, p.created_at AS created,
            pr.tax_kind, pr.approved_at AS first_approved
       FROM creator_payouts p LEFT JOIN creator_payout_profiles pr ON pr.user_id = p.user_id
      ${status ? "WHERE p.status = $3" : ""}
      ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`,
    status ? [limit, offset, status] : [limit, offset],
  )
  const totals = await db.query(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(net_yen), 0) AS net, COALESCE(SUM(withholding_yen), 0) AS withholding
       FROM creator_payouts GROUP BY status`,
  )
  return {
    payouts: rows.map((r) => ({
      id: String(r.payout_id),
      userId: String(r.user_id),
      period: r.period,
      status: r.status,
      grossYen: toNum(r.gross_yen),
      withholdingYen: toNum(r.withholding_yen),
      feeYen: toNum(r.fee_yen),
      netYen: toNum(r.net_yen),
      earningsCount: toNum(r.earnings_count),
      flags: r.flags_json ? JSON.parse(r.flags_json) : [],
      stripeAccountId: r.stripe_account_id,
      livemode: Number(r.stripe_livemode) === 1,
      stripeTransferId: r.stripe_transfer_id,
      attempts: toNum(r.attempts),
      lastError: r.last_error,
      approvedAt: r.approved ? toNum(r.approved) : null,
      approvedByUserId: r.approved_by_user_id,
      sentAt: r.sent ? toNum(r.sent) : null,
      createdAt: toNum(r.created),
      taxKind: r.tax_kind,
      isFirstPayout: !r.first_approved,
    })),
    totals: totals.map((r) => ({ status: r.status, count: toNum(r.n), netYen: toNum(r.net), withholdingYen: toNum(r.withholding) })),
  }
}

/** 管理画面: 参加者と報酬の合計（件数・金額だけ） */
export const getAdminOverview = async ({ db, now = getNow() }) => {
  const [profiles, earnings] = await Promise.all([
    db.query(
      `SELECT status, COUNT(*) AS n, SUM(CASE WHEN payouts_enabled = 1 AND transfers_active = 1 THEN 1 ELSE 0 END) AS ready
         FROM creator_payout_profiles GROUP BY status`,
    ),
    db.query(
      `SELECT status, CASE WHEN status = 'HELD' AND available_at > $1 THEN 1 ELSE 0 END AS holding,
              COUNT(*) AS n, COALESCE(SUM(amount_milliyen), 0) AS amount, COALESCE(SUM(coins), 0) AS coins
         FROM creator_earnings GROUP BY 1, 2`,
      [now],
    ),
  ])
  return {
    profiles: profiles.map((r) => ({ status: r.status, count: toNum(r.n), payoutReady: toNum(r.ready) })),
    earnings: earnings.map((r) => ({
      status: r.status === "HELD" && toNum(r.holding) === 1 ? "HOLDING" : r.status,
      count: toNum(r.n),
      coins: toNum(r.coins),
      yen: milliyenToYen(r.amount),
    })),
  }
}
