import type { DbClient } from '@/lib/db'

export type SubscriptionUpsertInput = {
  nanoid: string
  userId: string
  type: string
  status: string
  isDisabled: boolean
  createdAt: number
  currentPeriodStart: number
  currentPeriodEnd: number
  trialStart: number | null
  trialEnd: number | null
  stripeSubscriptionId: string
  stripeLatestInvoiceId: string | null
  stripePaymentIntentId: string | null
  stripeSubscriptionItemId: string | null
  stripePriceId: string | null
  stripeProductId: string | null
}

export const getCurrentSubscription = async (db: DbClient, userId: string) =>
  db.queryOne<Record<string, unknown>>(
    `SELECT * FROM subscriptions
      WHERE user_id = $1 AND is_disabled = FALSE AND current_period_end > EXTRACT(EPOCH FROM NOW())::bigint
      ORDER BY current_period_end DESC LIMIT 1`,
    [userId],
  )

export const getActiveOrRecentSubscription = async (db: DbClient, userId: string) =>
  db.queryOne<Record<string, unknown>>(
    `SELECT * FROM subscriptions
      WHERE user_id = $1 AND is_disabled = FALSE
      ORDER BY current_period_end DESC LIMIT 1`,
    [userId],
  )

export const hasPreviousSubscription = async (db: DbClient, userId: string) => {
  const row = await db.queryOne<{ id: number }>(
    'SELECT id FROM subscriptions WHERE user_id = $1 LIMIT 1',
    [userId],
  )

  return row !== null
}

export const getSubscriptionByNanoid = async (db: DbClient, nanoid: string) =>
  db.queryOne<Record<string, unknown>>('SELECT * FROM subscriptions WHERE nanoid = $1 LIMIT 1', [
    nanoid,
  ])

export const upsertSubscription = async (db: DbClient, input: SubscriptionUpsertInput) => {
  await db.execute(
    `INSERT INTO subscriptions(
      nanoid, user_id, type, status, is_disabled, created_at, current_period_start,
      current_period_end, trial_start, trial_end, stripe_subscription_id,
      stripe_latest_invoice_id, stripe_payment_intent_id, stripe_subscription_item_id,
      stripe_price_id, stripe_product_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT (nanoid) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      type = EXCLUDED.type,
      status = EXCLUDED.status,
      is_disabled = EXCLUDED.is_disabled,
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      trial_start = EXCLUDED.trial_start,
      trial_end = EXCLUDED.trial_end,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      stripe_latest_invoice_id = EXCLUDED.stripe_latest_invoice_id,
      stripe_payment_intent_id = EXCLUDED.stripe_payment_intent_id,
      stripe_subscription_item_id = EXCLUDED.stripe_subscription_item_id,
      stripe_price_id = EXCLUDED.stripe_price_id,
      stripe_product_id = EXCLUDED.stripe_product_id`,
    [
      input.nanoid,
      input.userId,
      input.type,
      input.status,
      input.isDisabled,
      input.createdAt,
      input.currentPeriodStart,
      input.currentPeriodEnd,
      input.trialStart,
      input.trialEnd,
      input.stripeSubscriptionId,
      input.stripeLatestInvoiceId,
      input.stripePaymentIntentId,
      input.stripeSubscriptionItemId,
      input.stripePriceId,
      input.stripeProductId,
    ],
  )
}

export const disableSubscriptionByStripeId = async (
  db: DbClient,
  stripeSubscriptionId: string,
) => {
  await db.execute(
    `UPDATE subscriptions SET is_disabled = TRUE, status = 'canceled' WHERE stripe_subscription_id = $1`,
    [stripeSubscriptionId],
  )
}
