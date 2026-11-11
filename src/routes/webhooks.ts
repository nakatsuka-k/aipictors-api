// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { Hono as Hono2 } from "hono"
import { getDb, getNow } from "../lib/db"
import { json } from "../lib/json"
import { applyPointDelta } from "../lib/points"
import { grantRenewalBonus } from "../lib/loyalty"
import { createPremiumCoinPurchase, refundPremiumCoinPurchase } from "../lib/premium-coins"
import { getNumber, getString } from "../lib/record-fields"
import { verifyStripeSignature } from "../lib/stripe"
import { disableSubscriptionByStripeId, upsertSubscription } from "../lib/subscriptions"
import { cancelPausedSubscriptionsOnNewSubscription } from "../lib/subscription-pause"
import { applyPrepaidPassFromSession } from "../lib/prepaid-pass"
export var getStringByKeys = (record, keys) => {
  for (const key of keys) {
    const value = getString(record, key);
    if (value) {
      return value;
    }
  }
  return null;
};
export var stripeProductIdToPassType = {
  prod_One9y8yOCumS2G: "LITE",
  prod_OaCLGmzAoDVJjY: "STANDARD",
  prod_OneEB60sXmxvu1: "PREMIUM"
};
export var stripePriceIdToPassType = {
  price_1O02qmGjkGNUZhU2amH1gS8U: "LITE",
  price_1O02dwGjkGNUZhU2hJZvfT3Y: "STANDARD",
  price_1O02vrGjkGNUZhU2Lx0X217T: "PREMIUM"
};
export var inferPassType = (props) => {
  if (props.stripePriceId && stripePriceIdToPassType[props.stripePriceId]) {
    return stripePriceIdToPassType[props.stripePriceId];
  }
  if (props.stripeProductId && stripeProductIdToPassType[props.stripeProductId]) {
    return stripeProductIdToPassType[props.stripeProductId];
  }
  return null;
};
export var getMetadataFromInvoice = (invoice) => {
  const direct = invoice.subscription_details;
  if (direct?.metadata) {
    return direct.metadata;
  }
  const parent = invoice.parent;
  const parentSubscription = parent?.subscription_details;
  if (parentSubscription?.metadata) {
    return parentSubscription.metadata;
  }
  const paymentIntent = invoice.payment_intent;
  if (paymentIntent?.metadata) {
    return paymentIntent.metadata;
  }
  return invoice.metadata ?? {};
};
export var fetchStripeSubscription = async (secretKey, subscriptionId) => {
  const response = await fetch(
    `https://api.stripe.com/v1/subscriptions/${subscriptionId}?expand[]=items.data.price`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`
      }
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Stripe subscription fetch failed (${response.status}): ${text}`);
  }
  return response.json();
};
export var webhookRoutes = new Hono2();
webhookRoutes.post("/stripe/premium-coins", async (c) => {
  const db = await getDb(c.env);
  const webhookSecret = c.env.STRIPE_WEBHOOK_SECRET_PREMIUM_COINS ?? c.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return json(
      { error: "STRIPE_WEBHOOK_SECRET_PREMIUM_COINS (or STRIPE_WEBHOOK_SECRET) is not configured" },
      500
    );
  }
  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return json({ error: "Missing stripe-signature" }, 400);
  }
  const payload = await c.req.text();
  const verified = await verifyStripeSignature({
    payload,
    signatureHeader: signature,
    secret: webhookSecret
  });
  if (!verified) {
    return json({ error: "Invalid signature" }, 401);
  }
  const event = JSON.parse(payload);
  const dedupKey = `premium-coins:${event.id}`;
  const existing = await db.queryOne(
    "SELECT event_id FROM webhook_events WHERE event_id = $1",
    [dedupKey]
  );
  if (existing) {
    return json({ error: null, data: { deduplicated: true } });
  }
  const object2 = event.data.object;
  if (event.type === "checkout.session.completed") {
    const metadata = object2.metadata ?? {};
    const kind = getString(metadata, "kind");
    // 自動更新なしのプラン（PayPay などの 1 回払い）。決済後の画面からも反映するが、画面を閉じた人のためにここでも反映する
    if (kind === "prepaid_pass") {
      const result = await applyPrepaidPassFromSession(db, object2);
      if (result.error) {
        console.error("[webhooks.premium-coins] prepaid pass not applied", { eventId: event.id, error: result.error });
      }
    }
    if (kind === "premium_coins") {
      const userId = getString(metadata, "user_id");
      const coins = Number.parseInt(getString(metadata, "coins") ?? "", 10);
      const bonusCoins = Number.parseInt(getString(metadata, "bonus_coins") ?? "", 10);
      const priceYen = Number.parseInt(getString(metadata, "price_yen") ?? "", 10);
      if (userId && Number.isFinite(coins) && Number.isFinite(bonusCoins) && Number.isFinite(priceYen)) {
        await createPremiumCoinPurchase({
          db,
          userId,
          stripeEventId: event.id,
          stripeSessionId: getString(object2, "id"),
          stripePaymentIntentId: getString(object2, "payment_intent"),
          stripeChargeId: null,
          coins,
          bonusCoins,
          priceYen
        });
      }
    }
  }
  if (event.type === "charge.refunded") {
    await refundPremiumCoinPurchase({
      db,
      stripeEventId: event.id,
      stripePaymentIntentId: getString(object2, "payment_intent"),
      stripeChargeId: getString(object2, "id")
    });
  }
  await db.execute(
    "INSERT INTO webhook_events(event_id, type, processed_at) VALUES ($1, $2, $3)",
    [dedupKey, event.type, getNow()]
  );
  return json({ error: null, data: true });
});
webhookRoutes.post("/stripe", async (c) => {
  const db = await getDb(c.env);
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: "STRIPE_WEBHOOK_SECRET is not configured" }, 500);
  }
  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return json({ error: "Missing stripe-signature" }, 400);
  }
  const payload = await c.req.text();
  const verified = await verifyStripeSignature({
    payload,
    signatureHeader: signature,
    secret: c.env.STRIPE_WEBHOOK_SECRET
    // whsec_UP3faIEtqFPiqxTlk7Lbx1iYS6X0BgiL
  });
  if (!verified) {
    return json({ error: "Invalid signature" }, 401);
  }
  const event = JSON.parse(payload);
  const dedupKey = `stripe:${event.id}`;
  const existing = await db.queryOne(
    "SELECT event_id FROM webhook_events WHERE event_id = $1",
    [dedupKey]
  );
  if (existing) {
    return json({ error: null, data: { deduplicated: true } });
  }
  const object2 = event.data.object;
  if (event.type === "checkout.session.completed") {
    const metadata = object2.metadata ?? {};
    const kind = getString(metadata, "kind");
    if (kind === "points") {
      const userId = getString(metadata, "user_id");
      const points = Number.parseInt(getString(metadata, "points") ?? "", 10);
      if (userId && Number.isFinite(points)) {
        await applyPointDelta({
          db,
          userId,
          delta: points,
          kind: "PURCHASE",
          reason: "Stripe checkout completed",
          stripeEventId: event.id,
          stripeSessionId: getString(object2, "id")
        });
      }
    }
  }
  if (event.type === "invoice.payment_succeeded") {
    let metadata = getMetadataFromInvoice(object2);
    const subscriptionId = getString(object2, "subscription");
    let userId = getStringByKeys(metadata, ["user_id", "user_index"]);
    let nanoid = getStringByKeys(metadata, ["subscription_nanoid", "pass_id", "subscription_id"]);
    let passType = getString(metadata, "pass_type");
    let subscriptionCurrentPeriodStart = null;
    let subscriptionCurrentPeriodEnd = null;
    let stripePriceId = null;
    let stripeProductId = null;
    let stripeSubscriptionItemId = null;
    if ((!userId || !nanoid || !passType) && subscriptionId && c.env.STRIPE_SECRET_KEY) {
      try {
        const stripeSubscription = await fetchStripeSubscription(
          c.env.STRIPE_SECRET_KEY,
          subscriptionId
        );
        const stripeMetadata = stripeSubscription.metadata ?? {};
        metadata = { ...stripeMetadata, ...metadata };
        userId = userId ?? getStringByKeys(stripeMetadata, ["user_id", "user_index"]);
        nanoid = nanoid ?? getStringByKeys(stripeMetadata, ["subscription_nanoid", "pass_id", "subscription_id"]);
        passType = passType ?? getString(stripeMetadata, "pass_type");
        subscriptionCurrentPeriodStart = getNumber(stripeSubscription, "current_period_start");
        subscriptionCurrentPeriodEnd = getNumber(stripeSubscription, "current_period_end");
        const items = stripeSubscription.items;
        const firstItem = Array.isArray(items?.data) ? items.data[0] : void 0;
        stripeSubscriptionItemId = getString(firstItem ?? {}, "id");
        const price = firstItem?.price ?? {};
        stripePriceId = getString(price, "id");
        stripeProductId = getString(price, "product");
        passType = passType ?? inferPassType({ stripePriceId, stripeProductId });
      } catch (error) {
        console.warn("Failed to fetch Stripe subscription for metadata fallback", {
          eventId: event.id,
          subscriptionId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const createdAt = getNumber(object2, "created") ?? Math.floor(Date.now() / 1e3);
    const lines = object2.lines;
    const firstLine = Array.isArray(lines?.data) ? lines.data[0] : void 0;
    const period = firstLine?.period ?? {};
    const periodStart = getNumber(period, "start") ?? getNumber(object2, "period_start") ?? createdAt;
    const periodEnd = getNumber(period, "end") ?? getNumber(object2, "period_end") ?? createdAt + 30 * 24 * 60 * 60;
    const debugInfo = {
      eventId: event.id,
      metadata,
      userId,
      nanoid,
      passType,
      subscriptionId,
      invoiceId: getString(object2, "id"),
      source: (!getStringByKeys(getMetadataFromInvoice(object2), ["user_id", "user_index"]) || !getStringByKeys(getMetadataFromInvoice(object2), [
        "subscription_nanoid",
        "pass_id",
        "subscription_id"
      ]) || !getString(getMetadataFromInvoice(object2), "pass_type")) && subscriptionId ? "stripe.subscription_fallback" : "invoice_metadata",
      period_start: periodStart,
      period_end: periodEnd,
      stripePriceId,
      stripeProductId
    };
    console.log("invoice.payment_succeeded webhook:", debugInfo);
    try {
      await db.execute(
        `INSERT INTO webhook_debug(event_id, event_type, debug_info, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_id) DO UPDATE SET
           event_type = EXCLUDED.event_type,
           debug_info = EXCLUDED.debug_info,
           created_at = EXCLUDED.created_at`,
        [event.id, event.type, JSON.stringify(debugInfo), getNow()]
      );
    } catch (error) {
      console.warn("Failed to persist webhook_debug record", {
        eventId: event.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    if (userId && nanoid && passType) {
      console.log("Upserting subscription for user:", userId);
      await upsertSubscription(db, {
        nanoid,
        userId,
        type: passType,
        status: getString(object2, "status") ?? "active",
        isDisabled: false,
        createdAt,
        currentPeriodStart: subscriptionCurrentPeriodStart ?? periodStart,
        currentPeriodEnd: subscriptionCurrentPeriodEnd ?? periodEnd,
        trialStart: null,
        trialEnd: null,
        stripeSubscriptionId: subscriptionId ?? "",
        stripeLatestInvoiceId: getString(object2, "id"),
        stripePaymentIntentId: getString(object2, "payment_intent"),
        stripeSubscriptionItemId,
        stripePriceId,
        stripeProductId
      });
      // 休止中の人が新しく入り直したら、休止中の古い契約を止める（再開時の二重請求を防ぐ）
      if (getString(object2, "billing_reason") === "subscription_create") {
        await cancelPausedSubscriptionsOnNewSubscription(c.env.STRIPE_SECRET_KEY, db, userId, subscriptionId);
      }
      // 更新（2か月目以降）のたびに継続ボーナスのプレミアムコインを付ける
      if (getString(object2, "billing_reason") === "subscription_cycle") {
        try {
          await grantRenewalBonus({ db, userId, passType, invoiceId: getString(object2, "id") });
        } catch (error) {
          console.warn("Failed to grant renewal bonus", {
            eventId: event.id,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } else {
      console.warn("Missing required metadata for subscription upsert:", {
        userId: !!userId,
        nanoid: !!nanoid,
        passType: !!passType
      });
    }
  }
  if (event.type === "customer.subscription.deleted") {
    const subscriptionId = getString(object2, "id");
    if (subscriptionId) {
      await disableSubscriptionByStripeId(db, subscriptionId);
    }
  }
  await db.execute("INSERT INTO webhook_events(event_id, type, processed_at) VALUES ($1, $2, $3)", [
    dedupKey,
    event.type,
    getNow()
  ]);
  return json({ error: null, data: true });
});
