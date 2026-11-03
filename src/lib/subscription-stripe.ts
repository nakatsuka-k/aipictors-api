// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
// サブスクの Stripe API 呼び出しと応答の読み取り
import { getArray, getNumber, getRecord, getString } from "./record-fields"
export var stripeProductIdByPassType = {
  PREMIUM: "prod_OneEB60sXmxvu1",
  LITE: "prod_One9y8yOCumS2G",
  STANDARD: "prod_OaCLGmzAoDVJjY"
};





export var getSubscriptionItemId = (stripeSubscription) => {
  const items = stripeSubscription.items;
  const [firstItem] = items?.data ?? [];
  return firstItem ? getString(firstItem, "id") : null;
};

export var getPreviewProrationAmount = (invoice) => {
  const linesObject = getRecord(invoice, "lines");
  const lines = getArray(linesObject ?? {}, "data");
  let total = 0;
  let hasProrationLine = false;
  for (const line of lines) {
    if (typeof line !== "object" || line === null) {
      continue;
    }
    const lineRecord = line;
    const lineParent = getRecord(lineRecord, "parent");
    const subscriptionItemDetails = getRecord(lineParent ?? {}, "subscription_item_details");
    const isProration = subscriptionItemDetails?.proration === true || lineRecord.proration === true;
    if (!isProration) {
      continue;
    }
    total += getNumber(lineRecord, "amount") ?? 0;
    hasProrationLine = true;
  }
  if (hasProrationLine) {
    return total;
  }
  return getNumber(invoice, "amount_due") ?? getNumber(invoice, "total") ?? 0;
};

export var isInvoicePaid = (invoice) => {
  if (!invoice) {
    return false;
  }
  const status = getString(invoice, "status");
  if (status === "paid") {
    return true;
  }
  const amountDue = getNumber(invoice, "amount_due");
  const amountRemaining = getNumber(invoice, "amount_remaining");
  return amountDue === 0 || amountRemaining === 0;
};

export var setPlanPriceData = (form, passType, amountJpy) => {
  form.set("items[0][price_data][currency]", "jpy");
  form.set("items[0][price_data][unit_amount]", String(amountJpy));
  form.set("items[0][price_data][recurring][interval]", "month");
  form.set("items[0][price_data][product]", stripeProductIdByPassType[passType]);
};

export var setPreviewPlanPriceData = (form, passType, amountJpy) => {
  form.set("subscription_details[items][0][price_data][currency]", "jpy");
  form.set("subscription_details[items][0][price_data][unit_amount]", String(amountJpy));
  form.set("subscription_details[items][0][price_data][recurring][interval]", "month");
  form.set(
    "subscription_details[items][0][price_data][product]",
    stripeProductIdByPassType[passType]
  );
};

export var toDeliverableEmail = (value) => {
  const email = typeof value === "string" ? value.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }
  // X ログインのユーザに振られるダミーアドレス (aipictors-system create-user-info)
  if (email.toLowerCase().endsWith("@pseudo.twitter.com")) {
    return null;
  }
  return email;
};

export var getStripeCustomerEmail = async (secretKey, customerId, stripeSubscriptionId) => {
  if (!secretKey) {
    return null;
  }
  let resolvedCustomerId = customerId;
  if (!resolvedCustomerId && stripeSubscriptionId) {
    const subscription = await getStripe(secretKey, `/subscriptions/${stripeSubscriptionId}`);
    resolvedCustomerId = typeof subscription?.customer === "string" ? subscription.customer : null;
  }
  if (!resolvedCustomerId) {
    return null;
  }
  const customer = await getStripe(secretKey, `/customers/${resolvedCustomerId}`);
  return toDeliverableEmail(customer?.email);
};

export var postStripeForm2 = async (secretKey, path, params) => {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });
  return response.json();
};

export var getStripe = async (secretKey, path) => {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${secretKey}`
    }
  });
  return response.json();
};

// customer.subscription.updated は受けていないので、カスタマーポータルでの解約予約と取り消しは
// Stripe に聞かないと分からない。ただし取得のたびには聞かない（/current は契約者の取得のたびに呼ばれる）。
const CANCELLATION_REQUESTED_CHECK_INTERVAL_MS = 60 * 1000;
const CURRENT_SUBSCRIPTION_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const MAX_TRACKED_CHECKS = 10000;
// isolate ごとの記録なので、実際の間隔はこれより短くなることがある
const lastCheckedAtBySubscriptionId = new Map();

/** この契約を今 Stripe に確かめてよいなら記録して true を返す */
export var claimCurrentSubscriptionCheck = (current, now = Date.now()) => {
  const id = getString(current, "stripe_subscription_id");
  const interval = getString(current, "status") === "cancellation_requested"
    ? CANCELLATION_REQUESTED_CHECK_INTERVAL_MS
    : CURRENT_SUBSCRIPTION_CHECK_INTERVAL_MS;
  const lastCheckedAt = lastCheckedAtBySubscriptionId.get(id);
  if (lastCheckedAt !== undefined && now - lastCheckedAt < interval) {
    return false;
  }
  if (lastCheckedAtBySubscriptionId.size >= MAX_TRACKED_CHECKS) {
    lastCheckedAtBySubscriptionId.clear();
  }
  lastCheckedAtBySubscriptionId.set(id, now);
  return true;
};

export var resetCurrentSubscriptionChecks = () => lastCheckedAtBySubscriptionId.clear();

/**
 * Stripe の cancel_at_period_end と status を DB に反映し、応答に使う契約を返す。
 * Stripe のエラー応答（status がない）や通信の失敗では何も変えない。
 */
export var syncCurrentSubscriptionFromStripe = async (secretKey, db, current) => {
  const stripeSubscriptionId = getString(current, "stripe_subscription_id");
  try {
    const stripeSubscription = await getStripe(secretKey, `/subscriptions/${stripeSubscriptionId}`);
    const stripeStatus = getString(stripeSubscription, "status");
    if (stripeSubscription.cancel_at_period_end === true) {
      if (getString(current, "status") === "cancellation_requested") {
        return current;
      }
      await db.execute(
        `UPDATE subscriptions SET status = 'cancellation_requested' WHERE stripe_subscription_id = $1`,
        [stripeSubscriptionId]
      );
      return { ...current, status: "cancellation_requested" };
    }
    if (stripeStatus === "canceled") {
      await db.execute(
        `UPDATE subscriptions SET status = 'canceled', is_disabled = TRUE WHERE stripe_subscription_id = $1`,
        [stripeSubscriptionId]
      );
      return { ...current, status: "canceled", is_disabled: 1 };
    }
    // ポータルで解約を取り消した場合。/resume-current と同じ値にする。
    // 残すと継続の猶予（daily-coins）から外れ、解約のリマインドも届いてしまう
    if (
      getString(current, "status") === "cancellation_requested" &&
      stripeSubscription.cancel_at_period_end === false &&
      !stripeSubscription.cancel_at &&
      (stripeStatus === "active" || stripeStatus === "trialing")
    ) {
      await db.execute(
        `UPDATE subscriptions SET status = 'paid' WHERE stripe_subscription_id = $1 AND status = 'cancellation_requested'`,
        [stripeSubscriptionId]
      );
      return { ...current, status: "paid" };
    }
  } catch (error) {
    console.warn("[subscriptions.current] failed to check Stripe", {
      stripeSubscriptionId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
  return current;
};

/**
 * 同じユーザーの「解約対象以外」の契約も期間終了時に解約する。
 * 別の決済（別の Stripe 顧客）で二重に申し込んでいると、画面から解約しても 1 件しか止まらず
 * 残りの契約で翌月も引き落とされていたため。失敗しても解約の本体は成功として返す（ログに残す）。
 */
export var cancelOtherActiveSubscriptions = async (secretKey, db, userId, exceptStripeSubscriptionId) => {
  try {
    const rows = await db.query(
      `SELECT stripe_subscription_id FROM subscriptions
        WHERE user_id = $1 AND is_disabled = FALSE
          AND status NOT IN ('canceled', 'cancellation_requested')
          AND stripe_subscription_id IS NOT NULL AND stripe_subscription_id <> $2`,
      [userId, exceptStripeSubscriptionId]
    );
    for (const row of rows ?? []) {
      const id = row.stripe_subscription_id;
      const form = new URLSearchParams();
      form.set("cancel_at_period_end", "true");
      const response = await postStripeForm2(secretKey, `/subscriptions/${id}`, form);
      const message = response?.error?.message ?? "";
      if (message) {
        const isGone = response.error.code === "resource_missing" || message.includes("No such subscription") || message.includes("already been canceled") || message.includes("Updates to a canceled");
        if (isGone) {
          await db.execute(`UPDATE subscriptions SET status = 'canceled', is_disabled = TRUE WHERE stripe_subscription_id = $1`, [id]);
        } else {
          console.error("[subscriptions.cancel-current] failed to cancel another subscription", { userId, id, message });
        }
        continue;
      }
      const status = response?.status === "canceled" ? "canceled" : "cancellation_requested";
      await db.execute(
        `UPDATE subscriptions SET status = $2${status === "canceled" ? ", is_disabled = TRUE" : ""} WHERE stripe_subscription_id = $1`,
        [id, status]
      );
      console.log("[subscriptions.cancel-current] also scheduled cancellation of another subscription", { userId, id, status });
    }
  } catch (error) {
    console.error("[subscriptions.cancel-current] cancelOtherActiveSubscriptions failed", error);
  }
};
