// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
export var parseNumber = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};
export var getPricingSettings = async (db) => {
  const rows = await db.query("SELECT key, value FROM pricing_settings");
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return {
    yenPerPoint: parseNumber(map.get("points.yen_per_point"), 1),
    pointPackages: {
      "100": parseNumber(map.get("points.package.100.amount_jpy"), 100),
      "300": parseNumber(map.get("points.package.300.amount_jpy"), 300),
      "1000": parseNumber(map.get("points.package.1000.amount_jpy"), 1e3)
    },
    subscriptionPlans: {
      LITE: parseNumber(map.get("subscription.plan.LITE.amount_jpy"), 480),
      STANDARD: parseNumber(map.get("subscription.plan.STANDARD.amount_jpy"), 1980),
      PREMIUM: parseNumber(map.get("subscription.plan.PREMIUM.amount_jpy"), 3980)
    }
  };
};
export var upsertPricingSettings = async (db, input) => {
  const now = Math.floor(Date.now() / 1e3);
  const entries = [
    ["points.yen_per_point", String(input.yenPerPoint)],
    ["points.package.100.amount_jpy", String(input.pointPackages["100"])],
    ["points.package.300.amount_jpy", String(input.pointPackages["300"])],
    ["points.package.1000.amount_jpy", String(input.pointPackages["1000"])],
    ["subscription.plan.LITE.amount_jpy", String(input.subscriptionPlans.LITE)],
    ["subscription.plan.STANDARD.amount_jpy", String(input.subscriptionPlans.STANDARD)],
    ["subscription.plan.PREMIUM.amount_jpy", String(input.subscriptionPlans.PREMIUM)]
  ];
  for (const [key, value] of entries) {
    await db.execute(
      `INSERT INTO pricing_settings(key, value, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, value, now]
    );
  }
};
