import { Hono } from 'hono'
import { object, safeParse, string, union, literal } from 'valibot'
import { getDb } from '@/lib/db'
import { requireInternalAuth } from '@/lib/auth'
import { json } from '@/lib/json'
import { createPointCheckout, createSubscriptionCheckout } from '@/lib/stripe'

const pointCheckoutSchema = object({
  userId: string(),
  points: union([literal(100), literal(300), literal(1000)]),
  origin: string(),
})

const subscriptionCheckoutSchema = object({
  userId: string(),
  passType: union([literal('LITE'), literal('STANDARD'), literal('PREMIUM')]),
  origin: string(),
})

export const stripeRoutes = new Hono<{ Bindings: Env }>()

stripeRoutes.use('/checkout/*', requireInternalAuth)

stripeRoutes.post('/checkout/points', async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: 'STRIPE_SECRET_KEY is not configured' }, 500)
  }

  const parsed = safeParse(pointCheckoutSchema, await c.req.json())
  if (!parsed.success) {
    return json({ error: 'Invalid body' }, 400)
  }

  const db = await getDb(c.env)
  const response = await createPointCheckout({
    secretKey: c.env.STRIPE_SECRET_KEY,
    origin: parsed.output.origin,
    userId: parsed.output.userId,
    points: parsed.output.points,
    db,
  }) as { url?: string; error?: { message?: string } }

  if (!response.url) {
    return json({ error: response.error?.message ?? 'Failed to create checkout session' }, 502)
  }

  return json({ error: null, data: { url: response.url } })
})

stripeRoutes.post('/checkout/subscription', async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return json({ error: 'STRIPE_SECRET_KEY is not configured' }, 500)
  }

  const parsed = safeParse(subscriptionCheckoutSchema, await c.req.json())
  if (!parsed.success) {
    console.error('Invalid checkout request:', parsed.issues)
    return json({ error: 'Invalid body' }, 400)
  }

  try {
    const db = await getDb(c.env)
    const response = await createSubscriptionCheckout({
      secretKey: c.env.STRIPE_SECRET_KEY,
      origin: parsed.output.origin,
      userId: parsed.output.userId,
      passType: parsed.output.passType,
      db,
    }) as { url?: string; error?: { message?: string } }

    if (!response.url) {
      const errorMsg = response.error?.message ?? 'Failed to create checkout session'
      console.error('Checkout session creation failed:', { 
        userId: parsed.output.userId, 
        passType: parsed.output.passType, 
        error: errorMsg 
      })
      return json({ error: errorMsg }, 502)
    }

    console.log('Checkout session created successfully:', { 
      userId: parsed.output.userId, 
      passType: parsed.output.passType, 
      url: response.url?.substring(0, 50) + '...' 
    })
    return json({ error: null, data: { url: response.url } })
  } catch (error) {
    console.error('Checkout error:', error)
    return json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500)
  }
})
