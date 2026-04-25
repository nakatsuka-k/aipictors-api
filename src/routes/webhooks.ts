import { Hono } from 'hono'
import { json } from '@/lib/json'
import { applyPointDelta } from '@/lib/points'
import { upsertSubscription, disableSubscriptionByStripeId } from '@/lib/subscriptions'
import { verifyStripeSignature } from '@/lib/stripe'

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
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

const getMetadataFromInvoice = (invoice: Record<string, unknown>) => {
  const direct = invoice.subscription_details as { metadata?: Record<string, unknown> } | undefined
  if (direct?.metadata) {
    return direct.metadata
  }

  const parent = invoice.parent as Record<string, unknown> | undefined
  const parentSubscription =
    parent?.subscription_details as { metadata?: Record<string, unknown> } | undefined
  if (parentSubscription?.metadata) {
    return parentSubscription.metadata
  }

  const paymentIntent = invoice.payment_intent as { metadata?: Record<string, unknown> } | undefined
  if (paymentIntent?.metadata) {
    return paymentIntent.metadata
  }

  return (invoice.metadata as Record<string, unknown>) ?? {}
}

const fetchStripeSubscription = async (
  secretKey: string,
  subscriptionId: string,
) => {
  const response = await fetch(
    `https://api.stripe.com/v1/subscriptions/${subscriptionId}?expand[]=items.data.price`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secretKey}`,
      },
    },
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Stripe subscription fetch failed (${response.status}): ${text}`)
  }

  return response.json() as Promise<Record<string, unknown>>
}

export const webhookRoutes = new Hono<{ Bindings: Env }>()

webhookRoutes.post('/stripe', async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: 'STRIPE_WEBHOOK_SECRET is not configured' }, 500)
  }

  const signature = c.req.header('stripe-signature')
  if (!signature) {
    return json({ error: 'Missing stripe-signature' }, 400)
  }

  const payload = await c.req.text()
  const verified = await verifyStripeSignature({
    payload,
    signatureHeader: signature,
    secret: c.env.STRIPE_WEBHOOK_SECRET,
  })

  if (!verified) {
    return json({ error: 'Invalid signature' }, 401)
  }

  const event = JSON.parse(payload) as {
    id: string
    type: string
    data: { object: Record<string, unknown> }
  }

  const existing = await c.env.AIPICTORS_DB
    .prepare('SELECT event_id FROM webhook_events WHERE event_id = ?')
    .bind(event.id)
    .first<{ event_id: string }>()

  if (existing) {
    return json({ error: null, data: { deduplicated: true } })
  }

  const object = event.data.object

  if (event.type === 'checkout.session.completed') {
    const metadata = (object.metadata as Record<string, unknown> | undefined) ?? {}
    const kind = getString(metadata, 'kind')

    if (kind === 'points') {
      const userId = getString(metadata, 'user_id')
      const points = Number.parseInt(getString(metadata, 'points') ?? '', 10)
      if (userId && Number.isFinite(points)) {
        await applyPointDelta({
          db: c.env.AIPICTORS_DB,
          userId,
          delta: points,
          kind: 'PURCHASE',
          reason: 'Stripe checkout completed',
          stripeEventId: event.id,
          stripeSessionId: getString(object, 'id'),
        })
      }
    }
  }

  if (event.type === 'invoice.payment_succeeded') {
    let metadata = getMetadataFromInvoice(object)
    const subscriptionId = getString(object, 'subscription')

    let userId = getString(metadata, 'user_id')
    let nanoid = getString(metadata, 'subscription_nanoid')
    let passType = getString(metadata, 'pass_type')

    let subscriptionCurrentPeriodStart: number | null = null
    let subscriptionCurrentPeriodEnd: number | null = null
    let stripePriceId: string | null = null
    let stripeProductId: string | null = null
    let stripeSubscriptionItemId: string | null = null

    if ((!userId || !nanoid || !passType) && subscriptionId && c.env.STRIPE_SECRET_KEY) {
      try {
        const stripeSubscription = await fetchStripeSubscription(
          c.env.STRIPE_SECRET_KEY,
          subscriptionId,
        )
        const stripeMetadata =
          (stripeSubscription.metadata as Record<string, unknown> | undefined) ?? {}

        metadata = { ...stripeMetadata, ...metadata }
        userId = userId ?? getString(stripeMetadata, 'user_id')
        nanoid = nanoid ?? getString(stripeMetadata, 'subscription_nanoid')
        passType = passType ?? getString(stripeMetadata, 'pass_type')

        subscriptionCurrentPeriodStart = getNumber(stripeSubscription, 'current_period_start')
        subscriptionCurrentPeriodEnd = getNumber(stripeSubscription, 'current_period_end')

        const items = stripeSubscription.items as { data?: Record<string, unknown>[] } | undefined
        const firstItem = Array.isArray(items?.data) ? items.data[0] : undefined
        stripeSubscriptionItemId = getString(firstItem ?? {}, 'id')

        const price = (firstItem?.price as Record<string, unknown> | undefined) ?? {}
        stripePriceId = getString(price, 'id')
        stripeProductId = getString(price, 'product')
      } catch (error) {
        console.warn('Failed to fetch Stripe subscription for metadata fallback', {
          eventId: event.id,
          subscriptionId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const createdAt = getNumber(object, 'created') ?? Math.floor(Date.now() / 1000)
    const lines = object.lines as { data?: Record<string, unknown>[] } | undefined
    const firstLine = Array.isArray(lines?.data) ? lines.data[0] : undefined
    const period = (firstLine?.period as Record<string, unknown> | undefined) ?? {}
    const periodStart =
      getNumber(period, 'start') ?? getNumber(object, 'period_start') ?? createdAt
    const periodEnd =
      getNumber(period, 'end') ??
      getNumber(object, 'period_end') ??
      createdAt + 30 * 24 * 60 * 60

    const debugInfo = {
      eventId: event.id,
      metadata,
      userId,
      nanoid,
      passType,
      subscriptionId,
      invoiceId: getString(object, 'id'),
      source: (!getString(getMetadataFromInvoice(object), 'user_id') || !getString(getMetadataFromInvoice(object), 'subscription_nanoid') || !getString(getMetadataFromInvoice(object), 'pass_type')) && subscriptionId ? 'stripe.subscription_fallback' : 'invoice_metadata',
      period_start: periodStart,
      period_end: periodEnd,
    }

    console.log('invoice.payment_succeeded webhook:', debugInfo)

    // Save debug info as best-effort so subscription upsert never stops.
    try {
      await c.env.AIPICTORS_DB
        .prepare(
          `INSERT OR REPLACE INTO webhook_debug(event_id, event_type, debug_info, created_at)
           VALUES (?, ?, ?, unixepoch())`
        )
        .bind(event.id, event.type, JSON.stringify(debugInfo))
        .run()
    } catch (error) {
      console.warn('Failed to persist webhook_debug record', {
        eventId: event.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }

    if (userId && nanoid && passType) {
      console.log('Upserting subscription for user:', userId)
      await upsertSubscription(c.env.AIPICTORS_DB, {
        nanoid,
        userId,
        type: passType,
        status: getString(object, 'status') ?? 'active',
        isDisabled: false,
        createdAt,
        currentPeriodStart: subscriptionCurrentPeriodStart ?? periodStart,
        currentPeriodEnd: subscriptionCurrentPeriodEnd ?? periodEnd,
        trialStart: null,
        trialEnd: null,
        stripeSubscriptionId: subscriptionId ?? '',
        stripeLatestInvoiceId: getString(object, 'id'),
        stripePaymentIntentId: getString(object, 'payment_intent'),
        stripeSubscriptionItemId,
        stripePriceId,
        stripeProductId,
      })
    } else {
      console.warn('Missing required metadata for subscription upsert:', {
        userId: !!userId,
        nanoid: !!nanoid,
        passType: !!passType,
      })
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscriptionId = getString(object, 'id')
    if (subscriptionId) {
      await disableSubscriptionByStripeId(c.env.AIPICTORS_DB, subscriptionId)
    }
  }

  await c.env.AIPICTORS_DB
    .prepare('INSERT INTO webhook_events(event_id, type, processed_at) VALUES (?, ?, unixepoch())')
    .bind(event.id, event.type)
    .run()

  return json({ error: null, data: true })
})
