// @ts-nocheck
// 推す相手の受け取りの設定（推す画面と推しの受付で使う）
import { getCreatorPayoutConfig } from "../creator-payouts/config"

export const PREMIUM_SUPPORT_REJECTED_MESSAGE = "この作者はプレミアムコインでの応援を受け付けていません"
export const SUPPORT_REJECTED_MESSAGE = "この作者は推しを受け付けていません"
export const PREMIUM_SUPPORT_ORIGINAL_ONLY_MESSAGE = "プレミアムコインでの推しは、オリジナル作品（「オリジナル」などのタグが付いた作品）だけに使えます"

/**
 * オリジナル作品とみなすタグ（Web のホーム「オリジナルのみ」の ORIGINAL_WORK_TAG_NAMES と同じ。tags.name は NOCASE）。
 * 二次創作にお金が動かないよう、プレミアムコインの推しはこのタグが付いた作品だけ（作者の申告）
 */
export const ORIGINAL_WORK_TAG_NAMES = ["オリジナル", "オリジナルキャラ", "オリジナルキャラクター", "オリキャラ", "創作", "一次創作", "original"]

/** 受け取る人の作品で、オリジナル系のタグが付いているか（core の works・work_tags を作品 id で読む）。読めないときは付いていない扱い */
export const isOriginalWorkForSupport = async (core, workId, recipientUserId) => {
  if (!core || !/^\d+$/.test(String(workId ?? "")) || !/^\d+$/.test(String(recipientUserId ?? ""))) return false
  try {
    const row = await core
      .prepare(
        `SELECT 1 AS hit FROM works w JOIN work_tags t ON t.work_id = w.id JOIN tags g ON g.id = t.tag_id WHERE w.id = ? AND w.userId = ? AND w.is_deleted = 0 AND t.is_deleted = 0 AND g.name IN (${ORIGINAL_WORK_TAG_NAMES.map(() => "?").join(", ")}) LIMIT 1`,
      )
      .bind(Number(workId), Number(recipientUserId), ...ORIGINAL_WORK_TAG_NAMES)
      .first()
    return Boolean(row?.hit)
  } catch (error) {
    console.log(JSON.stringify({ event: "coin_support.original_check_failed", message: String(error?.message ?? error) }))
    return false
  }
}

/**
 * 受け取る人の推しの設定（core の user_settings、Web・アプリの設定で変える）。
 * rejectPremium: プレミアムコインでの推しを受け取らない（reject_premium_coin_support）
 * rejectFreeReceive: フリーコインで推されてもフリーコインを受け取らない、pt だけ付く（reject_free_coin_support_receive）
 * rejectAll: 推しをすべて受け付けない、プレミアム・フリーとも（reject_coin_support）
 * core が読めない・列がまだ無いときは受け取る扱い（推しを止めない）
 */
export const getSupportRecipientSettings = async (core, recipientUserId) => {
  const none = { rejectPremium: false, rejectFreeReceive: false, rejectAll: false }
  if (!core || !/^\d+$/.test(String(recipientUserId ?? ""))) return none
  try {
    const row = await core
      .prepare(`SELECT reject_premium_coin_support AS premium, reject_free_coin_support_receive AS free, reject_coin_support AS all_support FROM user_settings WHERE userId = ?`)
      .bind(Number(recipientUserId))
      .first()
    return {
      rejectPremium: Number(row?.premium ?? 0) === 1,
      rejectFreeReceive: Number(row?.free ?? 0) === 1,
      rejectAll: Number(row?.all_support ?? 0) === 1,
    }
  } catch (error) {
    console.log(JSON.stringify({ event: "coin_support.recipient_setting_failed", message: String(error?.message ?? error) }))
    return none
  }
}

export const isPremiumSupportRejected = async (core, recipientUserId) =>
  (await getSupportRecipientSettings(core, recipientUserId)).rejectPremium

/** 推す画面に出す相手の状態。supportAccepted: 推しを受け付けている、premiumAccepted: プレミアムコインで推せる、freeReceiveAccepted: フリーコインの推しがコインとして届く、rewardJoined: クリエイター報酬に参加中 */
export const getSupportRecipientStatus = async ({ db, core, env, recipientUserId }) => {
  const [settings, profile] = await Promise.all([
    getSupportRecipientSettings(core, recipientUserId),
    getCreatorPayoutConfig(env).enabled
      ? db.queryOne(`SELECT status FROM creator_payout_profiles WHERE user_id = $1`, [String(recipientUserId)])
      : Promise.resolve(null),
  ])
  return {
    userId: String(recipientUserId),
    supportAccepted: !settings.rejectAll,
    premiumAccepted: !settings.rejectAll && !settings.rejectPremium,
    freeReceiveAccepted: !settings.rejectFreeReceive,
    rewardJoined: profile?.status === "JOINED",
  }
}
