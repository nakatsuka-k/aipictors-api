// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { getNow } from "./db"
import { getPlanAmount, getPricingSettings } from "./pricing"
import { getNumber, getString } from "./record-fields"
import { grantReferralPaidReward } from "./referrals"
import { postStripeForm } from "./stripe"
import { getCurrentSubscription } from "./subscriptions"

/**
 * 自動更新なしのプラン（1 か月・1 年のパス）
 * Stripe の PayPay は自動更新の支払いに使えないので、PayPay で払いたい人のために 1 回払いでプランの期間を買えるようにする。
 * subscriptions に普通の契約と同じ形で 1 行入れるので、プランの特典（毎日のコイン・枚数・広告なし）はそのまま効く。
 * stripe_subscription_id は "prepaid:<決済の id>" にして、Stripe の契約の操作（解約・変更・休止）の対象から外す。
 * 期間中にもう一度買うと、同じ行の期間を延ばす。
 */
export var PREPAID_SUBSCRIPTION_PREFIX = "prepaid:"

export var isPrepaidSubscriptionId = (id) => typeof id === "string" && id.startsWith(PREPAID_SUBSCRIPTION_PREFIX)

/** Stripe の自動更新の契約か（アプリのストア・自動更新なしのパスを除く） */
export var isStripeSubscriptionId = (id) => typeof id === "string" && id.startsWith("sub_")

/** 期間を足す（1 か月 = 暦の 1 か月、1 年 = 暦の 1 年） */
export var addPrepaidInterval = (seconds, interval) => {
  const date = new Date(seconds * 1000)
  if (interval === "year") {
    date.setUTCFullYear(date.getUTCFullYear() + 1)
  } else {
    date.setUTCMonth(date.getUTCMonth() + 1)
  }
  return Math.floor(date.getTime() / 1000)
}

export var getActivePrepaidSubscription = async (db, userId) =>
  db.queryOne(
    `SELECT * FROM subscriptions
      WHERE user_id = $1 AND is_disabled = FALSE AND current_period_end > unixepoch()
        AND stripe_subscription_id LIKE 'prepaid:%'
      ORDER BY current_period_end DESC LIMIT 1`,
    [String(userId)]
  )

/**
 * 決済画面を作る前の確認。自動更新の契約に入っている人・別のプランのパスを使っている人は断る
 */
export var checkPrepaidPassAvailability = async (db, userId, passType) => {
  const current = await getCurrentSubscription(db, String(userId))
  if (!current) return null
  if (!isPrepaidSubscriptionId(getString(current, "stripe_subscription_id"))) {
    return "すでに自動更新のプランに加入しています。期間の終わりに解約してからお申し込みください。"
  }
  if (getString(current, "type") !== passType) {
    return "今のパスと違うプランは、今のパスの期限が切れてから購入できます。"
  }
  return null
}

export var createPrepaidPassCheckout = async (props) => {
  const pricing = await getPricingSettings(props.db)
  const interval = props.interval === "year" ? "year" : "month"
  const amount = getPlanAmount(pricing, props.passType, interval)
  const params = new URLSearchParams()
  params.set("mode", "payment")
  params.set("success_url", `${props.origin}/plus/success?prepaid=1&session_id={CHECKOUT_SESSION_ID}`)
  params.set("cancel_url", `${props.origin}/plus`)
  params.set("client_reference_id", props.userId)
  params.set("line_items[0][quantity]", "1")
  params.set("line_items[0][price_data][currency]", "jpy")
  params.set("line_items[0][price_data][unit_amount]", String(amount))
  params.set(
    "line_items[0][price_data][product_data][name]",
    `Aipictors ${props.passType} ${interval === "year" ? "1年" : "1か月"}パス（自動更新なし）`
  )
  for (const key of ["metadata", "payment_intent_data[metadata]"]) {
    params.set(`${key}[kind]`, "prepaid_pass")
    params.set(`${key}[user_id]`, props.userId)
    params.set(`${key}[pass_type]`, props.passType)
    params.set(`${key}[interval]`, interval)
    params.set(`${key}[price_yen]`, String(amount))
  }
  return postStripeForm(props.secretKey, params)
}

/**
 * 支払われたパスを反映する（webhook と決済後の画面の両方から呼ぶ。同じ決済は 1 回だけ反映する）
 */
export var applyPrepaidPass = async (db, props) => {
  const existing = await db.queryOne(
    "SELECT * FROM prepaid_pass_purchases WHERE stripe_session_id = $1",
    [props.sessionId]
  )
  if (existing) {
    return { created: false, periodEnd: Number(existing.period_end), passType: existing.pass_type }
  }
  const now = getNow()
  const interval = props.interval === "year" ? "year" : "month"
  const active = await getActivePrepaidSubscription(db, props.userId)
  let nanoid
  let periodStart
  let periodEnd
  if (active && getString(active, "type") === props.passType) {
    // 同じプランのパスが残っていれば、その終わりから延ばす
    nanoid = getString(active, "nanoid")
    periodStart = Number(active.current_period_end)
    periodEnd = addPrepaidInterval(Math.max(now, periodStart), interval)
    await db.execute(
      "UPDATE subscriptions SET current_period_end = $1, stripe_latest_invoice_id = $2 WHERE nanoid = $3",
      [periodEnd, props.sessionId, nanoid]
    )
  } else {
    nanoid = crypto.randomUUID()
    periodStart = now
    periodEnd = addPrepaidInterval(now, interval)
    await db.execute(
      `INSERT INTO subscriptions(
        nanoid, user_id, type, status, is_disabled, created_at, current_period_start, current_period_end,
        stripe_subscription_id, stripe_latest_invoice_id, stripe_payment_intent_id
      ) VALUES ($1, $2, $3, 'paid', FALSE, $4, $4, $5, $6, $7, $8)`,
      [
        nanoid,
        String(props.userId),
        props.passType,
        now,
        periodEnd,
        `${PREPAID_SUBSCRIPTION_PREFIX}${props.sessionId}`,
        props.sessionId,
        props.paymentIntentId ?? null
      ]
    )
  }
  await db.execute(
    `INSERT INTO prepaid_pass_purchases(
      stripe_session_id, user_id, pass_type, interval, price_yen, stripe_payment_intent_id,
      subscription_nanoid, period_start, period_end, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (stripe_session_id) DO NOTHING`,
    [
      props.sessionId,
      String(props.userId),
      props.passType,
      interval,
      props.priceYen ?? 0,
      props.paymentIntentId ?? null,
      nanoid,
      periodStart,
      periodEnd,
      now
    ]
  )
  // 紹介特典: 紹介された人のはじめての支払いで、紹介した人にコインを付ける
  if ((props.priceYen ?? 0) > 0) {
    await grantReferralPaidReward({ db, userId: props.userId }).catch((error) => {
      console.warn("[prepaid-pass] failed to grant referral paid reward", error instanceof Error ? error.message : String(error))
    })
  }
  return { created: true, periodEnd, passType: props.passType }
}

/** Stripe の決済（checkout session）の内容から反映する。支払い済みでなければ反映しない */
export var applyPrepaidPassFromSession = async (db, session) => {
  const metadata = session?.metadata ?? {}
  if (getString(metadata, "kind") !== "prepaid_pass") {
    return { error: "Invalid checkout kind", status: 400 }
  }
  if (getString(session, "payment_status") !== "paid") {
    return { error: null, data: { reflected: false, paymentStatus: getString(session, "payment_status") } }
  }
  const passType = getString(metadata, "pass_type")
  if (!["LITE", "STANDARD", "PREMIUM"].includes(passType ?? "")) {
    return { error: "Invalid pass type", status: 400 }
  }
  const result = await applyPrepaidPass(db, {
    sessionId: getString(session, "id"),
    userId: getString(metadata, "user_id"),
    passType,
    interval: getString(metadata, "interval"),
    priceYen: getNumber(session, "amount_total") ?? Number.parseInt(getString(metadata, "price_yen") ?? "0", 10),
    paymentIntentId: getString(session, "payment_intent")
  })
  return { error: null, data: { reflected: true, ...result } }
}

// Stripe の PayPay が使える状態か（審査中は決済画面に出ない）。isolate ごとに 10 分使い回す
var paypayAvailability = { value: false, checkedAt: 0 }
export var isPaypayAvailable = async (secretKey, now = Date.now()) => {
  if (!secretKey) return false
  if (now - paypayAvailability.checkedAt < 10 * 60 * 1000) return paypayAvailability.value
  try {
    const response = await fetch("https://api.stripe.com/v1/account", {
      headers: { Authorization: `Bearer ${secretKey}` }
    })
    const account = await response.json()
    paypayAvailability = { value: account?.capabilities?.paypay_payments === "active", checkedAt: now }
  } catch (_error) {
    paypayAvailability = { value: false, checkedAt: now }
  }
  return paypayAvailability.value
}
