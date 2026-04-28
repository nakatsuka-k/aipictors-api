import { getPricingSettings } from '@/lib/pricing'
import type { DbClient } from '@/lib/db'

const encoder = new TextEncoder()

const toHex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const signPayload = async (secret: string, payload: string) => {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return toHex(new Uint8Array(signature))
}

const constantTimeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export const verifyStripeSignature = async (props: {
  payload: string
  signatureHeader: string
  secret: string
  toleranceSeconds?: number
}) => {
  const parts = props.signatureHeader.split(',').map((value) => value.trim())
  const timestamp = parts.find((value) => value.startsWith('t='))?.slice(2)
  const signatures = parts
    .filter((value) => value.startsWith('v1='))
    .map((value) => value.slice(3))

  if (!timestamp || signatures.length === 0) {
    return false
  }

  const tolerance = props.toleranceSeconds ?? 300
  const timestampInt = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(timestampInt)) {
    return false
  }

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestampInt) > tolerance) {
    return false
  }

  const expected = await signPayload(props.secret, `${timestamp}.${props.payload}`)
  return signatures.some((value) => constantTimeEqual(value, expected))
}

const postStripeForm = async (secretKey: string, params: URLSearchParams) => {
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params,
  })

  return response.json()
}

export const createPointCheckout = async (props: {
  secretKey: string
  origin: string
  userId: string
  points: 100 | 300 | 1000
  db: DbClient
}) => {
  const pricing = await getPricingSettings(props.db)
  const amount = pricing.pointPackages[String(props.points) as '100' | '300' | '1000']

  const params = new URLSearchParams()
  params.set('mode', 'payment')
  params.set('success_url', `${props.origin}/settings/points?checkout=success`)
  params.set('cancel_url', `${props.origin}/settings/points?checkout=cancel`)
  params.set('client_reference_id', props.userId)
  params.set('line_items[0][quantity]', '1')
  params.set('line_items[0][price_data][currency]', 'jpy')
  params.set('line_items[0][price_data][unit_amount]', String(amount))
  params.set('line_items[0][price_data][product_data][name]', `Aipictors ${props.points} points`)
  params.set('metadata[kind]', 'points')
  params.set('metadata[user_id]', props.userId)
  params.set('metadata[points]', String(props.points))
  params.set('metadata[amount_jpy]', String(amount))
  params.set('payment_intent_data[metadata][kind]', 'points')
  params.set('payment_intent_data[metadata][user_id]', props.userId)
  params.set('payment_intent_data[metadata][points]', String(props.points))

  return postStripeForm(props.secretKey, params)
}

export const createSubscriptionCheckout = async (props: {
  secretKey: string
  origin: string
  userId: string
  passType: 'LITE' | 'STANDARD' | 'PREMIUM'
  db: DbClient
}) => {
  const pricing = await getPricingSettings(props.db)
  const amount = pricing.subscriptionPlans[props.passType]
  const nanoid = crypto.randomUUID()

  const params = new URLSearchParams()
  params.set('mode', 'subscription')
  params.set('success_url', `${props.origin}/plus/success`)
  params.set('cancel_url', `${props.origin}/plus/cancel`)
  params.set('client_reference_id', props.userId)
  params.set('line_items[0][quantity]', '1')
  params.set('line_items[0][price_data][currency]', 'jpy')
  params.set('line_items[0][price_data][unit_amount]', String(amount))
  params.set('line_items[0][price_data][recurring][interval]', 'month')
  params.set('line_items[0][price_data][product_data][name]', `Aipictors ${props.passType}`)
  params.set('metadata[kind]', 'subscription')
  params.set('metadata[user_id]', props.userId)
  params.set('metadata[pass_type]', props.passType)
  params.set('metadata[subscription_nanoid]', nanoid)
  params.set('subscription_data[metadata][kind]', 'subscription')
  params.set('subscription_data[metadata][user_id]', props.userId)
  params.set('subscription_data[metadata][pass_type]', props.passType)
  params.set('subscription_data[metadata][subscription_nanoid]', nanoid)

  return postStripeForm(props.secretKey, params)
}
