// @ts-nocheck
// 推す相手の受け取りの設定（推す画面と推しの受付で使う）
import { getCreatorPayoutConfig } from "../creator-payouts/config"

export const PREMIUM_SUPPORT_REJECTED_MESSAGE = "この作者はプレミアムコインでの応援を受け付けていません"

/**
 * プレミアムコインでの推しを受け取らない設定（core の user_settings.reject_premium_coin_support、Web・アプリの設定で変える）。
 * core が読めない・列がまだ無いときは受け取る扱い（推しを止めない）
 */
export const isPremiumSupportRejected = async (core, recipientUserId) => {
  if (!core || !/^\d+$/.test(String(recipientUserId ?? ""))) return false
  try {
    const row = await core
      .prepare(`SELECT reject_premium_coin_support AS rejected FROM user_settings WHERE userId = ?`)
      .bind(Number(recipientUserId))
      .first()
    return Number(row?.rejected ?? 0) === 1
  } catch (error) {
    console.log(JSON.stringify({ event: "coin_support.recipient_setting_failed", message: String(error?.message ?? error) }))
    return false
  }
}

/** 推す画面に出す相手の状態。premiumAccepted: プレミアムコインで推せる、rewardJoined: クリエイター報酬に参加中 */
export const getSupportRecipientStatus = async ({ db, core, env, recipientUserId }) => {
  const [rejected, profile] = await Promise.all([
    isPremiumSupportRejected(core, recipientUserId),
    getCreatorPayoutConfig(env).enabled
      ? db.queryOne(`SELECT status FROM creator_payout_profiles WHERE user_id = $1`, [String(recipientUserId)])
      : Promise.resolve(null),
  ])
  return { userId: String(recipientUserId), premiumAccepted: !rejected, rewardJoined: profile?.status === "JOINED" }
}
