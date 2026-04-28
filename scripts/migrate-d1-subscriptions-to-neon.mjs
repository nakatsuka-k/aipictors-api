import { readFile } from 'node:fs/promises'
import { neon } from '@neondatabase/serverless'

const neonUrl = process.env.NEON_DATABASE_URL
if (!neonUrl) {
  throw new Error('NEON_DATABASE_URL is required')
}

const sql = neon(neonUrl)
const now = Math.floor(Date.now() / 1000)

const parseD1Results = async (filePath) => {
  const raw = JSON.parse(await readFile(filePath, 'utf8'))
  return raw.flatMap((entry) => entry?.results ?? [])
}

const normalizeBool = (value) => {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'TRUE'
}

const toIntOr = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const applySchema = async () => {
  const schemaSql = await readFile('./sql/schema.sql', 'utf8')
  const statements = schemaSql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const statement of statements) {
    await sql.query(statement)
  }
}

const upsertSubscriptions = async (subscriptions) => {
  const batchSize = 200
  let migrated = 0

  for (let i = 0; i < subscriptions.length; i += batchSize) {
    const chunk = subscriptions
      .slice(i, i + batchSize)
      .filter((row) => row.nanoid && row.stripe_subscription_id)

    if (chunk.length === 0) {
      continue
    }

    const params = []
    const tuples = chunk.map((row, index) => {
      const base = index * 16
      const isDisabled = normalizeBool(row.is_disabled)
      const createdAt = toIntOr(row.created_at, now)
      const currentPeriodStart = toIntOr(row.current_period_start, createdAt)
      const currentPeriodEnd = toIntOr(row.current_period_end, createdAt)

      params.push(
        String(row.nanoid),
        String(row.user_id ?? ''),
        String(row.type ?? ''),
        isDisabled ? 'canceled' : 'active',
        isDisabled,
        createdAt,
        currentPeriodStart,
        currentPeriodEnd,
        row.trial_start == null || row.trial_start === '' ? null : toIntOr(row.trial_start, createdAt),
        row.trial_end == null || row.trial_end === '' ? null : toIntOr(row.trial_end, createdAt),
        String(row.stripe_subscription_id),
        row.stripe_latest_invoice_id ?? null,
        row.stripe_payment_intent_id ?? null,
        row.stripe_subscription_item_id ?? null,
        row.stripe_price_id ?? null,
        row.stripe_product_id ?? null,
      )

      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16})`
    })

    const query = `
      INSERT INTO subscriptions (
        nanoid, user_id, type, status, is_disabled, created_at, current_period_start,
        current_period_end, trial_start, trial_end, stripe_subscription_id,
        stripe_latest_invoice_id, stripe_payment_intent_id, stripe_subscription_item_id,
        stripe_price_id, stripe_product_id
      ) VALUES ${tuples.join(', ')}
      ON CONFLICT (nanoid) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        type = EXCLUDED.type,
        status = EXCLUDED.status,
        is_disabled = EXCLUDED.is_disabled,
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        trial_start = EXCLUDED.trial_start,
        trial_end = EXCLUDED.trial_end,
        stripe_subscription_id = EXCLUDED.stripe_subscription_id,
        stripe_latest_invoice_id = EXCLUDED.stripe_latest_invoice_id,
        stripe_payment_intent_id = EXCLUDED.stripe_payment_intent_id,
        stripe_subscription_item_id = EXCLUDED.stripe_subscription_item_id,
        stripe_price_id = EXCLUDED.stripe_price_id,
        stripe_product_id = EXCLUDED.stripe_product_id
    `

    await sql.query(query, params)
    migrated += chunk.length
  }

  return migrated
}

const upsertPricing = async (settings) => {
  if (settings.length === 0) {
    return 0
  }

  const params = []
  const tuples = settings.map((row, index) => {
    const base = index * 3
    params.push(String(row.key), String(row.value ?? ''), toIntOr(row.updated_at, now))
    return `($${base + 1}, $${base + 2}, $${base + 3})`
  })

  const query = `
    INSERT INTO pricing_settings (key, value, updated_at)
    VALUES ${tuples.join(', ')}
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = EXCLUDED.updated_at
  `

  await sql.query(query, params)
  return settings.length
}

const main = async () => {
  const d1Subscriptions = await parseD1Results('/tmp/d1-subscriptions.json')
  const d1PricingSettings = await parseD1Results('/tmp/d1-pricing-settings.json')

  await applySchema()

  const migratedSubscriptions = await upsertSubscriptions(d1Subscriptions)
  const migratedPricingSettings = await upsertPricing(d1PricingSettings)

  const [neonSubscriptions] = await sql.query('SELECT COUNT(*)::int AS c FROM subscriptions')
  const [neonPricingSettings] = await sql.query('SELECT COUNT(*)::int AS c FROM pricing_settings')

  console.log(
    JSON.stringify(
      {
        d1Subscriptions: d1Subscriptions.length,
        migratedSubscriptions,
        neonSubscriptions: neonSubscriptions.c,
        d1PricingSettings: d1PricingSettings.length,
        migratedPricingSettings,
        neonPricingSettings: neonPricingSettings.c,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
