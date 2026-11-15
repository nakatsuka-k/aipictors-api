// @ts-nocheck
// 報酬プログラムへの参加と、Stripe の連結アカウント（口座登録）
import { getNow } from "../db"
import { CREATOR_REWARD_TERMS_VERSION, canUseStripeOnboarding, getCreatorPayoutConfig } from "./config"
import { createStripeClient, toAccountState } from "./stripe-connect"

export const getProfile = async (db, userId) => {
  const row = await db.queryOne(
    `SELECT user_id, status, terms_version, joined_at, stripe_account_id, stripe_livemode, details_submitted,
            payouts_enabled, payouts_enabled_at, transfers_active, tax_kind, requirements_json, email, approved_at, note
       FROM creator_payout_profiles WHERE user_id = $1`,
    [String(userId)],
  )
  if (!row) return null
  return {
    userId: String(row.user_id),
    status: row.status,
    termsVersion: row.terms_version,
    joinedAt: Number(row.joined_at),
    stripeAccountId: row.stripe_account_id ?? null,
    stripeLivemode: row.stripe_livemode === null || row.stripe_livemode === undefined ? null : Number(row.stripe_livemode) === 1,
    detailsSubmitted: Number(row.details_submitted) === 1,
    payoutsEnabled: Number(row.payouts_enabled) === 1,
    // 本人確認が済んで入金できるようになった日時（新しい口座の 1 回の上限に使う）
    payoutsEnabledAt: row.payouts_enabled_at ? Number(row.payouts_enabled_at) : null,
    transfersActive: Number(row.transfers_active) === 1,
    taxKind: row.tax_kind ?? null,
    requirements: row.requirements_json ? JSON.parse(row.requirements_json) : null,
    email: row.email ?? null,
    approvedAt: row.approved_at ? Number(row.approved_at) : null,
    note: row.note ?? null,
  }
}

/** 今の Stripe のモードで送金できるアカウントがあるか */
export const isPayoutReady = (profile, livemode) =>
  Boolean(
    profile?.stripeAccountId &&
      profile.stripeLivemode === livemode &&
      profile.detailsSubmitted &&
      profile.payoutsEnabled &&
      profile.transfersActive,
  )

/** 参加する（報酬規約への同意）。やめた人の再参加も同じ */
export const joinCreatorRewards = async ({ db, env, userId, termsVersion, now = getNow() }) => {
  const config = getCreatorPayoutConfig(env)
  if (!config.enabled) return { ok: false, code: "DISABLED" }
  if (termsVersion !== CREATOR_REWARD_TERMS_VERSION) return { ok: false, code: "TERMS_OUTDATED" }
  const existing = await getProfile(db, userId)
  if (existing?.status === "SUSPENDED") return { ok: false, code: "SUSPENDED" }
  await db.execute(
    `INSERT INTO creator_payout_profiles(user_id, status, terms_version, joined_at, created_at, updated_at)
     VALUES ($1, 'JOINED', $2, $3, $3, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       status = CASE WHEN creator_payout_profiles.status = 'SUSPENDED' THEN 'SUSPENDED' ELSE 'JOINED' END,
       terms_version = EXCLUDED.terms_version,
       joined_at = CASE WHEN creator_payout_profiles.status = 'JOINED' THEN creator_payout_profiles.joined_at ELSE EXCLUDED.joined_at END,
       updated_at = EXCLUDED.updated_at`,
    [String(userId), termsVersion, now],
  )
  return { ok: true, profile: await getProfile(db, userId) }
}

/** やめる（以後の推しはコインで受け取る。たまっている報酬はそのまま振込の対象） */
export const leaveCreatorRewards = async ({ db, userId, now = getNow() }) => {
  const result = await db.executeResult(
    `UPDATE creator_payout_profiles SET status = 'LEFT', updated_at = $2 WHERE user_id = $1 AND status = 'JOINED'`,
    [String(userId), now],
  )
  return { ok: result.rowCount > 0 }
}

const saveAccountState = async (db, userId, account, livemode, now) => {
  const state = toAccountState(account)
  await db.execute(
    `UPDATE creator_payout_profiles
        SET stripe_account_id = $2, stripe_livemode = $3, details_submitted = $4, payouts_enabled = $5,
            payouts_enabled_at = CASE WHEN $5 = 1 THEN COALESCE(payouts_enabled_at, $10) ELSE payouts_enabled_at END,
            transfers_active = $6, tax_kind = COALESCE($7, tax_kind), requirements_json = $8,
            email = COALESCE($9, email), updated_at = $10
      WHERE user_id = $1`,
    [
      String(userId),
      account.id,
      livemode ? 1 : 0,
      state.detailsSubmitted,
      state.payoutsEnabled,
      state.transfersActive,
      state.taxKind,
      JSON.stringify(state.requirements),
      state.email,
      now,
    ],
  )
  return state
}

/**
 * 口座登録（本人確認）の画面の URL。アカウントがなければ作る（モードが違うアカウントは作り直す）
 */
export const createOnboardingLink = async ({ db, env, userId, email, returnUrl, refreshUrl, fetchImpl, now = getNow() }) => {
  const config = getCreatorPayoutConfig(env)
  if (!config.enabled) return { ok: false, code: "DISABLED" }
  if (!canUseStripeOnboarding(config, userId)) return { ok: false, code: "ONBOARDING_NOT_AVAILABLE" }
  const profile = await getProfile(db, userId)
  if (!profile || profile.status !== "JOINED") return { ok: false, code: "NOT_JOINED" }
  const stripe = createStripeClient({ secretKey: config.stripeSecretKey, fetchImpl })
  let accountId = profile.stripeAccountId
  if (!accountId || profile.stripeLivemode !== stripe.livemode) {
    const account = await stripe.createExpressAccount({ userId, email, siteOrigin: config.siteOrigin })
    // 同じアカウントが 2 人に付かないよう、まだ無いときだけ書く（同時に 2 回押されたら先の方を使う）
    await db.execute(
      `UPDATE creator_payout_profiles SET stripe_account_id = $2, stripe_livemode = $3, details_submitted = 0,
              payouts_enabled = 0, payouts_enabled_at = NULL, transfers_active = 0, updated_at = $4
        WHERE user_id = $1 AND (stripe_account_id IS NULL OR stripe_livemode IS NOT $3)`,
      [String(userId), account.id, stripe.livemode ? 1 : 0, now],
    )
    accountId = (await getProfile(db, userId)).stripeAccountId
  }
  const link = await stripe.createAccountLink({ accountId, returnUrl, refreshUrl })
  return { ok: true, url: link.url, expiresAt: link.expires_at }
}

/** 口座の変更・入金の確認（Stripe の Express ダッシュボード） */
export const createDashboardLink = async ({ db, env, userId, fetchImpl }) => {
  const config = getCreatorPayoutConfig(env)
  if (!canUseStripeOnboarding(config, userId)) return { ok: false, code: "ONBOARDING_NOT_AVAILABLE" }
  const profile = await getProfile(db, userId)
  const stripe = createStripeClient({ secretKey: config.stripeSecretKey, fetchImpl })
  if (!profile?.stripeAccountId || profile.stripeLivemode !== stripe.livemode || !profile.detailsSubmitted) {
    return { ok: false, code: "NO_ACCOUNT" }
  }
  const link = await stripe.createLoginLink(profile.stripeAccountId)
  return { ok: true, url: link.url }
}

/** Stripe からアカウントの状態を読み直す（口座登録から戻ってきたとき） */
export const refreshAccount = async ({ db, env, userId, fetchImpl, now = getNow() }) => {
  const config = getCreatorPayoutConfig(env)
  const profile = await getProfile(db, userId)
  if (!profile?.stripeAccountId || !config.stripeSecretKey) return { ok: false, code: "NO_ACCOUNT" }
  const stripe = createStripeClient({ secretKey: config.stripeSecretKey, fetchImpl })
  if (profile.stripeLivemode !== stripe.livemode) return { ok: false, code: "MODE_MISMATCH" }
  const account = await stripe.retrieveAccount(profile.stripeAccountId)
  await saveAccountState(db, userId, account, stripe.livemode, now)
  return { ok: true, profile: await getProfile(db, userId) }
}

/** Connect の webhook（account.updated）。アカウント ID から利用者を探して状態を保存する */
export const applyAccountUpdated = async ({ db, account, livemode, now = getNow() }) => {
  const row = await db.queryOne(`SELECT user_id FROM creator_payout_profiles WHERE stripe_account_id = $1`, [account.id])
  if (!row) return { ok: false, code: "UNKNOWN_ACCOUNT" }
  await saveAccountState(db, String(row.user_id), account, livemode, now)
  return { ok: true, userId: String(row.user_id) }
}
