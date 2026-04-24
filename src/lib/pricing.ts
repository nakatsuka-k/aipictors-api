export type PricingSettings = {
  yenPerPoint: number
  pointPackages: Record<'100' | '300' | '1000', number>
  subscriptionPlans: Record<'LITE' | 'STANDARD' | 'PREMIUM', number>
}

const parseNumber = (value: string | null | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const getPricingSettings = async (db: D1Database): Promise<PricingSettings> => {
  const rows = await db
    .prepare('SELECT key, value FROM pricing_settings')
    .all<{ key: string; value: string }>()

  const map = new Map((rows.results ?? []).map((row) => [row.key, row.value]))

  return {
    yenPerPoint: parseNumber(map.get('points.yen_per_point'), 1),
    pointPackages: {
      '100': parseNumber(map.get('points.package.100.amount_jpy'), 100),
      '300': parseNumber(map.get('points.package.300.amount_jpy'), 300),
      '1000': parseNumber(map.get('points.package.1000.amount_jpy'), 1000)
    },
    subscriptionPlans: {
      LITE: parseNumber(map.get('subscription.plan.LITE.amount_jpy'), 480),
      STANDARD: parseNumber(map.get('subscription.plan.STANDARD.amount_jpy'), 1980),
      PREMIUM: parseNumber(map.get('subscription.plan.PREMIUM.amount_jpy'), 3980)
    }
  }
}

export const upsertPricingSettings = async (
  db: D1Database,
  input: PricingSettings,
) => {
  const now = Math.floor(Date.now() / 1000)
  const entries: Array<[string, string]> = [
    ['points.yen_per_point', String(input.yenPerPoint)],
    ['points.package.100.amount_jpy', String(input.pointPackages['100'])],
    ['points.package.300.amount_jpy', String(input.pointPackages['300'])],
    ['points.package.1000.amount_jpy', String(input.pointPackages['1000'])],
    ['subscription.plan.LITE.amount_jpy', String(input.subscriptionPlans.LITE)],
    ['subscription.plan.STANDARD.amount_jpy', String(input.subscriptionPlans.STANDARD)],
    ['subscription.plan.PREMIUM.amount_jpy', String(input.subscriptionPlans.PREMIUM)]
  ]

  for (const [key, value] of entries) {
    await db
      .prepare(`INSERT INTO pricing_settings(key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(key, value, now)
      .run()
  }
}
