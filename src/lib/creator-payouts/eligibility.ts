// @ts-nocheck
// 推しを報酬にしてよいかの判定（推しの batch の前に呼ぶ。読み取りは参加者の 1 行と、参加者のときだけ core の作品 1 行）
import {
  ADULT_AGE_LIMITS,
  CREATOR_REWARD_HOLD_DAYS,
  CREATOR_REWARD_RATE_MILLIYEN,
  getCreatorPayoutConfig,
  workIdFromSupportSource,
} from "./config"

const ADULT_LIST = ADULT_AGE_LIMITS.join(", ")

/**
 * 推しを報酬にするか。返すのは transferSupportCoins の earnings（報酬にしないときは null）と理由
 * - プレミアムコインの推しだけ（無料コインはそもそもコインを渡さない）
 * - 受け取る人が報酬プログラムに参加中（JOINED）
 * - 作品経由なら、その作品が受け取る人の公開中の全年齢（G / R15）作品
 * - 作品を通さない推し（プロフィール・アプリの推し）は、受け取る人の公開作品に R18 / R18G が 1 件もないとき
 * - core（作品の DB）が読めないときは報酬にしない（コインで渡す）
 */
export const decideSupportEarnings = async ({ db, core, env, senderUserId, recipientUserId, coinType, workId, source }) => {
  const config = getCreatorPayoutConfig(env)
  if (!config.enabled) return { earnings: null, reason: "disabled" }
  if (coinType !== "PREMIUM") return { earnings: null, reason: "free_coin" }
  if (String(senderUserId) === String(recipientUserId)) return { earnings: null, reason: "self" }
  const profile = await db.queryOne(`SELECT status FROM creator_payout_profiles WHERE user_id = $1`, [String(recipientUserId)])
  if (!profile || profile.status !== "JOINED") return { earnings: null, reason: "not_joined" }
  if (!core) return { earnings: null, reason: "core_unavailable" }
  const resolvedWorkId = workId ? String(workId) : workIdFromSupportSource(source)
  try {
    if (resolvedWorkId && /^\d+$/.test(resolvedWorkId)) {
      const work = await core
        .prepare(`SELECT userId AS user_id, ageLimit AS age_limit, is_deleted FROM works WHERE id = ?`)
        .bind(Number(resolvedWorkId))
        .first()
      if (!work || Number(work.is_deleted) !== 0) return { earnings: null, reason: "work_not_found" }
      if (String(work.user_id) !== String(recipientUserId)) return { earnings: null, reason: "work_owner_mismatch" }
      if (ADULT_AGE_LIMITS.includes(Number(work.age_limit))) return { earnings: null, reason: "adult_work" }
      return {
        earnings: { workId: resolvedWorkId, rateMilliyen: CREATOR_REWARD_RATE_MILLIYEN, holdDays: CREATOR_REWARD_HOLD_DAYS },
        reason: "work",
      }
    }
    // 作品を通さない推し: R18 / R18G の作品を公開している人には報酬にしない（Stripe でアダルトを扱わない）
    const adult = await core
      .prepare(`SELECT 1 AS hit FROM works WHERE userId = ? AND ageLimit IN (${ADULT_LIST}) AND is_deleted = 0 LIMIT 1`)
      .bind(Number(recipientUserId))
      .first()
    if (adult) return { earnings: null, reason: "adult_creator" }
    return {
      earnings: { workId: null, rateMilliyen: CREATOR_REWARD_RATE_MILLIYEN, holdDays: CREATOR_REWARD_HOLD_DAYS },
      reason: "profile",
    }
  } catch (error) {
    console.log(JSON.stringify({ event: "creator_payouts.eligibility_failed", message: String(error?.message ?? error) }))
    return { earnings: null, reason: "core_error" }
  }
}
