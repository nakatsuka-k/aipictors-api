// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { Hono as Hono2 } from "hono"
import { literal, number, object, optional, safeParse, string, union } from "valibot"
import { requireInternalAuth } from "../lib/auth"
import { getDb } from "../lib/db"
import { json } from "../lib/json"
import { createPremiumCoinPurchase } from "../lib/premium-coins"
import { createPointCheckout, createPremiumCoinCheckout, createSubscriptionCheckout, fetchStripeCheckoutSession } from "../lib/stripe"
export var getString = (record, key) => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};
export var pointCheckoutSchema = object({
  userId: string(),
  points: union([literal(100), literal(300), literal(1e3)]),
  origin: string()
});
export var subscriptionCheckoutSchema = object({
  userId: string(),
  passType: union([literal("LITE"), literal("STANDARD"), literal("PREMIUM")]),
  origin: string()
});
export var premiumCoinCheckoutSchema = object({
  userId: string(),
  coins: number(),
  bonusCoins: number(),
  priceYen: number(),
  origin: string(),
  successPath: optional(string()),
  cancelPath: optional(string())
});
export var premiumCoinConfirmSchema = object({
  userId: string(),
  sessionId: string()
});
export var stripeRoutes = new Hono2();
stripeRoutes.use("/checkout/*", requireInternalAuth);
stripeRoutes.post("/checkout/points", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: "STRIPE_SECRET_KEY is not configured" }, 500);
  }
  const parsed = safeParse(pointCheckoutSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  const response = await createPointCheckout({
    secretKey: c.env.STRIPE_SECRET_KEY,
    origin: parsed.output.origin,
    userId: parsed.output.userId,
    points: parsed.output.points,
    db
  });
  if (!response.url) {
    return json({ error: response.error?.message ?? "Failed to create checkout session" }, 502);
  }
  return json({ error: null, data: { url: response.url } });
});
stripeRoutes.post("/checkout/subscription", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: "STRIPE_SECRET_KEY is not configured" }, 500);
  }
  const parsed = safeParse(subscriptionCheckoutSchema, await c.req.json());
  if (!parsed.success) {
    console.error("Invalid checkout request:", parsed.issues);
    return json({ error: "Invalid body" }, 400);
  }
  try {
    const db = await getDb(c.env);
    const response = await createSubscriptionCheckout({
      secretKey: c.env.STRIPE_SECRET_KEY,
      origin: parsed.output.origin,
      userId: parsed.output.userId,
      passType: parsed.output.passType,
      db
    });
    if (!response.url) {
      const errorMsg = response.error?.message ?? "Failed to create checkout session";
      console.error("Checkout session creation failed:", {
        userId: parsed.output.userId,
        passType: parsed.output.passType,
        error: errorMsg
      });
      return json({ error: errorMsg }, 502);
    }
    console.log("Checkout session created successfully:", {
      userId: parsed.output.userId,
      passType: parsed.output.passType,
      url: response.url?.substring(0, 50) + "..."
    });
    return json({ error: null, data: { url: response.url } });
  } catch (error) {
    console.error("Checkout error:", error);
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
stripeRoutes.post("/checkout/premium-coins", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: "STRIPE_SECRET_KEY is not configured" }, 500);
  }
  const parsed = safeParse(premiumCoinCheckoutSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const response = await createPremiumCoinCheckout({
    secretKey: c.env.STRIPE_SECRET_KEY,
    origin: parsed.output.origin,
    userId: parsed.output.userId,
    coins: parsed.output.coins,
    bonusCoins: parsed.output.bonusCoins,
    priceYen: parsed.output.priceYen,
    successPath: parsed.output.successPath,
    cancelPath: parsed.output.cancelPath
  });
  if (!response.url) {
    return json({ error: response.error?.message ?? "Failed to create checkout session" }, 502);
  }
  return json({ error: null, data: { url: response.url } });
});
stripeRoutes.post("/checkout/premium-coins/confirm", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: "STRIPE_SECRET_KEY is not configured" }, 500);
  }
  const parsed = safeParse(premiumCoinConfirmSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  const existing = await db.queryOne(
    `SELECT id, total_coins
       FROM premium_coin_purchases
      WHERE user_id = $1
        AND stripe_session_id = $2
      LIMIT 1`,
    [parsed.output.userId, parsed.output.sessionId]
  );
  if (existing) {
    return json({
      error: null,
      data: {
        reflected: true,
        created: false,
        totalCoins: existing.total_coins,
        purchaseId: existing.id
      }
    });
  }
  let session;
  try {
    session = await fetchStripeCheckoutSession({
      secretKey: c.env.STRIPE_SECRET_KEY,
      sessionId: parsed.output.sessionId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe checkout session fetch failed";
    if (message.includes("Stripe checkout session fetch failed (429)")) {
      return json({
        error: null,
        data: {
          reflected: false,
          created: false,
          paymentStatus: "rate_limited"
        }
      });
    }
    throw error;
  }
  const metadata = session.metadata ?? {};
  const kind = getString(metadata, "kind");
  const userId = getString(metadata, "user_id");
  const paymentStatus = getString(session, "payment_status");
  if (kind !== "premium_coins") {
    return json({ error: "Invalid checkout kind" }, 400);
  }
  if (userId !== parsed.output.userId) {
    return json({ error: "Checkout session does not belong to this user" }, 403);
  }
  if (paymentStatus !== "paid") {
    return json({
      error: null,
      data: {
        reflected: false,
        created: false,
        paymentStatus
      }
    });
  }
  const coins = Number.parseInt(getString(metadata, "coins") ?? "", 10);
  const bonusCoins = Number.parseInt(getString(metadata, "bonus_coins") ?? "", 10);
  const priceYen = Number.parseInt(getString(metadata, "price_yen") ?? "", 10);
  if (!Number.isFinite(coins) || !Number.isFinite(bonusCoins) || !Number.isFinite(priceYen)) {
    return json({ error: "Invalid premium coin metadata" }, 400);
  }
  const result = await createPremiumCoinPurchase({
    db,
    userId: parsed.output.userId,
    stripeEventId: `checkout_session:${parsed.output.sessionId}`,
    stripeSessionId: getString(session, "id"),
    stripePaymentIntentId: getString(session, "payment_intent"),
    stripeChargeId: null,
    coins,
    bonusCoins,
    priceYen
  });
  return json({
    error: null,
    data: {
      reflected: true,
      created: result.created,
      totalCoins: result.totalCoins,
      purchaseId: result.purchaseId
    }
  });
});
