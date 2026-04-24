import { Hono } from 'hono'
import { object, safeParse, string, number } from 'valibot'
import { requireInternalAuth } from '@/lib/auth'
import { json } from '@/lib/json'
import { applyPointDelta, getPointSummary } from '@/lib/points'

const transactionSchema = object({
  userId: string(),
  points: number(),
  reason: string(),
})

export const pointsRoutes = new Hono<{ Bindings: Env }>()

pointsRoutes.use('*', requireInternalAuth)

pointsRoutes.get('/:userId', async (c) => {
  const summary = await getPointSummary(c.env.AIPICTORS_DB, c.req.param('userId'))
  return json({ error: null, data: summary })
})

pointsRoutes.post('/grant', async (c) => {
  const parsed = safeParse(transactionSchema, await c.req.json())
  if (!parsed.success) {
    return json({ error: 'Invalid body' }, 400)
  }

  await applyPointDelta({
    db: c.env.AIPICTORS_DB,
    userId: parsed.output.userId,
    delta: Math.floor(parsed.output.points),
    kind: 'GRANT',
    reason: parsed.output.reason,
  })

  return json({ error: null, data: await getPointSummary(c.env.AIPICTORS_DB, parsed.output.userId) })
})

pointsRoutes.post('/consume', async (c) => {
  const parsed = safeParse(transactionSchema, await c.req.json())
  if (!parsed.success) {
    return json({ error: 'Invalid body' }, 400)
  }

  const result = await applyPointDelta({
    db: c.env.AIPICTORS_DB,
    userId: parsed.output.userId,
    delta: -Math.floor(parsed.output.points),
    kind: 'CONSUME',
    reason: parsed.output.reason,
  })

  if (!result.ok) {
    return json({ error: 'Insufficient points' }, 409)
  }

  return json({ error: null, data: await getPointSummary(c.env.AIPICTORS_DB, parsed.output.userId) })
})
