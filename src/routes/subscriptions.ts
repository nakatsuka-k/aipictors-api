import { Hono } from 'hono'
import { boolean, nullable, number, object, safeParse, string } from 'valibot'
import { requireInternalAuth } from '@/lib/auth'
import { json } from '@/lib/json'
import {
  disableSubscriptionByStripeId,
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
