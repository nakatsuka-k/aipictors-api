// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { getPlanAmount, getPricingSettings } from "./pricing"
import { isStripeSubscriptionId } from "./prepaid-pass"
import { getCurrentSubscription } from "./subscriptions"

/**
 * ライトからスタンダードへ上げる人の初月割引（初月 ¥980）
 * - ライトで毎日の上限に当たる人を上のプランへ。ライトの初月半額（¥240）で加入が増えたのと同じ「最初の 1 か月を安く」をプラン変更にも使う
 * - 対象: 今ライトの月払い（Stripe の自動更新）で、スタンダード・プレミアムに入ったことがなく、この割引をまだ使っていない人
 * - プラン変更のときに請求日をその日に置き直し、スタンダード 1 か月分からクーポン（Stripe、amount_off・once）を引く。ライトの残りの日数分は差し引く
 * wrangler の var STANDARD_UPGRADE_COUPON_ID を空にすると止まる
 */
export var STANDARD_UPGRADE_OFFER = "lite_to_standard_first_month"

export var getStandardUpgradeCouponId = (env) => {
  const value = String(env?.STANDARD_UPGRADE_COUPON_ID ?? "").trim()
  return value === "" ? null : value
}

/** クーポンで引く額（円）。初月の金額 = スタンダードの月額 - これ */
export var getStandardUpgradeDiscountYen = (env) => {
  const value = Number(env?.STANDARD_UPGRADE_DISCOUNT_JPY ?? 1000)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1000
}

var hasUsedOffer = async (db, userId) => {
  const row = await db.queryOne(
    "SELECT user_id FROM subscription_upgrade_offers WHERE user_id = $1 AND offer = $2",
    [String(userId), STANDARD_UPGRADE_OFFER]
  )
  return row !== null
}

// プラン変更は subscriptions の行の type を書き換えるので、今の行は見ない（今の行がライトなのは確かめ済み）
var hasHadHigherPlan = async (db, userId, currentNanoid) => {
  const row = await db.queryOne(
    `SELECT id FROM subscriptions
      WHERE user_id = $1 AND type IN ('STANDARD', 'PREMIUM') AND nanoid <> $2
      LIMIT 1`,
    [String(userId), currentNanoid ?? ""]
  )
  return row !== null
}

/**
 * 対象か（Stripe には聞かない。月払いかどうかはプラン変更のときに Stripe の契約で確かめる）
 * reason: disabled / no_subscription / not_lite / not_stripe / used / had_higher_plan
 */
export var getStandardUpgradeOffer = async (db, env, userId) => {
  const pricing = await getPricingSettings(db)
  const regularYen = getPlanAmount(pricing, "STANDARD", "month")
  const firstMonthYen = Math.max(0, regularYen - getStandardUpgradeDiscountYen(env))
  const base = { offer: STANDARD_UPGRADE_OFFER, passType: "STANDARD", regularYen, firstMonthYen }
  if (!getStandardUpgradeCouponId(env)) return { ...base, eligible: false, reason: "disabled" }
  const current = await getCurrentSubscription(db, String(userId))
  if (!current) return { ...base, eligible: false, reason: "no_subscription" }
  if (current.type !== "LITE") return { ...base, eligible: false, reason: "not_lite" }
  if (!isStripeSubscriptionId(current.stripe_subscription_id)) return { ...base, eligible: false, reason: "not_stripe" }
  if (await hasUsedOffer(db, userId)) return { ...base, eligible: false, reason: "used" }
  if (await hasHadHigherPlan(db, userId, current.nanoid)) return { ...base, eligible: false, reason: "had_higher_plan" }
  return { ...base, eligible: true, reason: null }
}

/**
 * プラン変更（ライト → スタンダード）の Stripe のフォームに割引を足す。
 * 請求日をその日に置き直して 1 か月分を請求し、ライトの残りは差し引き、クーポンを 1 回だけ当てる
 * preview: プレビュー（/invoices/create_preview）は subscription_details[...] に入れる
 * trialing: 無料お試し中は trial_end=now で請求日が置き直るので billing_cycle_anchor は付けない（両方は付けられない）
 */
export var applyStandardUpgradeOffer = (form, couponId, { preview = false, trialing = false } = {}) => {
  if (preview) {
    if (!trialing) form.set("subscription_details[billing_cycle_anchor]", "now")
    form.set("discounts[0][coupon]", couponId)
  } else {
    if (!trialing) form.set("billing_cycle_anchor", "now")
    form.set("discounts[0][coupon]", couponId)
    form.set("metadata[upgrade_offer]", STANDARD_UPGRADE_OFFER)
  }
}

export var markStandardUpgradeOfferUsed = async (db, userId, stripeSubscriptionId, now = Math.floor(Date.now() / 1000)) => {
  await db.execute(
    `INSERT INTO subscription_upgrade_offers (user_id, offer, stripe_subscription_id, used_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, offer) DO NOTHING`,
    [String(userId), STANDARD_UPGRADE_OFFER, stripeSubscriptionId ?? null, now]
  )
}
