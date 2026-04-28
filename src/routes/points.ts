import { Hono } from 'hono'
import { object, safeParse, string, number } from 'valibot'
import { getDb } from '@/lib/db'
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
  const db = await getDb(c.env)
  const summary = await getPointSummary(db, c.req.param('userId'))
  return json({ error: null, data: summary })
})

pointsRoutes.post('/grant', async (c) => {
  const parsed = safeParse(transactionSchema, await c.req.json())
  if (!parsed.success) {
    return json({ error: 'Invalid body' }, 400)
  }

  const db = await getDb(c.env)
  await applyPointDelta({
    db,
    userId: parsed.output.userId,
    delta: Math.floor(parsed.output.points),
    kind: 'GRANT',
    reason: parsed.output.reason,
  })

  return json({ error: null, data: await getPointSummary(db, parsed.output.userId) })
})

pointsRoutes.post('/consume', async (c) => {
  const parsed = safeParse(transactionSchema, await c.req.json())
  if (!parsed.success) {
    return json({ error: 'Invalid body' }, 400)
  }

  const db = await getDb(c.env)
  const result = await applyPointDelta({
    db,
    userId: parsed.output.userId,
    delta: -Math.floor(parsed.output.points),
    kind: 'CONSUME',
    reason: parsed.output.reason,
  })

  if (!result.ok) {
    return json({ error: 'Insufficient points' }, 409)
  }

  return json({ error: null, data: await getPointSummary(db, parsed.output.userId) })
})
