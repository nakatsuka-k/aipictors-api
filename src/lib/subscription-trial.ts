// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { getNow } from "./db"
import { getPlanAmount, getPricingSettings } from "./pricing"
import { getNumber, getRecord, getString } from "./record-fields"
import { escapeHtml, formatJstDate } from "./subscription-cancellation-email"
import { getStripe, getStripeCustomerEmail } from "./subscription-stripe"

/**
 * ライトプランの 7 日間無料お試し
 * - 対象は、これまで一度もプランに入ったことがない人（subscriptions に行がない = Stripe・自動更新なしのパス・アプリのストアのどれもない）。1 人 1 回
 * - ライトの月払いだけ。カードを登録し、7 日間は ¥0、8 日目から通常の月額で自動更新（初月半額は付けない）
 * - 同じカードでの 2 回目を防ぐ: お試しの開始（¥0 の請求の成功）でカードの fingerprint を記録し、
 *   別の人が同じ fingerprint で始めたら、その契約をすぐ解約する（請求は発生しない）
 * 日数は wrangler の var LITE_TRIAL_DAYS（空にすると止まる）
 */
export var TRIAL_PASS_TYPE = "LITE"

export var getTrialDays = (env) => {
  const days = Number.parseInt(String(env?.LITE_TRIAL_DAYS ?? ""), 10)
  return Number.isFinite(days) && days > 0 && days <= 30 ? days : 0
}

// お試しを使ったことになる状態（カードの重複などで断った分は含めない。別のカードでやり直せる）
var USED_TRIAL_STATUSES = "('trialing', 'converted', 'canceled')"

/**
 * お試しの対象か。対象外のときは reason に理由を入れる
 * - has_subscription_history: プランに入ったことがある（今入っている人も含む）
 * - trial_used: お試しを使ったことがある
 * - disabled: お試しを止めている
 */
export var getTrialEligibility = async (db, env, userId) => {
  const trialDays = getTrialDays(env)
  if (trialDays === 0) return { eligible: false, reason: "disabled", trialDays: 0 }
  const [subscription, prepaid, trial] = await Promise.all([
    db.queryOne("SELECT id FROM subscriptions WHERE user_id = $1 LIMIT 1", [String(userId)]),
    db.queryOne("SELECT stripe_session_id FROM prepaid_pass_purchases WHERE user_id = $1 LIMIT 1", [String(userId)]),
    db.queryOne(`SELECT id FROM subscription_trials WHERE user_id = $1 AND status IN ${USED_TRIAL_STATUSES} LIMIT 1`, [String(userId)])
  ])
  if (trial) return { eligible: false, reason: "trial_used", trialDays }
  if (subscription || prepaid) return { eligible: false, reason: "has_subscription_history", trialDays }
  return { eligible: true, reason: null, trialDays }
}

/** 画面に返すお試しの内容（対象かどうか・日数・その後の料金・直近のお試しの状態） */
export var getTrialOffer = async (db, env, userId) => {
  const [eligibility, pricing, latest] = await Promise.all([
    getTrialEligibility(db, env, userId),
    getPricingSettings(db),
    getLatestTrial(db, userId)
  ])
  return {
    eligible: eligibility.eligible,
    reason: eligibility.reason,
    trialDays: eligibility.trialDays,
    passType: TRIAL_PASS_TYPE,
    priceYenAfterTrial: getPlanAmount(pricing, TRIAL_PASS_TYPE, "month"),
    latestTrial: latest
      ? {
          status: getString(latest, "status"),
          trialEnd: getNumber(latest, "trial_end"),
          createdAt: getNumber(latest, "created_at")
        }
      : null
  }
}

export var getLatestTrial = async (db, userId) =>
  db.queryOne("SELECT * FROM subscription_trials WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [String(userId)])

export var getTrialByStripeSubscriptionId = async (db, stripeSubscriptionId) =>
  stripeSubscriptionId
    ? db.queryOne("SELECT * FROM subscription_trials WHERE stripe_subscription_id = $1 LIMIT 1", [stripeSubscriptionId])
    : null

/** 決済画面の送信ボタンの下に出す文（日本語と英語。Stripe の custom_text は 1 つの文しか置けない） */
export var buildTrialSubmitMessage = (props) => {
  const end = props.now + props.trialDays * 86400
  const ja = formatJstDate(end)
  const en = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric", month: "short", day: "numeric" }).format(new Date(end * 1e3))
  const yen = props.amount.toLocaleString("en-US")
  return [
    `${props.trialDays}日間は無料です。無料期間の終了日（本日お申し込みの場合は${ja}）以降、月額¥${yen}が自動で課金され、以後は毎月自動で更新されます。`,
    "無料期間中を含め、プランのページからいつでも解約できます（無料期間中に解約すれば請求はありません）。無料お試しは1人1回です。",
    `Free for ${props.trialDays} days. After the trial ends (${en} if you start today), you will be charged ¥${yen}/month automatically and the plan renews monthly.`,
    "You can cancel anytime from the plan page — no charge if you cancel during the trial. One free trial per person."
  ].join(" ")
}

/** 契約に付いているカードの fingerprint（カード以外・取れないときは null） */
export var getCardFingerprint = (stripeSubscription) => {
  const paymentMethod = getRecord(stripeSubscription ?? {}, "default_payment_method")
  const card = getRecord(paymentMethod ?? {}, "card")
  return card ? getString(card, "fingerprint") : null
}

var cancelStripeSubscriptionNow = async (secretKey, stripeSubscriptionId) => {
  // お試し中の即時解約。請求書は作らない（invoice_now / prorate は既定で false）
  const response = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubscriptionId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${secretKey}` }
  })
  return response.json()
}

/**
 * お試しの開始（¥0 の請求の成功）を記録する。
 * 同じカードを別の人が使っていた・同じ人の 2 回目だったときは、契約をすぐ解約して rejected を返す（呼び出し元は subscriptions に行を作らない）
 */
export var startTrial = async (props) => {
  const { db, secretKey, userId, stripeSubscriptionId } = props
  const existing = await getTrialByStripeSubscriptionId(db, stripeSubscriptionId)
  if (existing) {
    // webhook の再送。前回の結果をそのまま返す
    const status = getString(existing, "status")
    return { rejected: status?.startsWith("rejected_") ?? false, status, trialStart: getNumber(existing, "trial_start"), trialEnd: getNumber(existing, "trial_end") }
  }
  const stripeSubscription = await getStripe(secretKey, `/subscriptions/${stripeSubscriptionId}?expand[]=default_payment_method`)
  if (stripeSubscription?.error?.message) {
    throw new Error(`Stripe subscription fetch failed: ${stripeSubscription.error.message}`)
  }
  let fingerprint = getCardFingerprint(stripeSubscription)
  const customerId = getString(stripeSubscription, "customer")
  if (fingerprint === null && customerId) {
    // 契約に支払い方法が付いていないときは、顧客に登録されたカードから読む
    const methods = await getStripe(secretKey, `/payment_methods?customer=${customerId}&type=card&limit=1`).catch(() => null)
    const card = getRecord(methods?.data?.[0] ?? {}, "card")
    fingerprint = card ? getString(card, "fingerprint") : null
  }
  const now = getNow()
  const trialStart = getNumber(stripeSubscription, "trial_start") ?? now
  const trialEnd = getNumber(stripeSubscription, "trial_end") ?? props.periodEnd ?? null
  const [sameCard, sameUser, otherSubscription] = await Promise.all([
    fingerprint
      ? db.queryOne(
          `SELECT id FROM subscription_trials
            WHERE card_fingerprint = $1 AND user_id <> $2 AND status IN ${USED_TRIAL_STATUSES} LIMIT 1`,
          [fingerprint, String(userId)]
        )
      : null,
    db.queryOne(`SELECT id FROM subscription_trials WHERE user_id = $1 AND status IN ${USED_TRIAL_STATUSES} LIMIT 1`, [String(userId)]),
    // 決済画面を 2 つ開いて両方で申し込んだ・お試しの決済画面を開いたあとで別のプランに入った
    db.queryOne("SELECT id FROM subscriptions WHERE user_id = $1 AND stripe_subscription_id <> $2 LIMIT 1", [String(userId), stripeSubscriptionId])
  ])
  const status = sameCard ? "rejected_duplicate_card" : sameUser || otherSubscription ? "rejected_repeat" : "trialing"
  if (status !== "trialing") {
    const canceled = await cancelStripeSubscriptionNow(secretKey, stripeSubscriptionId)
    if (canceled?.error?.message && canceled.error.code !== "resource_missing") {
      // 解約できなかったら記録せずに失敗させる（Stripe が webhook を再送するので、もう一度試される）
      throw new Error(`Stripe subscription cancel failed: ${canceled.error.message}`)
    }
  }
  await db.execute(
    `INSERT INTO subscription_trials(
      user_id, stripe_subscription_id, stripe_customer_id, card_fingerprint, pass_type, status, trial_start, trial_end, ended_at, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (stripe_subscription_id) DO NOTHING`,
    [
      String(userId),
      stripeSubscriptionId,
      getString(stripeSubscription, "customer"),
      fingerprint,
      props.passType ?? TRIAL_PASS_TYPE,
      status,
      trialStart,
      trialEnd,
      status === "trialing" ? null : now,
      now
    ]
  )
  console.log(JSON.stringify({ event: "trial.start", userId: String(userId), stripeSubscriptionId, status, hasFingerprint: fingerprint !== null }))
  return { rejected: status !== "trialing", status, trialStart, trialEnd }
}

/**
 * お試しのあとの最初の支払い（¥1 以上）で、有料に移行したと記録する。
 * 記録したら true（この請求は「はじめての支払い」なので、呼び出し元は継続ボーナスを付けない）
 */
export var markTrialConverted = async (db, stripeSubscriptionId) => {
  if (!stripeSubscriptionId) return false
  const result = await db.executeResult(
    `UPDATE subscription_trials SET status = 'converted', converted_at = $2
      WHERE stripe_subscription_id = $1 AND status = 'trialing'`,
    [stripeSubscriptionId, getNow()]
  )
  return result.rowCount > 0
}

/** 契約が終わったとき（解約・支払い方法なし）。有料になる前なら canceled にする */
export var markTrialEnded = async (db, stripeSubscriptionId) => {
  if (!stripeSubscriptionId) return
  await db.execute(
    `UPDATE subscription_trials SET status = 'canceled', ended_at = $2
      WHERE stripe_subscription_id = $1 AND status = 'trialing'`,
    [stripeSubscriptionId, getNow()]
  )
}

/**
 * お試しの終了 3 日前のお知らせ（Stripe の customer.subscription.trial_will_end）
 * 終了日・その後の料金・解約の方法を知らせる。解約を予約済みの人には送らない（請求が発生しないため）
 */
export var sendTrialWillEndEmail = async (env, db, stripeSubscription) => {
  const stripeSubscriptionId = getString(stripeSubscription, "id")
  const trial = await getTrialByStripeSubscriptionId(db, stripeSubscriptionId)
  if (!trial || getString(trial, "status") !== "trialing") return { sent: false, skipped: "not trialing" }
  if (getNumber(trial, "reminder_sent_at")) return { sent: false, skipped: "already sent" }
  if (stripeSubscription.cancel_at_period_end === true || getString(stripeSubscription, "status") !== "trialing") {
    return { sent: false, skipped: "cancellation scheduled" }
  }
  if (!env.RESEND_API_KEY) return { sent: false, skipped: "RESEND_API_KEY is not configured" }
  const toEmail = await getStripeCustomerEmail(env.STRIPE_SECRET_KEY, getString(stripeSubscription, "customer"), stripeSubscriptionId)
  if (!toEmail) return { sent: false, skipped: "no recipient email" }
  const trialEnd = getNumber(stripeSubscription, "trial_end") ?? getNumber(trial, "trial_end")
  const pricing = await getPricingSettings(db)
  const amount = getPlanAmount(pricing, getString(trial, "pass_type") ?? TRIAL_PASS_TYPE, "month")
  const message = buildTrialWillEndEmail({ trialEnd, amount })
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `Aipictors <${env.RESEND_FROM_EMAIL ?? "noreply@info.aipictors.com"}>`,
      to: [toEmail],
      subject: message.subject,
      html: message.html
    })
  })
  if (!response.ok) {
    throw new Error(`Failed to send trial reminder email: ${response.status} ${await response.text()}`)
  }
  await db.execute("UPDATE subscription_trials SET reminder_sent_at = $2 WHERE stripe_subscription_id = $1", [stripeSubscriptionId, getNow()])
  return { sent: true }
}

export var buildTrialWillEndEmail = (props) => {
  const endText = formatJstDate(props.trialEnd) ?? ""
  const endTextEn = props.trialEnd
    ? new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric", month: "short", day: "numeric" }).format(new Date(props.trialEnd * 1e3))
    : ""
  const yen = Number(props.amount).toLocaleString("en-US")
  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;line-height:1.8;color:#111827">',
    "<p>Aipictors をご利用いただきありがとうございます。</p>",
    `<p>Aipictors+ ライトプランの無料お試しは <b>${escapeHtml(endText)}</b> に終了します。</p>`,
    `<p>終了後は、ご登録のカードに <b>月額 ¥${yen}（税込）</b> が自動で請求され、以後は毎月自動で更新されます。続ける場合は、何もしなくて大丈夫です。</p>`,
    `<p>続けない場合は、${escapeHtml(endText)} より前に、プランのページの「解約する」から手続きをしてください。無料期間中に解約すれば請求はありません（無料期間の終わりまではそのまま使えます）。</p>`,
    '<p><a href="https://www.aipictors.com/plus" style="display:inline-block;background:#0ea5e9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">プランのページを開く</a></p>',
    '<p>困っていることがあれば、<a href="https://www.aipictors.com/support/chat">お問い合わせ</a>からお気軽にどうぞ。</p>',
    '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">',
    `<p style="color:#4b5563">Your free trial of the Aipictors+ Lite plan ends on <b>${escapeHtml(endTextEn)}</b> (JST). After that, your card will be charged <b>¥${yen}/month</b> automatically and the plan renews monthly. To avoid being charged, cancel from the <a href="https://www.aipictors.com/en/plus">plan page</a> before the trial ends — you can keep using the plan until then.</p>`,
    "</div>"
  ].join("")
  return {
    subject: `【Aipictors】無料お試しは ${endText} に終了します（以後 月額¥${yen}）`,
    html
  }
}
