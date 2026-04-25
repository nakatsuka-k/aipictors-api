import { Hono } from 'hono'
import { boolean, literal, nullable, number, object, safeParse, string, union } from 'valibot'
import { requireInternalAuth } from '@/lib/auth'
import { json } from '@/lib/json'
import { getPricingSettings } from '@/lib/pricing'
import {
  disableSubscriptionByStripeId,
  getActiveOrRecentSubscription,
  getCurrentSubscription,
  getSubscriptionByNanoid,
  hasPreviousSubscription,
  upsertSubscription,
} from '@/lib/subscriptions'

const upsertSchema = object({
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
  stripeProductId: nullable(string()),
})

const disableSchema = object({
  stripeSubscriptionId: string(),
})

const cancelCurrentSchema = object({
  userId: string(),
})

const changePlanSchema = object({
  userId: string(),
  passType: union([literal('LITE'), literal('STANDARD'), literal('PREMIUM')]),
})

const stripeProductIdByPassType: Record<'LITE' | 'STANDARD' | 'PREMIUM', string> = {
  PREMIUM: 'prod_OneEB60sXmxvu1',
  LITE: 'prod_One9y8yOCumS2G',
  STANDARD: 'prod_OaCLGmzAoDVJjY',
}

const getString = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

const getNumber = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const postStripeForm = async (secretKey: string, path: string, params: URLSearchParams) => {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  })

  return response.json() as Promise<Record<string, unknown>>
}

const getStripe = async (secretKey: string, path: string) => {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${secretKey}`,
    },
  })

  return response.json() as Promise<Record<string, unknown>>
}

export const subscriptionRoutes = new Hono<{ Bindings: Env }>()

subscriptionRoutes.use('*', requireInternalAuth)

subscriptionRoutes.get('/current/:userId', async (c) => {
  const current = await getCurrentSubscription(c.env.AIPICTORS_DB, c.req.param('userId'))
  return json({ error: null, data: current })
})

subscriptionRoutes.get('/by-nanoid/:nanoid', async (c) => {
  const nanoid = c.req.param('nanoid')
  const data = await getSubscriptionByNanoid(c.env.AIPICTORS_DB, nanoid)
  return json({ error: null, data })
})

subscriptionRoutes.get('/has-previous/:userId', async (c) => {
  const exists = await hasPreviousSubscription(c.env.AIPICTORS_DB, c.req.param('userId'))
  return json({ error: null, data: { exists } })
})

subscriptionRoutes.post('/upsert', async (c) => {
  const parsed = safeParse(upsertSchema, await c.req.json())
  if (!parsed.success) {
    return json({ error: 'Invalid body' }, 400)
  }

  await upsertSubscription(c.env.AIPICTORS_DB, parsed.output)
  return json({ error: null, data: true })
})

subscriptionRoutes.post('/disable', async (c) => {
  const parsed = safeParse(disableSchema, await c.req.json())
  if (!parsed.success) {
    return json({ error: 'Invalid body' }, 400)
  }

  await disableSubscriptionByStripeId(c.env.AIPICTORS_DB, parsed.output.stripeSubscriptionId)
  return json({ error: null, data: true })
})

subscriptionRoutes.post('/cancel-current', async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: 'STRIPE_SECRET_KEY is not configured' }, 500)
  }

  const parsed = safeParse(cancelCurrentSchema, await c.req.json())
  if (!parsed.success) {
    return json({ error: 'Invalid body' }, 400)
  }

  const current =
    (await getCurrentSubscription(c.env.AIPICTORS_DB, parsed.output.userId)) ??
    (await getActiveOrRecentSubscription(c.env.AIPICTORS_DB, parsed.output.userId))

  if (!current) {
    return json({ error: 'No active subscription found' }, 404)
  }

  const stripeSubscriptionId = getString(current, 'stripe_subscription_id')
  if (!stripeSubscriptionId) {
    return json({ error: 'Stripe subscription id is missing' }, 409)
  }

  const form = new URLSearchParams()
  form.set('cancel_at_period_end', 'true')

  const stripeResponse = await postStripeForm(
    c.env.STRIPE_SECRET_KEY,
    `/subscriptions/${stripeSubscriptionId}`,
    form,
  )

  const stripeError = stripeResponse.error as { message?: string; code?: string } | undefined
  if (stripeError?.message) {
    // Stripe側でサブスクリプションが存在しない場合はD1をキャンセル済みに更新して正常終了
    if (stripeError.code === 'resource_missing' || stripeError.message.includes('No such subscription')) {
      await c.env.AIPICTORS_DB
        .prepare(`UPDATE subscriptions SET status = 'canceled', is_disabled = 1 WHERE stripe_subscription_id = ?`)
        .bind(stripeSubscriptionId)
        .run()
      return json({
        error: null,
        data: {
          status: 'canceled',
          stripeStatus: null,
          cancelAtPeriodEnd: false,
        },
      })
    }
    return json({ error: stripeError.message }, 502)
  }

  const isCancelAtPeriodEnd = stripeResponse.cancel_at_period_end === true
  if (!isCancelAtPeriodEnd) {
    return json({ error: 'Failed to schedule cancellation at period end' }, 502)
  }

  await c.env.AIPICTORS_DB
    .prepare(`UPDATE subscriptions SET status = 'cancellation_requested' WHERE stripe_subscription_id = ?`)
    .bind(stripeSubscriptionId)
    .run()

  return json({
    error: null,
    data: {
      status: 'cancellation_requested',
      stripeStatus: typeof stripeResponse.status === 'string' ? stripeResponse.status : null,
      cancelAtPeriodEnd: true,
    },
  })
})

subscriptionRoutes.post('/change-plan', async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: 'STRIPE_SECRET_KEY is not configured' }, 500)
  }

  const parsed = safeParse(changePlanSchema, await c.req.json())
  if (!parsed.success) {
    return json({ error: 'Invalid body' }, 400)
  }

  const current = await getCurrentSubscription(c.env.AIPICTORS_DB, parsed.output.userId)

  if (!current) {
    return json({ error: 'No active subscription found' }, 404)
  }

  const stripeSubscriptionId = getString(current, 'stripe_subscription_id')
  if (!stripeSubscriptionId) {
    return json({ error: 'Stripe subscription id is missing' }, 409)
  }

  const pricing = await getPricingSettings(c.env.AIPICTORS_DB)
  const nextAmount = pricing.subscriptionPlans[parsed.output.passType]

  const currentType = getString(current, 'type')
  if (currentType === parsed.output.passType) {
    return json({
      error: null,
      data: {
        passType: parsed.output.passType,
        amountJpy: nextAmount,
        status: getString(current, 'status') ?? 'active',
      },
    })
  }

  const stripeSubscription = await getStripe(
    c.env.STRIPE_SECRET_KEY,
    `/subscriptions/${stripeSubscriptionId}`,
  )

  const stripeFetchError = stripeSubscription.error as { message?: string } | undefined
  if (stripeFetchError?.message) {
    return json({ error: stripeFetchError.message }, 502)
  }

  const items = stripeSubscription.items as { data?: Array<Record<string, unknown>> } | undefined
  const [firstItem] = items?.data ?? []
  const stripeSubscriptionItemId = firstItem ? getString(firstItem, 'id') : null

  if (!stripeSubscriptionItemId) {
    return json({ error: 'Stripe subscription item is missing' }, 409)
  }

  const form = new URLSearchParams()
  form.set('proration_behavior', 'none')
  form.set('cancel_at_period_end', 'false')
  form.set('items[0][id]', stripeSubscriptionItemId)
  form.set('items[0][price_data][currency]', 'jpy')
  form.set('items[0][price_data][unit_amount]', String(nextAmount))
  form.set('items[0][price_data][recurring][interval]', 'month')
  form.set('items[0][price_data][product]', stripeProductIdByPassType[parsed.output.passType])

  const stripeUpdate = await postStripeForm(
    c.env.STRIPE_SECRET_KEY,
    `/subscriptions/${stripeSubscriptionId}`,
    form,
  )

  const stripeUpdateError = stripeUpdate.error as { message?: string } | undefined
  if (stripeUpdateError?.message) {
    return json({ error: stripeUpdateError.message }, 502)
  }

  const updatedItems = stripeUpdate.items as { data?: Array<Record<string, unknown>> } | undefined
  const [updatedFirstItem] = updatedItems?.data ?? []
  const updatedPrice = (updatedFirstItem?.price ?? null) as Record<string, unknown> | null

  const updatedStatus =
    typeof stripeUpdate.status === 'string' ? stripeUpdate.status : 'active'

  const updatedPeriodStart =
    getNumber(stripeUpdate, 'current_period_start') ??
    getNumber(current, 'current_period_start') ??
    Math.floor(Date.now() / 1000)

  const updatedPeriodEnd =
    getNumber(stripeUpdate, 'current_period_end') ??
    getNumber(current, 'current_period_end') ??
    Math.floor(Date.now() / 1000)

  await c.env.AIPICTORS_DB
    .prepare(`UPDATE subscriptions
      SET type = ?,
          status = ?,
          is_disabled = 0,
          current_period_start = ?,
          current_period_end = ?,
          stripe_subscription_item_id = ?,
          stripe_price_id = ?,
          stripe_product_id = ?
      WHERE stripe_subscription_id = ?`)
    .bind(
      parsed.output.passType,
      updatedStatus,
      updatedPeriodStart,
      updatedPeriodEnd,
      getString(updatedFirstItem ?? {}, 'id') ?? stripeSubscriptionItemId,
      getString(updatedPrice ?? {}, 'id'),
      getString(updatedPrice ?? {}, 'product'),
      stripeSubscriptionId,
    )
    .run()

  return json({
    error: null,
    data: {
      passType: parsed.output.passType,
      amountJpy: nextAmount,
      status: updatedStatus,
    },
  })
})
