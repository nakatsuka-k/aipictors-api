import { Hono } from 'hono'
import { number, object, safeParse } from 'valibot'
import { getDb } from '@/lib/db'
import { requireAdminAuth } from '@/lib/auth'
import { json } from '@/lib/json'
import { getPricingSettings, upsertPricingSettings } from '@/lib/pricing'

const pricingSchema = object({
  yenPerPoint: number(),
  pointPackages: object({
    '100': number(),
    '300': number(),
    '1000': number(),
  }),
  subscriptionPlans: object({
    LITE: number(),
    STANDARD: number(),
    PREMIUM: number(),
  }),
})

export const adminRoutes = new Hono<{ Bindings: Env }>()

adminRoutes.use('*', requireAdminAuth)

adminRoutes.get('/pricing', async (c) => {
  const db = await getDb(c.env)
  return json({ error: null, data: await getPricingSettings(db) })
})

adminRoutes.put('/pricing', async (c) => {
  const parsed = safeParse(pricingSchema, await c.req.json())
  if (!parsed.success) {
    return json({ error: 'Invalid body' }, 400)
  }

  const db = await getDb(c.env)
  await upsertPricingSettings(db, parsed.output)
  return json({ error: null, data: await getPricingSettings(db) })
})
