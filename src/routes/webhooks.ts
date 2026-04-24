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
    // Try subscription_details.metadata first, then payment_intent.metadata, then invoice.metadata
    let metadata: Record<string, unknown> = {}
    
    const subscription = object.subscription_details as { metadata?: Record<string, unknown> } | undefined
    if (subscription?.metadata) {
      metadata = subscription.metadata
    } else {
      const paymentIntent = object.payment_intent as { metadata?: Record<string, unknown> } | undefined
      if (paymentIntent?.metadata) {
        metadata = paymentIntent.metadata
      } else {
        metadata = (object.metadata as Record<string, unknown>) ?? {}
      }
    }
    
    const userId = getString(metadata, 'user_id')
    const nanoid = getString(metadata, 'subscription_nanoid')
    const passType = getString(metadata, 'pass_type')

    if (userId && nanoid && passType) {
      await upsertSubscription(c.env.AIPICTORS_DB, {
        nanoid,
        userId,
        type: passType,
        status: getString(object, 'status') ?? 'active',
        isDisabled: false,
        createdAt: getNumber(object, 'created') ?? Math.floor(Date.now() / 1000),
        currentPeriodStart: getNumber(object, 'period_start') ?? Math.floor(Date.now() / 1000),
        currentPeriodEnd: getNumber(object, 'period_end') ?? Math.floor(Date.now() / 1000),
        trialStart: null,
        trialEnd: null,
        stripeSubscriptionId: getString(object, 'subscription') ?? '',
        stripeLatestInvoiceId: getString(object, 'id'),
        stripePaymentIntentId: getString(object, 'payment_intent'),
        stripeSubscriptionItemId: null,
        stripePriceId: null,
        stripeProductId: null,
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
