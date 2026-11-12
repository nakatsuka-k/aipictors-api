// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { getNow } from "./db"
import { getNumber, getString } from "./record-fields"
import { getStripe, getSubscriptionInterval, postStripeForm2 } from "./subscription-stripe"

/**
 * プランの 1 か月休止
 * 解約の理由で「あまり使わなかった」「1か月だけ使うつもりだった」が多く、やめる代わりに次の 1 か月だけ止められるようにする。
 *
 * 仕組み: Stripe の pause_collection（behavior=void）で、今の期間の終わりに作られる請求を取り消す。
 * プランの期間（subscriptions.current_period_end）は請求が支払われたとき（invoice.payment_succeeded）にしか延びないので、
 * 休止中は自然に無料と同じ扱いになり、resumes_at の後の更新日に請求が支払われるとプランが戻る。
 * resumes_at は「期間の終わりの請求の後・その次の請求の前」になるよう、期間の終わりの 14 日後にする。
 */
export var PAUSE_RESUME_OFFSET_SECONDS = 14 * 24 * 60 * 60

export var getActivePause = async (db, userId, now = getNow()) =>
  db.queryOne(
    `SELECT * FROM subscription_pauses
      WHERE user_id = $1 AND canceled_at IS NULL AND resumes_at > $2
      ORDER BY created_at DESC LIMIT 1`,
    [String(userId), now]
  )

/** Stripe の契約の今の期間の終わり（新しい API では items 側にある） */
var getStripePeriodEnd = (stripeSubscription) => {
  const [firstItem] = stripeSubscription?.items?.data ?? []
  return getNumber(stripeSubscription ?? {}, "current_period_end") ?? getNumber(firstItem ?? {}, "current_period_end")
}

export var pauseSubscription = async (secretKey, db, props) => {
  const stripeSubscriptionId = getString(props.current, "stripe_subscription_id")
  if (!stripeSubscriptionId || !stripeSubscriptionId.startsWith("sub_")) {
    return { error: "自動更新の契約ではないため休止できません", status: 409 }
  }
  if (getString(props.current, "status") === "cancellation_requested") {
    return { error: "解約予約中は休止できません。先に解約を取り消してください", status: 409 }
  }
  const existing = await getActivePause(db, props.userId)
  if (existing) {
    return { error: null, data: existing }
  }
  const stripeSubscription = await getStripe(secretKey, `/subscriptions/${stripeSubscriptionId}`)
  if (stripeSubscription?.error?.message) {
    return { error: stripeSubscription.error.message, status: 502 }
  }
  if (getString(stripeSubscription, "status") === "trialing") {
    return { error: "無料お試し中は休止できません", status: 409 }
  }
  if (getSubscriptionInterval(stripeSubscription) === "year") {
    return { error: "年払いのプランは休止できません", status: 409 }
  }
  const periodEnd = getStripePeriodEnd(stripeSubscription) ?? getNumber(props.current, "current_period_end")
  if (!periodEnd) {
    return { error: "契約の期間が分かりませんでした", status: 502 }
  }
  const resumesAt = periodEnd + PAUSE_RESUME_OFFSET_SECONDS
  const form = new URLSearchParams()
  form.set("pause_collection[behavior]", "void")
  form.set("pause_collection[resumes_at]", String(resumesAt))
  const response = await postStripeForm2(secretKey, `/subscriptions/${stripeSubscriptionId}`, form)
  if (response?.error?.message) {
    return { error: response.error.message, status: 502 }
  }
  const now = getNow()
  await db.execute(
    `INSERT INTO subscription_pauses(user_id, stripe_subscription_id, pass_type, paused_from, resumes_at, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [String(props.userId), stripeSubscriptionId, getString(props.current, "type"), periodEnd, resumesAt, props.reason ?? null, now]
  )
  return { error: null, data: await getActivePause(db, props.userId) }
}

export var unpauseSubscription = async (secretKey, db, userId) => {
  const pause = await getActivePause(db, userId)
  if (!pause) {
    return { error: null, data: null }
  }
  const form = new URLSearchParams()
  // 空文字で pause_collection を外す
  form.set("pause_collection", "")
  const response = await postStripeForm2(secretKey, `/subscriptions/${pause.stripe_subscription_id}`, form)
  const message = response?.error?.message ?? ""
  if (message && !message.includes("No such subscription") && !message.includes("canceled")) {
    return { error: message, status: 502 }
  }
  await db.execute("UPDATE subscription_pauses SET canceled_at = $1 WHERE id = $2", [getNow(), pause.id])
  return { error: null, data: null }
}

/**
 * 休止中の人が新しくプランに入ったら、休止中の古い契約はすぐ解約する（再開後に二重に請求されないように）
 * 失敗しても新しい加入の処理は止めない
 */
export var cancelPausedSubscriptionsOnNewSubscription = async (secretKey, db, userId, newStripeSubscriptionId) => {
  if (!secretKey || !userId) return
  const rows = await db.query(
    `SELECT id, stripe_subscription_id FROM subscription_pauses
      WHERE user_id = $1 AND canceled_at IS NULL AND resumes_at > $2 AND stripe_subscription_id <> $3`,
    [String(userId), getNow(), newStripeSubscriptionId ?? ""]
  )
  for (const row of rows ?? []) {
    try {
      const response = await fetch(`https://api.stripe.com/v1/subscriptions/${row.stripe_subscription_id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${secretKey}` }
      })
      const body = await response.json()
      const message = body?.error?.message ?? ""
      if (message && !message.includes("No such subscription") && !message.includes("canceled")) {
        console.error("[subscription-pause] failed to cancel paused subscription", { userId, id: row.stripe_subscription_id, message })
        continue
      }
      await db.execute("UPDATE subscription_pauses SET canceled_at = $1 WHERE id = $2", [getNow(), row.id])
      await db.execute(
        `UPDATE subscriptions SET status = 'canceled', is_disabled = TRUE WHERE stripe_subscription_id = $1`,
        [row.stripe_subscription_id]
      )
    } catch (error) {
      console.error("[subscription-pause] cancel paused subscription threw", error)
    }
  }
}

var addOneMonth = (seconds) => {
  const date = new Date(seconds * 1000)
  date.setUTCMonth(date.getUTCMonth() + 1)
  return Math.floor(date.getTime() / 1000)
}

/** 応答の形（画面で使う分だけ） */
export var toPauseResponse = (pause) =>
  pause
    ? {
        passType: pause.pass_type ?? null,
        pausedFrom: Number(pause.paused_from),
        resumesAt: Number(pause.resumes_at),
        // 次に請求してプランが戻る日（休止した期間の終わりの 1 か月後）
        nextBillingAt: addOneMonth(Number(pause.paused_from))
      }
    : null
