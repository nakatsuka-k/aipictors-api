// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { getNow } from "./db"
export var PREMIUM_PURCHASE_EXPIRY_MONTHS = 3;
export var isDuplicatePurchaseError = (error) => {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("duplicate key value") || error.message.includes("UNIQUE constraint failed");
};
export var findExistingPremiumCoinPurchase = async (props) => {
  return props.db.queryOne(
    `SELECT id, lot_id, expires_at, total_coins
       FROM premium_coin_purchases
      WHERE stripe_event_id = $1
         OR ($2::text IS NOT NULL AND stripe_session_id = $2)
         OR ($3::text IS NOT NULL AND stripe_payment_intent_id = $3)
      ORDER BY created_at DESC
      LIMIT 1`,
    [props.stripeEventId, props.stripeSessionId, props.stripePaymentIntentId]
  );
};
export var addMonthsUnix = (unixSeconds, months) => {
  const date = new Date(unixSeconds * 1e3);
  date.setUTCMonth(date.getUTCMonth() + months);
  return Math.floor(date.getTime() / 1e3);
};
export var createPremiumCoinPurchase = async (props) => {
  const existing = await findExistingPremiumCoinPurchase(props);
  if (existing) {
    return {
      created: false,
      purchaseId: existing.id,
      lotId: existing.lot_id,
      expiresAt: existing.expires_at,
      totalCoins: existing.total_coins
    };
  }
  const now = props.now ?? getNow();
  const coins = Math.max(0, Math.floor(props.coins));
  const bonusCoins = Math.max(0, Math.floor(props.bonusCoins));
  const totalCoins = coins + bonusCoins;
  if (totalCoins <= 0) {
    throw new Error("No premium coins to grant");
  }
  const purchaseId = `premium_purchase:${props.stripeEventId}`;
  const expiresAt = addMonthsUnix(now, PREMIUM_PURCHASE_EXPIRY_MONTHS);
  let inserted = null;
  try {
    inserted = await props.db.queryOne(
      `WITH ensured AS (
          INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
          VALUES ($1, 0, 0, $8)
          ON CONFLICT (user_id) DO NOTHING
        ),
        lot AS (
          INSERT INTO coin_lots(
            user_id,
            coin_type,
            remaining,
            locked_amount,
            source_kind,
            source_ref_id,
            granted_by_user_id,
            expires_at,
            created_at,
            updated_at
          )
          VALUES ($1, 'PREMIUM', $2, 0, 'PURCHASE', $3, NULL, $9, $8, $8)
          RETURNING id
        ),
        updated_balance AS (
          UPDATE coin_balances
             SET premium_balance = coin_balances.premium_balance + $2,
                 updated_at = $8
           WHERE user_id = $1
        ),
        ledger AS (
          INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
          VALUES ($1, 'PREMIUM', $2, 'GRANT', 'premium-coin-purchase', 'stripe', $8, $9)
        ),
        purchase AS (
          INSERT INTO premium_coin_purchases(
            id,
            user_id,
            stripe_event_id,
            stripe_session_id,
            stripe_payment_intent_id,
            stripe_charge_id,
            coins,
            bonus_coins,
            total_coins,
            price_yen,
            lot_id,
            expires_at,
            refunded_at,
            refund_event_id,
            created_at,
            updated_at
          )
          SELECT $3, $1, $4, $5, $6, $7, $10, $11, $2, $12, id, $9, NULL, NULL, $8, $8
            FROM lot
          RETURNING lot_id
        )
        SELECT lot_id
          FROM purchase`,
      [
        props.userId,
        totalCoins,
        purchaseId,
        props.stripeEventId,
        props.stripeSessionId,
        props.stripePaymentIntentId,
        props.stripeChargeId ?? null,
        now,
        expiresAt,
        coins,
        bonusCoins,
        Math.max(0, Math.floor(props.priceYen))
      ]
    );
  } catch (error) {
    if (!isDuplicatePurchaseError(error)) {
      throw error;
    }
    const duplicated = await findExistingPremiumCoinPurchase(props);
    if (!duplicated) {
      throw error;
    }
    return {
      created: false,
      purchaseId: duplicated.id,
      lotId: duplicated.lot_id,
      expiresAt: duplicated.expires_at,
      totalCoins: duplicated.total_coins
    };
  }
  return {
    created: true,
    purchaseId,
    lotId: inserted?.lot_id ?? null,
    expiresAt,
    totalCoins
  };
};
export var refundPremiumCoinPurchase = async (props) => {
  const purchase = await props.db.queryOne(
    `SELECT id, total_coins, refunded_at
       FROM premium_coin_purchases
      WHERE ($1::text IS NOT NULL AND stripe_payment_intent_id = $1)
         OR ($2::text IS NOT NULL AND stripe_charge_id = $2)
      ORDER BY created_at DESC
      LIMIT 1`,
    [props.stripePaymentIntentId, props.stripeChargeId]
  );
  if (!purchase) {
    return {
      ok: false,
      code: "PURCHASE_NOT_FOUND"
    };
  }
  if (purchase.refunded_at !== null) {
    return {
      ok: true,
      refundedCoins: 0,
      shortfallCoins: 0,
      deduplicated: true
    };
  }
  const now = props.now ?? getNow();
  const result = await props.db.queryOne(
    `WITH purchase AS (
        SELECT id, user_id, lot_id, total_coins
          FROM premium_coin_purchases
         WHERE id = $1
           AND refunded_at IS NULL
      ),
      refundable AS (
        SELECT LEAST(COALESCE(coin_lots.remaining, 0), COALESCE(purchase.total_coins, 0))::INTEGER AS deducted,
               COALESCE(purchase.total_coins, 0)::INTEGER AS total_coins
          FROM purchase
          LEFT JOIN coin_lots ON coin_lots.id = purchase.lot_id
      ),
      updated_lot AS (
        UPDATE coin_lots
           SET remaining = coin_lots.remaining - (SELECT deducted FROM refundable),
               updated_at = $2
         WHERE coin_lots.id = (SELECT lot_id FROM purchase)
           AND (SELECT deducted FROM refundable) > 0
        RETURNING id
      ),
      ensured_balance AS (
        INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        SELECT user_id, 0, 0, $2
          FROM purchase
        ON CONFLICT (user_id) DO NOTHING
      ),
      updated_balance AS (
        UPDATE coin_balances
           SET premium_balance = GREATEST(
                 coin_balances.premium_balance - (SELECT deducted FROM refundable),
                 0
               ),
               updated_at = $2
         WHERE user_id = (SELECT user_id FROM purchase)
      ),
      ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT user_id,
               'PREMIUM',
               -(SELECT deducted FROM refundable),
               'CONSUME',
               'premium-coin-refund',
               'stripe_refund',
               $2,
               NULL
          FROM purchase
         WHERE (SELECT deducted FROM refundable) > 0
      ),
      updated_purchase AS (
        UPDATE premium_coin_purchases
           SET stripe_charge_id = COALESCE($3, stripe_charge_id),
               refunded_at = $2,
               refund_event_id = $4,
               updated_at = $2
         WHERE id = (SELECT id FROM purchase)
        RETURNING id
      )
      SELECT (SELECT deducted FROM refundable) AS deducted,
             (SELECT total_coins FROM refundable) AS total_coins`,
    [purchase.id, now, props.stripeChargeId, props.stripeEventId]
  );
  const refundedCoins = result?.deducted ?? 0;
  const totalCoins = result?.total_coins ?? purchase.total_coins;
  return {
    ok: true,
    refundedCoins,
    shortfallCoins: Math.max(0, totalCoins - refundedCoins),
    deduplicated: false
  };
};
