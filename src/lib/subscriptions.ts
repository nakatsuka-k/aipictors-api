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

export const getCurrentSubscription = async (db: D1Database, userId: string) => {
  return db
    .prepare(`SELECT * FROM subscriptions
      WHERE user_id = ? AND is_disabled = 0 AND current_period_end > unixepoch()
      ORDER BY current_period_end DESC LIMIT 1`)
    .bind(userId)
    .first<Record<string, unknown>>()
}

export const hasPreviousSubscription = async (db: D1Database, userId: string) => {
  const row = await db
    .prepare('SELECT id FROM subscriptions WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first<{ id: number }>()

  return row !== null
}

export const upsertSubscription = async (db: D1Database, input: SubscriptionUpsertInput) => {
  await db
    .prepare(`INSERT INTO subscriptions(
      nanoid, user_id, type, status, is_disabled, created_at, current_period_start,
      current_period_end, trial_start, trial_end, stripe_subscription_id,
      stripe_latest_invoice_id, stripe_payment_intent_id, stripe_subscription_item_id,
      stripe_price_id, stripe_product_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(nanoid) DO UPDATE SET
      user_id = excluded.user_id,
      type = excluded.type,
      status = excluded.status,
      is_disabled = excluded.is_disabled,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      trial_start = excluded.trial_start,
      trial_end = excluded.trial_end,
      stripe_subscription_id = excluded.stripe_subscription_id,
      stripe_latest_invoice_id = excluded.stripe_latest_invoice_id,
      stripe_payment_intent_id = excluded.stripe_payment_intent_id,
      stripe_subscription_item_id = excluded.stripe_subscription_item_id,
      stripe_price_id = excluded.stripe_price_id,
      stripe_product_id = excluded.stripe_product_id`)
    .bind(
      input.nanoid,
      input.userId,
      input.type,
      input.status,
      input.isDisabled ? 1 : 0,
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
    )
    .run()
}

export const disableSubscriptionByStripeId = async (
  db: D1Database,
  stripeSubscriptionId: string,
) => {
  await db
    .prepare(`UPDATE subscriptions SET is_disabled = 1, status = 'canceled' WHERE stripe_subscription_id = ?`)
    .bind(stripeSubscriptionId)
    .run()
}
