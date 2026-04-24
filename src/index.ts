import { Hono } from 'hono'
import { json } from '@/lib/json'
import { adminRoutes } from '@/routes/admin'
import { pointsRoutes } from '@/routes/points'
import { stripeRoutes } from '@/routes/stripe'
import { subscriptionRoutes } from '@/routes/subscriptions'
import { webhookRoutes } from '@/routes/webhooks'

const app = new Hono<{ Bindings: Env }>()

app.get('/healthz', (c) => {
  return json({ ok: true, service: 'aipictors-api' })
})

app.route('/internal/points', pointsRoutes)
app.route('/internal/subscriptions', subscriptionRoutes)
app.route('/admin', adminRoutes)
app.route('/stripe', stripeRoutes)
app.route('/webhooks', webhookRoutes)

app.notFound(() => json({ error: 'Not found' }, 404))
app.onError((error) => json({ error: error.message }, 500))

export default app
