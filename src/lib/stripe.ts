// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { getPricingSettings } from "./pricing"
export var encoder = new TextEncoder();
export var toHex2 = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
export var signPayload = async (secret, payload) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return toHex2(new Uint8Array(signature));
};
export var constantTimeEqual = (a2, b2) => {
  if (a2.length !== b2.length) return false;
  let diff = 0;
  for (let i = 0; i < a2.length; i += 1) {
    diff |= a2.charCodeAt(i) ^ b2.charCodeAt(i);
  }
  return diff === 0;
};
export var verifyStripeSignature = async (props) => {
  const parts = props.signatureHeader.split(",").map((value) => value.trim());
  const timestamp = parts.find((value) => value.startsWith("t="))?.slice(2);
  const signatures = parts.filter((value) => value.startsWith("v1=")).map((value) => value.slice(3));
  if (!timestamp || signatures.length === 0) {
    return false;
  }
  const tolerance = props.toleranceSeconds ?? 300;
  const timestampInt = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampInt)) {
    return false;
  }
  const now = Math.floor(Date.now() / 1e3);
  if (Math.abs(now - timestampInt) > tolerance) {
    return false;
  }
  const expected = await signPayload(props.secret, `${timestamp}.${props.payload}`);
  return signatures.some((value) => constantTimeEqual(value, expected));
};
export var postStripeForm = async (secretKey, params) => {
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });
  return response.json();
};
export var fetchStripeCheckoutSession = async (props) => {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${props.sessionId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${props.secretKey}`
        }
      }
    );
    if (response.ok) {
      return response.json();
    }
    if (response.status === 429 && attempt < maxAttempts) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = Number.parseInt(retryAfterHeader ?? "", 10);
      const backoffMs = Number.isFinite(retryAfterSeconds) ? Math.max(1, retryAfterSeconds) * 1e3 : attempt * 500;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }
    const text = await response.text();
    throw new Error(`Stripe checkout session fetch failed (${response.status}): ${text}`);
  }
  throw new Error("Stripe checkout session fetch failed: exhausted retries");
};
export var createPointCheckout = async (props) => {
  const pricing = await getPricingSettings(props.db);
  const amount = pricing.pointPackages[String(props.points)];
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", `${props.origin}/settings/points?checkout=success`);
  params.set("cancel_url", `${props.origin}/settings/points?checkout=cancel`);
  params.set("client_reference_id", props.userId);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "jpy");
  params.set("line_items[0][price_data][unit_amount]", String(amount));
  params.set("line_items[0][price_data][product_data][name]", `Aipictors ${props.points} points`);
  params.set("metadata[kind]", "points");
  params.set("metadata[user_id]", props.userId);
  params.set("metadata[points]", String(props.points));
  params.set("metadata[amount_jpy]", String(amount));
  params.set("payment_intent_data[metadata][kind]", "points");
  params.set("payment_intent_data[metadata][user_id]", props.userId);
  params.set("payment_intent_data[metadata][points]", String(props.points));
  return postStripeForm(props.secretKey, params);
};
export var createSubscriptionCheckout = async (props) => {
  const pricing = await getPricingSettings(props.db);
  const amount = pricing.subscriptionPlans[props.passType];
  const nanoid = crypto.randomUUID();
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("success_url", `${props.origin}/plus/success`);
  params.set("cancel_url", `${props.origin}/plus/cancel`);
  params.set("client_reference_id", props.userId);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "jpy");
  params.set("line_items[0][price_data][unit_amount]", String(amount));
  params.set("line_items[0][price_data][recurring][interval]", "month");
  params.set("line_items[0][price_data][product_data][name]", `Aipictors ${props.passType}`);
  params.set("metadata[kind]", "subscription");
  params.set("metadata[user_id]", props.userId);
  params.set("metadata[pass_type]", props.passType);
  params.set("metadata[subscription_nanoid]", nanoid);
  params.set("subscription_data[metadata][kind]", "subscription");
  params.set("subscription_data[metadata][user_id]", props.userId);
  params.set("subscription_data[metadata][pass_type]", props.passType);
  params.set("subscription_data[metadata][subscription_nanoid]", nanoid);
  return postStripeForm(props.secretKey, params);
};
export var createPremiumCoinCheckout = async (props) => {
  const coins = Math.max(0, Math.floor(props.coins));
  const bonusCoins = Math.max(0, Math.floor(props.bonusCoins));
  const totalCoins = coins + bonusCoins;
  const priceYen = Math.max(0, Math.floor(props.priceYen));
  const successUrl = new URL(props.successPath ?? "/settings/points", props.origin);
  successUrl.searchParams.set("checkout", "premium-success");
  const successUrlWithSessionId = `${successUrl.toString()}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = new URL(props.cancelPath ?? "/settings/points", props.origin);
  cancelUrl.searchParams.set("checkout", "premium-cancel");
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", successUrlWithSessionId);
  params.set("cancel_url", cancelUrl.toString());
  params.set("client_reference_id", props.userId);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "jpy");
  params.set("line_items[0][price_data][unit_amount]", String(priceYen));
  params.set(
    "line_items[0][price_data][product_data][name]",
    `Aipictors Premium Coins ${totalCoins}`
  );
  params.set("metadata[kind]", "premium_coins");
  params.set("metadata[user_id]", props.userId);
  params.set("metadata[coins]", String(coins));
  params.set("metadata[bonus_coins]", String(bonusCoins));
  params.set("metadata[total_coins]", String(totalCoins));
  params.set("metadata[price_yen]", String(priceYen));
  params.set("payment_intent_data[metadata][kind]", "premium_coins");
  params.set("payment_intent_data[metadata][user_id]", props.userId);
  params.set("payment_intent_data[metadata][coins]", String(coins));
  params.set("payment_intent_data[metadata][bonus_coins]", String(bonusCoins));
  params.set("payment_intent_data[metadata][total_coins]", String(totalCoins));
  params.set("payment_intent_data[metadata][price_yen]", String(priceYen));
  return postStripeForm(props.secretKey, params);
};
