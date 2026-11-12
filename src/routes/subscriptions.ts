// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { Hono as Hono2 } from "hono"
import { boolean, literal, nullable, number, object, optional, safeParse, string, union } from "valibot"
import { requireInternalAuth } from "../lib/auth"
import { getDb } from "../lib/db"
import { json } from "../lib/json"
import { getArray, getNumber, getRecord, getString } from "../lib/record-fields"
import { getPlanAmount, getPricingSettings } from "../lib/pricing"
import { saveCancelReason } from "../lib/retention"
import { isPrepaidSubscriptionId, isStripeSubscriptionId } from "../lib/prepaid-pass"
import { getActivePause, pauseSubscription, toPauseResponse, unpauseSubscription } from "../lib/subscription-pause"
import { sendSubscriptionCancellationEmail } from "../lib/subscription-cancellation-email"
import {
  disableSubscriptionByStripeId,
  getActiveOrRecentSubscription,
  getCurrentSubscription,
  getSubscriptionByNanoid,
  hasPreviousSubscription,
  upsertSubscription,
} from "../lib/subscriptions"
import {
  cancelOtherActiveSubscriptions,
  claimCurrentSubscriptionCheck,
  getPreviewProrationAmount,
  getStripe,
  getStripeCustomerEmail,
  getSubscriptionInterval,
  getSubscriptionItemId,
  isInvoicePaid,
  postStripeForm2,
  setPlanPriceData,
  setPreviewPlanPriceData,
  syncCurrentSubscriptionFromStripe,
  toDeliverableEmail,
} from "../lib/subscription-stripe"
export * from "../lib/subscription-stripe"
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
  userEmail: optional(nullable(string())),
  // 解約の理由（lib/retention.ts の CANCEL_REASONS）。任意
  reason: optional(nullable(string())),
  reasonNote: optional(nullable(string()))
});
export var changePlanSchema = object({
  userId: string(),
  passType: union([literal("LITE"), literal("STANDARD"), literal("PREMIUM")]),
  prorationDate: optional(number())
});
export var pauseSchema = object({
  userId: string(),
  reason: optional(nullable(string()))
});
export var subscriptionRoutes = new Hono2();
subscriptionRoutes.use("*", requireInternalAuth);
// 1 か月休止（lib/subscription-pause.ts）
subscriptionRoutes.get("/pause/:userId", async (c) => {
  const db = await getDb(c.env);
  return json({ error: null, data: toPauseResponse(await getActivePause(db, c.req.param("userId"))) });
});
subscriptionRoutes.post("/pause-current", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: "STRIPE_SECRET_KEY is not configured" }, 500);
  }
  const parsed = safeParse(pauseSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  const current = await getCurrentSubscription(db, parsed.output.userId);
  if (!current) {
    return json({ error: "No active subscription found" }, 404);
  }
  if (parsed.output.reason) {
    await saveCancelReason(db, {
      userId: parsed.output.userId,
      current,
      reason: parsed.output.reason,
      note: "pause"
    }).catch((error) => console.error("[subscriptions.pause-current] failed to save reason", error));
  }
  const result = await pauseSubscription(c.env.STRIPE_SECRET_KEY, db, {
    userId: parsed.output.userId,
    current,
    reason: parsed.output.reason ?? null
  });
  if (result.error) {
    return json({ error: result.error }, result.status ?? 500);
  }
  return json({ error: null, data: toPauseResponse(result.data) });
});
subscriptionRoutes.post("/unpause-current", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: "STRIPE_SECRET_KEY is not configured" }, 500);
  }
  const parsed = safeParse(pauseSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  const result = await unpauseSubscription(c.env.STRIPE_SECRET_KEY, db, parsed.output.userId);
  if (result.error) {
    return json({ error: result.error }, result.status ?? 500);
  }
  return json({ error: null, data: null });
});
subscriptionRoutes.get("/current/:userId", async (c) => {
  const db = await getDb(c.env);
  const current = await getCurrentSubscription(db, c.req.param("userId"));
  if (!current) {
    return json({ error: null, data: null });
  }
  const stripeSubscriptionId = getString(current, "stripe_subscription_id");
  // Stripe の自動更新の契約だけ Stripe に確かめる（自動更新なしのパス・アプリのストアは対象外）
  if (!isStripeSubscriptionId(stripeSubscriptionId) || !c.env.STRIPE_SECRET_KEY || !claimCurrentSubscriptionCheck(current)) {
    return json({ error: null, data: current });
  }
  // 解約予定のときだけ、応答を待たせて確かめる（取り消しがすぐ見えるように）
  if (getString(current, "status") === "cancellation_requested") {
    return json({ error: null, data: await syncCurrentSubscriptionFromStripe(c.env.STRIPE_SECRET_KEY, db, current) });
  }
  // それ以外は DB の値を返し、裏で確かめる（結果は次の取得から見える）
  c.executionCtx.waitUntil(syncCurrentSubscriptionFromStripe(c.env.STRIPE_SECRET_KEY, db, current));
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
      WHERE user_id = $1 AND is_disabled = FALSE AND stripe_subscription_id LIKE 'sub_%'
        AND current_period_end > unixepoch() - 60 * 86400
      ORDER BY current_period_end DESC LIMIT 3`,
    [c.req.param("userId")]
  );
  for (const row of rows) {
    try {
      const sub = await getStripe(
        c.env.STRIPE_SECRET_KEY,
        `/subscriptions/${row.stripe_subscription_id}?expand[]=latest_invoice`
      );
      const status = getString(sub, "status");
      if (!["past_due", "unpaid", "incomplete"].includes(status ?? "")) {
        continue;
      }
      const invoice = getRecord(sub, "latest_invoice");
      if (!invoice || getString(invoice, "status") !== "open") {
        continue;
      }
      const url = getString(invoice, "hosted_invoice_url");
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
// 契約中のカードを変更するための Stripe カスタマーポータル（カード変更・請求履歴だけ出す設定）の URL を返す。
// 解約・プラン変更はポータルではなく /plus から行う（DB の状態と合わせるため）。
subscriptionRoutes.post("/billing-portal/:userId", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: "Stripe is not configured", data: null }, 500);
  }
  const db = await getDb(c.env);
  const rows = await db.query(
    `SELECT stripe_subscription_id FROM subscriptions
      WHERE user_id = $1 AND stripe_subscription_id LIKE 'sub_%'
      ORDER BY is_disabled ASC, current_period_end DESC LIMIT 3`,
    [c.req.param("userId")]
  );
  let customerId = null;
  for (const row of rows) {
    const sub = await getStripe(c.env.STRIPE_SECRET_KEY, `/subscriptions/${row.stripe_subscription_id}`);
    customerId = typeof sub?.customer === "string" ? sub.customer : null;
    if (customerId) {
      break;
    }
  }
  if (!customerId) {
    return json({ error: "お支払い情報が見つかりませんでした", data: null }, 404);
  }
  const form = new URLSearchParams();
  form.set("customer", customerId);
  form.set("return_url", "https://www.aipictors.com/plus");
  form.set("locale", "ja");
  if (c.env.BILLING_PORTAL_CONFIGURATION_ID) {
    form.set("configuration", c.env.BILLING_PORTAL_CONFIGURATION_ID);
  }
  form.set("flow_data[type]", "payment_method_update");
  const session = await postStripeForm2(c.env.STRIPE_SECRET_KEY, "/billing_portal/sessions", form);
  const url = getString(session ?? {}, "url");
  if (!url) {
    console.warn("[subscriptions.billing-portal] failed", session?.error?.message);
    return json({ error: "お支払い方法の変更画面を開けませんでした", data: null }, 502);
  }
  return json({ error: null, data: { url } });
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
          getString(current ?? {}, "stripe_subscription_id")
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
  if (isPrepaidSubscriptionId(getString(current, "stripe_subscription_id"))) {
    return json({ error: "自動更新なしのパスは解約の手続きは不要です（期限が来ると自動で終わります）" }, 409);
  }
  if (parsed.output.reason) {
    await saveCancelReason(db, {
      userId: parsed.output.userId,
      current,
      reason: parsed.output.reason,
      note: parsed.output.reasonNote
    }).catch((error) => console.error("[subscriptions.cancel-current] failed to save reason", error));
  }
  const stripeSubscriptionId = getString(current, "stripe_subscription_id");
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
    sendCancellationEmail("canceled", getString(stripeResponse, "customer"));
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
  sendCancellationEmail("cancellation_requested", getString(stripeResponse, "customer"));
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
  const stripeSubscriptionId = getString(current, "stripe_subscription_id");
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
  const stripeSubscriptionId = getString(current, "stripe_subscription_id");
  if (!stripeSubscriptionId) {
    return json({ error: "Stripe subscription id is missing" }, 409);
  }
  if (isPrepaidSubscriptionId(stripeSubscriptionId)) {
    return json({ error: "自動更新なしのパスはプランを変更できません。期限が切れてから新しく購入してください" }, 409);
  }
  const pricing = await getPricingSettings(db);
  const currentType = getString(current, "type");
  if (currentType === parsed.output.passType) {
    const nextAmount = pricing.subscriptionPlans[parsed.output.passType];
    return json({
      error: null,
      data: {
        passType: parsed.output.passType,
        renewalAmountJpy: nextAmount,
        chargedNowAmountJpy: 0,
        status: getString(current, "status") ?? "active"
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
  // 年払いの人は年払いのまま変える
  const interval = getSubscriptionInterval(stripeSubscription);
  const nextAmount = getPlanAmount(pricing, parsed.output.passType, interval);
  const subscriptionNanoid = getString(current, "nanoid");
  const prorationDate = typeof parsed.output.prorationDate === "number" && Number.isFinite(parsed.output.prorationDate) ? parsed.output.prorationDate : void 0;
  const form = new URLSearchParams();
  form.set("proration_behavior", "always_invoice");
  form.set("payment_behavior", "default_incomplete");
  form.set("cancel_at_period_end", "false");
  form.set("expand[]", "latest_invoice");
  form.set("expand[]", "latest_invoice.payment_intent");
  form.set("items[0][id]", stripeSubscriptionItemId);
  setPlanPriceData(form, parsed.output.passType, nextAmount, interval);
  // 無料お試し中のプラン変更は、お試しをその場で終えて新しいプランの料金を請求する（お試しのまま上のプランを無料で使えないように）
  if (getString(stripeSubscription, "status") === "trialing") {
    form.set("trial_end", "now");
  }
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
  const hostedInvoiceUrl = getString(latestInvoice ?? {}, "hosted_invoice_url");
  const paymentIntentStatus = getString(paymentIntent ?? {}, "status");
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
        interval,
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
      getString(updatedFirstItem ?? {}, "id") ?? stripeSubscriptionItemId,
      getString(updatedPrice ?? {}, "id"),
      getString(updatedPrice ?? {}, "product"),
      stripeSubscriptionId
    ]
  );
  return json({
    error: null,
    data: {
      passType: parsed.output.passType,
      renewalAmountJpy: nextAmount,
      interval,
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
  const stripeSubscriptionId = getString(current, "stripe_subscription_id");
  if (!stripeSubscriptionId) {
    return json({ error: "Stripe subscription id is missing" }, 409);
  }
  if (isPrepaidSubscriptionId(stripeSubscriptionId)) {
    return json({ error: "自動更新なしのパスはプランを変更できません。期限が切れてから新しく購入してください" }, 409);
  }
  const pricing = await getPricingSettings(db);
  const currentType = getString(current, "type");
  if (currentType === parsed.output.passType) {
    const nextAmount = pricing.subscriptionPlans[parsed.output.passType];
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
  const interval = getSubscriptionInterval(stripeSubscription);
  const nextAmount = getPlanAmount(pricing, parsed.output.passType, interval);
  const prorationDate = Math.floor(Date.now() / 1e3);
  const form = new URLSearchParams();
  form.set("subscription", stripeSubscriptionId);
  form.set("subscription_details[proration_behavior]", "always_invoice");
  form.set("subscription_details[proration_date]", String(prorationDate));
  form.set("subscription_details[items][0][id]", stripeSubscriptionItemId);
  setPreviewPlanPriceData(form, parsed.output.passType, nextAmount, interval);
  if (getString(stripeSubscription, "status") === "trialing") {
    form.set("subscription_details[trial_end]", "now");
  }
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
      interval,
      chargedNowAmountJpy: getPreviewProrationAmount(previewInvoice),
      prorationDate
    }
  });
});
