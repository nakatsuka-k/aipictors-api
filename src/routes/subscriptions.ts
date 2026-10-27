// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { Hono as Hono2 } from "hono"
import { boolean, literal, nullable, number, object, optional, safeParse, string, union } from "valibot"
import { requireInternalAuth } from "../lib/auth"
import { getDb } from "../lib/db"
import { json } from "../lib/json"
import { getPricingSettings } from "../lib/pricing"
import { sendSubscriptionCancellationEmail } from "../lib/subscription-cancellation-email"
import { disableSubscriptionByStripeId, getActiveOrRecentSubscription, getCurrentSubscription, getSubscriptionByNanoid, hasPreviousSubscription, upsertSubscription } from "../lib/subscriptions"
export var upsertSchema = object({
  nanoid: string(),
  userId: string(),
  type: string(),
  status: string(),
  isDisabled: boolean(),
  createdAt: number(),
  currentPeriodStart: number(),
  currentPeriodEnd: number(),
  trialStart: nullable(number()),
  trialEnd: nullable(number()),
  stripeSubscriptionId: string(),
  stripeLatestInvoiceId: nullable(string()),
  stripePaymentIntentId: nullable(string()),
  stripeSubscriptionItemId: nullable(string()),
  stripePriceId: nullable(string()),
  stripeProductId: nullable(string())
});
export var disableSchema = object({
  stripeSubscriptionId: string()
});
export var cancelCurrentSchema = object({
  userId: string(),
  userEmail: optional(nullable(string()))
});
export var changePlanSchema = object({
  userId: string(),
  passType: union([literal("LITE"), literal("STANDARD"), literal("PREMIUM")]),
  prorationDate: optional(number())
});
export var stripeProductIdByPassType = {
  PREMIUM: "prod_OneEB60sXmxvu1",
  LITE: "prod_One9y8yOCumS2G",
  STANDARD: "prod_OaCLGmzAoDVJjY"
};
export var getString2 = (record, key) => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};
export var getNumber = (record, key) => {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
export var getRecord = (record, key) => {
  const value = record[key];
  return typeof value === "object" && value !== null ? value : null;
};
export var getArray = (record, key) => {
  const value = record[key];
  return Array.isArray(value) ? value : [];
};
export var getSubscriptionItemId = (stripeSubscription) => {
  const items = stripeSubscription.items;
  const [firstItem] = items?.data ?? [];
  return firstItem ? getString2(firstItem, "id") : null;
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
  const status = getString2(invoice, "status");
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
export var subscriptionRoutes = new Hono2();
subscriptionRoutes.use("*", requireInternalAuth);
subscriptionRoutes.get("/current/:userId", async (c) => {
  const db = await getDb(c.env);
  const current = await getCurrentSubscription(db, c.req.param("userId"));
  if (!current) {
    return json({ error: null, data: null });
  }
  const stripeSubscriptionId = getString2(current, "stripe_subscription_id");
  if (!stripeSubscriptionId || !c.env.STRIPE_SECRET_KEY) {
    return json({ error: null, data: current });
  }
  try {
    const stripeSubscription = await getStripe(
      c.env.STRIPE_SECRET_KEY,
      `/subscriptions/${stripeSubscriptionId}`
    );
    const cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end === true;
    const stripeStatus = getString2(stripeSubscription, "status");
    if (cancelAtPeriodEnd) {
      await db.execute(
        `UPDATE subscriptions SET status = 'cancellation_requested' WHERE stripe_subscription_id = $1`,
        [stripeSubscriptionId]
      );
      return json({
        error: null,
        data: {
          ...current,
          status: "cancellation_requested"
        }
      });
    }
    if (stripeStatus === "canceled") {
      await db.execute(
        `UPDATE subscriptions SET status = 'canceled', is_disabled = TRUE WHERE stripe_subscription_id = $1`,
        [stripeSubscriptionId]
      );
      return json({
        error: null,
        data: {
          ...current,
          status: "canceled",
          is_disabled: 1
        }
      });
    }
  } catch {
  }
  return json({ error: null, data: current });
});
// 更新の支払いに失敗して未払いのままになっている契約（Stripe 上で past_due / unpaid / incomplete）の請求書を返す。
// プリペイドカードの残高不足などで更新できなかったユーザが、別のカードで支払い直せるようにする
// （新しく申し込み直すと、古い契約の自動再試行が後で成功して二重請求になるおそれがある）。
subscriptionRoutes.get("/unpaid/:userId", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: null, data: null });
  }
  const db = await getDb(c.env);
  const rows = await db.query(
    `SELECT type, stripe_subscription_id FROM subscriptions
      WHERE user_id = $1 AND is_disabled = FALSE AND stripe_subscription_id <> ''
        AND current_period_end > EXTRACT(EPOCH FROM NOW())::bigint - 60 * 86400
      ORDER BY current_period_end DESC LIMIT 3`,
    [c.req.param("userId")]
  );
  for (const row of rows) {
    try {
      const sub = await getStripe(
        c.env.STRIPE_SECRET_KEY,
        `/subscriptions/${row.stripe_subscription_id}?expand[]=latest_invoice`
      );
      const status = getString2(sub, "status");
      if (!["past_due", "unpaid", "incomplete"].includes(status ?? "")) {
        continue;
      }
      const invoice = getRecord(sub, "latest_invoice");
      if (!invoice || getString2(invoice, "status") !== "open") {
        continue;
      }
      const url = getString2(invoice, "hosted_invoice_url");
      if (!url) {
        continue;
      }
      return json({
        error: null,
        data: {
          passType: row.type,
          amount: getNumber(invoice, "amount_due") ?? 0,
          hostedInvoiceUrl: url,
          subscriptionStatus: status
        }
      });
    } catch (error) {
      console.warn("[subscriptions.unpaid] failed to fetch stripe subscription", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return json({ error: null, data: null });
});
subscriptionRoutes.get("/by-nanoid/:nanoid", async (c) => {
  const db = await getDb(c.env);
  const nanoid = c.req.param("nanoid");
  const data = await getSubscriptionByNanoid(db, nanoid);
  return json({ error: null, data });
});
subscriptionRoutes.get("/has-previous/:userId", async (c) => {
  const db = await getDb(c.env);
  const exists = await hasPreviousSubscription(db, c.req.param("userId"));
  return json({ error: null, data: { exists } });
});
subscriptionRoutes.post("/upsert", async (c) => {
  const parsed = safeParse(upsertSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  await upsertSubscription(db, parsed.output);
  return json({ error: null, data: true });
});
subscriptionRoutes.post("/disable", async (c) => {
  const parsed = safeParse(disableSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  await disableSubscriptionByStripeId(db, parsed.output.stripeSubscriptionId);
  return json({ error: null, data: true });
});
/**
 * 同じユーザーの「解約対象以外」の契約も期間終了時に解約する。
 * 別の決済（別の Stripe 顧客）で二重に申し込んでいると、画面から解約しても 1 件しか止まらず
 * 残りの契約で翌月も引き落とされていたため。失敗しても解約の本体は成功として返す（ログに残す）。
 */
var cancelOtherActiveSubscriptions = async (secretKey, db, userId, exceptStripeSubscriptionId) => {
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
subscriptionRoutes.post("/cancel-current", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: "STRIPE_SECRET_KEY is not configured" }, 500);
  }
  const parsed = safeParse(cancelCurrentSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  const current = await getCurrentSubscription(db, parsed.output.userId) ?? await getActiveOrRecentSubscription(db, parsed.output.userId);
  const sendCancellationEmail = (status, stripeCustomerId = null) => {
    c.executionCtx.waitUntil(
      (async () => {
        if (!c.env.RESEND_API_KEY) {
          console.error("[subscriptions.cancel-current] RESEND_API_KEY is not configured; cancellation email skipped");
          return;
        }
        // プロフィールのメール (user_profiles.mail) は Google / X ログインのユーザでは空のことが多いので、
        // 無い場合は Stripe の顧客メール (決済時に入力したもの) に送る
        const toEmail = toDeliverableEmail(parsed.output.userEmail) ?? await getStripeCustomerEmail(
          c.env.STRIPE_SECRET_KEY,
          stripeCustomerId,
          getString2(current ?? {}, "stripe_subscription_id")
        );
        if (!toEmail) {
          console.warn("[subscriptions.cancel-current] no recipient email; cancellation email skipped", { userId: parsed.output.userId });
          return;
        }
        await sendSubscriptionCancellationEmail({
          apiKey: c.env.RESEND_API_KEY,
          fromEmail: c.env.RESEND_FROM_EMAIL,
          toEmail,
          status,
          currentPeriodEnd: getNumber(current ?? {}, "current_period_end")
        });
      })().catch((error) => {
        console.error("[subscriptions.cancel-current] failed to send cancellation email", error);
      })
    );
  };
  if (!current) {
    return json({ error: "No active subscription found" }, 404);
  }
  const stripeSubscriptionId = getString2(current, "stripe_subscription_id");
  if (!stripeSubscriptionId) {
    return json({ error: "Stripe subscription id is missing" }, 409);
  }
  const form = new URLSearchParams();
  form.set("cancel_at_period_end", "true");
  const stripeResponse = await postStripeForm2(
    c.env.STRIPE_SECRET_KEY,
    `/subscriptions/${stripeSubscriptionId}`,
    form
  );
  const stripeError = stripeResponse.error;
  if (stripeError?.message) {
    const isAlreadyGone = stripeError.code === "resource_missing" || stripeError.code === "subscription_update_forbidden" || stripeError.message.includes("No such subscription") || stripeError.message.includes("already been canceled") || stripeError.message.includes("Updates to a canceled");
    if (isAlreadyGone) {
      await db.execute(
        `UPDATE subscriptions SET status = 'canceled', is_disabled = TRUE WHERE stripe_subscription_id = $1`,
        [stripeSubscriptionId]
      );
      await cancelOtherActiveSubscriptions(c.env.STRIPE_SECRET_KEY, db, parsed.output.userId, stripeSubscriptionId);
      sendCancellationEmail("canceled");
      return json({
        error: null,
        data: {
          status: "canceled",
          stripeStatus: null,
          cancelAtPeriodEnd: false
        }
      });
    }
    return json({ error: stripeError.message }, 502);
  }
  const stripeStatus = typeof stripeResponse.status === "string" ? stripeResponse.status : null;
  if (stripeStatus === "canceled") {
    await db.execute(
      `UPDATE subscriptions SET status = 'canceled', is_disabled = TRUE WHERE stripe_subscription_id = $1`,
      [stripeSubscriptionId]
    );
    await cancelOtherActiveSubscriptions(c.env.STRIPE_SECRET_KEY, db, parsed.output.userId, stripeSubscriptionId);
    sendCancellationEmail("canceled", getString2(stripeResponse, "customer"));
    return json({
      error: null,
      data: {
        status: "canceled",
        stripeStatus: "canceled",
        cancelAtPeriodEnd: false
      }
    });
  }
  const isCancelAtPeriodEnd = stripeResponse.cancel_at_period_end === true;
  if (!isCancelAtPeriodEnd) {
    return json({ error: "Failed to schedule cancellation at period end" }, 502);
  }
  await db.execute(
    `UPDATE subscriptions SET status = 'cancellation_requested' WHERE stripe_subscription_id = $1`,
    [stripeSubscriptionId]
  );
  await cancelOtherActiveSubscriptions(c.env.STRIPE_SECRET_KEY, db, parsed.output.userId, stripeSubscriptionId);
  sendCancellationEmail("cancellation_requested", getString2(stripeResponse, "customer"));
  return json({
    error: null,
    data: {
      status: "cancellation_requested",
      stripeStatus: typeof stripeResponse.status === "string" ? stripeResponse.status : null,
      cancelAtPeriodEnd: true
    }
  });
});
subscriptionRoutes.post("/resume-current", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: "STRIPE_SECRET_KEY is not configured" }, 500);
  }
  const parsed = safeParse(cancelCurrentSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  const current = await getCurrentSubscription(db, parsed.output.userId) ?? await getActiveOrRecentSubscription(db, parsed.output.userId);
  if (!current) {
    return json({ error: "No active subscription found" }, 404);
  }
  const stripeSubscriptionId = getString2(current, "stripe_subscription_id");
  if (!stripeSubscriptionId) {
    return json({ error: "Stripe subscription id is missing" }, 409);
  }
  const form = new URLSearchParams();
  form.set("cancel_at_period_end", "false");
  const stripeResponse = await postStripeForm2(
    c.env.STRIPE_SECRET_KEY,
    `/subscriptions/${stripeSubscriptionId}`,
    form
  );
  const stripeError = stripeResponse.error;
  if (stripeError?.message) {
    return json({ error: stripeError.message }, 502);
  }
  await db.execute(`UPDATE subscriptions SET status = 'paid' WHERE stripe_subscription_id = $1`, [
    stripeSubscriptionId
  ]);
  return json({
    error: null,
    data: {
      status: "paid",
      stripeStatus: typeof stripeResponse.status === "string" ? stripeResponse.status : null,
      cancelAtPeriodEnd: false
    }
  });
});
subscriptionRoutes.post("/change-plan", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: "STRIPE_SECRET_KEY is not configured" }, 500);
  }
  const parsed = safeParse(changePlanSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  const current = await getCurrentSubscription(db, parsed.output.userId);
  if (!current) {
    return json({ error: "No active subscription found" }, 404);
  }
  const stripeSubscriptionId = getString2(current, "stripe_subscription_id");
  if (!stripeSubscriptionId) {
    return json({ error: "Stripe subscription id is missing" }, 409);
  }
  const pricing = await getPricingSettings(db);
  const nextAmount = pricing.subscriptionPlans[parsed.output.passType];
  const currentType = getString2(current, "type");
  if (currentType === parsed.output.passType) {
    return json({
      error: null,
      data: {
        passType: parsed.output.passType,
        renewalAmountJpy: nextAmount,
        chargedNowAmountJpy: 0,
        status: getString2(current, "status") ?? "active"
      }
    });
  }
  const stripeSubscription = await getStripe(
    c.env.STRIPE_SECRET_KEY,
    `/subscriptions/${stripeSubscriptionId}`
  );
  const stripeFetchError = stripeSubscription.error;
  if (stripeFetchError?.message) {
    return json({ error: stripeFetchError.message }, 502);
  }
  const stripeSubscriptionItemId = getSubscriptionItemId(stripeSubscription);
  if (!stripeSubscriptionItemId) {
    return json({ error: "Stripe subscription item is missing" }, 409);
  }
  const subscriptionNanoid = getString2(current, "nanoid");
  const prorationDate = typeof parsed.output.prorationDate === "number" && Number.isFinite(parsed.output.prorationDate) ? parsed.output.prorationDate : void 0;
  const form = new URLSearchParams();
  form.set("proration_behavior", "always_invoice");
  form.set("payment_behavior", "default_incomplete");
  form.set("cancel_at_period_end", "false");
  form.set("expand[]", "latest_invoice");
  form.set("expand[]", "latest_invoice.payment_intent");
  form.set("items[0][id]", stripeSubscriptionItemId);
  setPlanPriceData(form, parsed.output.passType, nextAmount);
  form.set("metadata[pass_type]", parsed.output.passType);
  form.set("metadata[user_id]", parsed.output.userId);
  if (subscriptionNanoid) {
    form.set("metadata[subscription_nanoid]", subscriptionNanoid);
  }
  if (prorationDate !== void 0) {
    form.set("proration_date", String(prorationDate));
  }
  const stripeUpdate = await postStripeForm2(
    c.env.STRIPE_SECRET_KEY,
    `/subscriptions/${stripeSubscriptionId}`,
    form
  );
  const stripeUpdateError = stripeUpdate.error;
  if (stripeUpdateError?.message) {
    return json({ error: stripeUpdateError.message }, 502);
  }
  const updatedItems = stripeUpdate.items;
  const [updatedFirstItem] = updatedItems?.data ?? [];
  const updatedPrice = updatedFirstItem?.price ?? null;
  const latestInvoice = getRecord(stripeUpdate, "latest_invoice");
  const paymentIntent = getRecord(latestInvoice ?? {}, "payment_intent");
  const chargedNowAmountJpy = getNumber(latestInvoice ?? {}, "amount_paid") ?? getNumber(latestInvoice ?? {}, "amount_due") ?? 0;
  const hostedInvoiceUrl = getString2(latestInvoice ?? {}, "hosted_invoice_url");
  const paymentIntentStatus = getString2(paymentIntent ?? {}, "status");
  const updatedStatus = typeof stripeUpdate.status === "string" ? stripeUpdate.status : "active";
  const updatedPeriodStart = getNumber(stripeUpdate, "current_period_start") ?? getNumber(current, "current_period_start") ?? Math.floor(Date.now() / 1e3);
  const updatedPeriodEnd = getNumber(stripeUpdate, "current_period_end") ?? getNumber(current, "current_period_end") ?? Math.floor(Date.now() / 1e3);
  const paymentPending = !isInvoicePaid(latestInvoice);
  if (paymentPending) {
    return json({
      error: null,
      data: {
        passType: parsed.output.passType,
        renewalAmountJpy: nextAmount,
        chargedNowAmountJpy,
        status: updatedStatus,
        requiresAction: true,
        paymentPageUrl: hostedInvoiceUrl,
        paymentIntentStatus
      }
    });
  }
  await db.execute(
    `UPDATE subscriptions
      SET type = $1,
          status = $2,
          is_disabled = FALSE,
          current_period_start = $3,
          current_period_end = $4,
          stripe_subscription_item_id = $5,
          stripe_price_id = $6,
          stripe_product_id = $7
      WHERE stripe_subscription_id = $8`,
    [
      parsed.output.passType,
      updatedStatus,
      updatedPeriodStart,
      updatedPeriodEnd,
      getString2(updatedFirstItem ?? {}, "id") ?? stripeSubscriptionItemId,
      getString2(updatedPrice ?? {}, "id"),
      getString2(updatedPrice ?? {}, "product"),
      stripeSubscriptionId
    ]
  );
  return json({
    error: null,
    data: {
      passType: parsed.output.passType,
      renewalAmountJpy: nextAmount,
      chargedNowAmountJpy,
      status: updatedStatus,
      requiresAction: false,
      paymentPageUrl: null,
      paymentIntentStatus
    }
  });
});
subscriptionRoutes.post("/change-plan-preview", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: "STRIPE_SECRET_KEY is not configured" }, 500);
  }
  const parsed = safeParse(changePlanSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  const current = await getCurrentSubscription(db, parsed.output.userId);
  if (!current) {
    return json({ error: "No active subscription found" }, 404);
  }
  const stripeSubscriptionId = getString2(current, "stripe_subscription_id");
  if (!stripeSubscriptionId) {
    return json({ error: "Stripe subscription id is missing" }, 409);
  }
  const pricing = await getPricingSettings(db);
  const nextAmount = pricing.subscriptionPlans[parsed.output.passType];
  const currentType = getString2(current, "type");
  if (currentType === parsed.output.passType) {
    return json({
      error: null,
      data: {
        passType: parsed.output.passType,
        renewalAmountJpy: nextAmount,
        chargedNowAmountJpy: 0,
        prorationDate: Math.floor(Date.now() / 1e3)
      }
    });
  }
  const stripeSubscription = await getStripe(
    c.env.STRIPE_SECRET_KEY,
    `/subscriptions/${stripeSubscriptionId}`
  );
  const stripeFetchError = stripeSubscription.error;
  if (stripeFetchError?.message) {
    return json({ error: stripeFetchError.message }, 502);
  }
  const stripeSubscriptionItemId = getSubscriptionItemId(stripeSubscription);
  if (!stripeSubscriptionItemId) {
    return json({ error: "Stripe subscription item is missing" }, 409);
  }
  const prorationDate = Math.floor(Date.now() / 1e3);
  const form = new URLSearchParams();
  form.set("subscription", stripeSubscriptionId);
  form.set("subscription_details[proration_behavior]", "always_invoice");
  form.set("subscription_details[proration_date]", String(prorationDate));
  form.set("subscription_details[items][0][id]", stripeSubscriptionItemId);
  setPreviewPlanPriceData(form, parsed.output.passType, nextAmount);
  const previewInvoice = await postStripeForm2(
    c.env.STRIPE_SECRET_KEY,
    "/invoices/create_preview",
    form
  );
  const previewError = previewInvoice.error;
  if (previewError?.message) {
    return json({ error: previewError.message }, 502);
  }
  return json({
    error: null,
    data: {
      passType: parsed.output.passType,
      renewalAmountJpy: nextAmount,
      chargedNowAmountJpy: getPreviewProrationAmount(previewInvoice),
      prorationDate
    }
  });
});
