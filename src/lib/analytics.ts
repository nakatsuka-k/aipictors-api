// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { getGenlogDb } from "./db"
import { collectCosts } from "./costs"

/**
 * 分析ページ用の日別の数字（日本時間の 1 日ごとに 1 行）
 * 生成数や Cloudflare の数字は後から重い集計や取り直しができないので、毎日 00:30 JST に前日分を保存する
 */

var ZONE_ID = "e24f556403c24f96875f6466349b048f";
var JST_OFFSET_SECONDS = 9 * 3600;
var PLAN_TYPES = ["LITE", "STANDARD", "PREMIUM"];

// 表は migrations/gen で作る（D1）
export var ensureAnalyticsTables = async (_db) => {};

/** "2026-11-05" → その日の 00:00 JST と翌日 00:00 JST（UNIX 秒） */
export var toJstDayRange = (day) => {
  const start = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) - JST_OFFSET_SECONDS;
  return { start, end: start + 86400 };
};

/** 今の日本時間の日付から n 日前（"YYYY-MM-DD"） */
export var jstDayBefore = (nowSeconds, daysBefore) => {
  const date = new Date((nowSeconds + JST_OFFSET_SECONDS - daysBefore * 86400) * 1000);
  return date.toISOString().slice(0, 10);
};

var toNumber = (value) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * サブスク: 日の終わりに有効だった人数（作成済みで、期間の終わりがまだ来ていない）、新規、終了
 * 解約済みの行も最後の期間の終わりが残っているので、過去の日も同じ式で数えられる
 * ただし即時解約・返金の行は期間の終わりが未来のまま残るので、無効で終わりが未来の行は数えない
 */
var collectSubscriptions = async (db, range) => {
  const row = await db.queryOne(
    `SELECT
      count(DISTINCT user_id) FILTER (WHERE created_at < $2 AND current_period_end >= $2 AND type = 'LITE' AND NOT (is_disabled AND current_period_end > $3)) AS active_lite,
      count(DISTINCT user_id) FILTER (WHERE created_at < $2 AND current_period_end >= $2 AND type = 'STANDARD' AND NOT (is_disabled AND current_period_end > $3)) AS active_standard,
      count(DISTINCT user_id) FILTER (WHERE created_at < $2 AND current_period_end >= $2 AND type = 'PREMIUM' AND NOT (is_disabled AND current_period_end > $3)) AS active_premium,
      count(*) FILTER (WHERE created_at >= $1 AND created_at < $2 AND type = 'LITE') AS new_lite,
      count(*) FILTER (WHERE created_at >= $1 AND created_at < $2 AND type = 'STANDARD') AS new_standard,
      count(*) FILTER (WHERE created_at >= $1 AND created_at < $2 AND type = 'PREMIUM') AS new_premium,
      count(*) FILTER (WHERE status = 'canceled' AND current_period_end >= $1 AND current_period_end < $2) AS ended
    FROM subscriptions
    WHERE type IN ('LITE', 'STANDARD', 'PREMIUM')`,
    [range.start, range.end, Math.floor(Date.now() / 1000)]
  );
  const active = {};
  const started = {};
  for (const type of PLAN_TYPES) {
    active[type] = toNumber(row?.[`active_${type.toLowerCase()}`]);
    started[type] = toNumber(row?.[`new_${type.toLowerCase()}`]);
  }
  return { active, started, ended: toNumber(row?.ended) };
};

/** プレミアムコインの購入（返金済みは別に数える） */
var collectCoinSales = async (db, range) => {
  const row = await db.queryOne(
    `SELECT
      count(*) FILTER (WHERE refunded_at IS NULL) AS orders,
      coalesce(sum(price_yen) FILTER (WHERE refunded_at IS NULL), 0) AS yen,
      count(DISTINCT user_id) FILTER (WHERE refunded_at IS NULL) AS buyers,
      count(*) FILTER (WHERE refunded_at IS NOT NULL) AS refunded
    FROM premium_coin_purchases
    WHERE created_at >= $1 AND created_at < $2`,
    [range.start, range.end]
  );
  return {
    orders: toNumber(row?.orders),
    yen: toNumber(row?.yen),
    buyers: toNumber(row?.buyers),
    refunded: toNumber(row?.refunded),
  };
};

/** 生成数（generation_time に索引があるのでその日の範囲だけ読む。generation_time は日本時間で入っている） */
var collectGenerations = async (db, day) => {
  const row = await db.queryOne(
    `SELECT count(*) AS results, count(DISTINCT user_id) AS users
    FROM image_generation_results
    WHERE generation_time >= $1 AND generation_time < date($1, '+1 day')`,
    [day]
  );
  return { results: toNumber(row?.results), users: toNumber(row?.users) };
};

/**
 * Stripe の入金（残高の動き）。charge が売上、refund が返金、fee は手数料（円）
 * サブスクとコインの両方が入る。App Store の売上は入らない
 */
var collectStripe = async (secretKey, range) => {
  if (!secretKey) return null;
  const totals = { gross: 0, fee: 0, net: 0, refunds: 0, charges: 0 };
  let startingAfter = null;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      "created[gte]": String(range.start),
      "created[lt]": String(range.end),
      limit: "100",
    });
    if (startingAfter) params.set("starting_after", startingAfter);
    const response = await fetch(`https://api.stripe.com/v1/balance_transactions?${params}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (!response.ok) throw new Error(`stripe balance_transactions ${response.status}`);
    const body = await response.json();
    for (const item of body.data ?? []) {
      if (item.currency !== "jpy") continue;
      if (item.type === "charge" || item.type === "payment") {
        totals.gross += toNumber(item.amount);
        totals.fee += toNumber(item.fee);
        totals.net += toNumber(item.net);
        totals.charges += 1;
      } else if (item.type === "refund" || item.type === "payment_refund") {
        totals.refunds += -toNumber(item.amount);
        totals.net += toNumber(item.net);
      }
    }
    if (!body.has_more || (body.data ?? []).length === 0) break;
    startingAfter = body.data[body.data.length - 1].id;
  }
  return totals;
};

var cloudflareQuery = async (token, query, variables) => {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors?.length) throw new Error(`cloudflare graphql: ${body.errors[0].message}`);
  return body.data?.viewer?.zones?.[0] ?? null;
};

var toTop = (groups, key, limit = 15) =>
  (groups ?? [])
    .map((group) => ({ name: group.dimensions?.[key] || "(なし)", count: toNumber(group.count) }))
    .slice(0, limit);

/**
 * Cloudflare: ゾーン全体のアクセス、HTML を開いた人の流入元・国（ボットを含む参考値）、
 * サイトのスクリプトが送るページ表示の計測（/api/pv。ブラウザで開いた人だけ）
 */
var collectCloudflare = async (token, day, range) => {
  if (!token) return null;
  const startTime = new Date(range.start * 1000).toISOString();
  const endTime = new Date(range.end * 1000).toISOString();
  // 日別の合計は長く残るが、詳しい集計（流入元など）は古い日だと取れないので分けて聞く
  const totals = await cloudflareQuery(
    token,
    `query($z: String!, $day: Date!) {
      viewer { zones(filter: { zoneTag: $z }) {
        daily: httpRequests1dGroups(limit: 1, filter: { date: $day }) {
          sum { requests pageViews bytes } uniq { uniques }
        }
      } }
    }`,
    { z: ZONE_ID, day }
  );
  const zone = await cloudflareQuery(
    token,
    `query($z: String!, $s: Time!, $e: Time!) {
      viewer { zones(filter: { zoneTag: $z }) {
        referers: httpRequestsAdaptiveGroups(limit: 20, filter: { datetime_geq: $s, datetime_lt: $e, requestSource: "eyeball", edgeResponseContentTypeName: "html", edgeResponseStatus: 200 }, orderBy: [count_DESC]) {
          count dimensions { clientRefererHost }
        }
        countries: httpRequestsAdaptiveGroups(limit: 15, filter: { datetime_geq: $s, datetime_lt: $e, requestSource: "eyeball", edgeResponseContentTypeName: "html", edgeResponseStatus: 200 }, orderBy: [count_DESC]) {
          count dimensions { clientCountryName }
        }
        pv: httpRequestsAdaptiveGroups(limit: 200, filter: { datetime_geq: $s, datetime_lt: $e, clientRequestPath: "/api/pv", edgeResponseStatus_in: [200, 204] }, orderBy: [count_DESC]) {
          count dimensions { clientRequestQuery }
        }
      } }
    }`,
    { z: ZONE_ID, s: startTime, e: endTime }
  ).catch(() => null);
  const daily = totals?.daily?.[0];
  const pv = { total: 0, landings: 0, bySource: {}, bySection: {} };
  for (const group of zone?.pv ?? []) {
    const params = new URLSearchParams(String(group.dimensions?.clientRequestQuery ?? "").replace(/^\?/, ""));
    const count = toNumber(group.count);
    const source = params.get("r") || "unknown";
    const section = params.get("p") || "other";
    pv.total += count;
    pv.bySection[section] = (pv.bySection[section] ?? 0) + count;
    if (source !== "internal") {
      pv.landings += count;
      pv.bySource[source] = (pv.bySource[source] ?? 0) + count;
    }
  }
  return {
    requests: toNumber(daily?.sum?.requests),
    pageViews: toNumber(daily?.sum?.pageViews),
    uniques: toNumber(daily?.uniq?.uniques),
    bytes: toNumber(daily?.sum?.bytes),
    referers: toTop(zone?.referers, "clientRefererHost"),
    countries: toTop(zone?.countries, "clientCountryName"),
    pv,
  };
};

/** 1 日分を集めて保存する。外部サービスが失敗しても、取れたところだけ残す */
export var collectAnalyticsDay = async (env, db, day) => {
  await ensureAnalyticsTables(db);
  const range = toJstDayRange(day);
  const errors = [];
  const safe = async (name, run) => {
    try {
      return await run();
    } catch (error) {
      errors.push(`${name}: ${String(error?.message ?? error).slice(0, 200)}`);
      return null;
    }
  };
  const [subscriptions, coins, generations, stripe, cloudflare, costs] = await Promise.all([
    safe("subscriptions", () => collectSubscriptions(db, range)),
    safe("coins", () => collectCoinSales(db, range)),
    safe("generations", async () => collectGenerations(await getGenlogDb(env), day)),
    safe("stripe", () => collectStripe(env.STRIPE_SECRET_KEY, range)),
    safe("cloudflare", () => collectCloudflare(env.CF_ANALYTICS_TOKEN, day, range)),
    safe("costs", () => collectCosts(env, day, range)),
  ]);
  for (const message of costs?.errors ?? []) errors.push(`costs.${message}`);
  const metrics = { subscriptions, coins, generations, stripe, cloudflare, costs, errors };
  await db.execute(
    `INSERT INTO analytics_daily (day, metrics, updated_at) VALUES ($1, $2, $3)
    ON CONFLICT (day) DO UPDATE SET metrics = EXCLUDED.metrics, updated_at = EXCLUDED.updated_at`,
    [day, JSON.stringify(metrics), Math.floor(Date.now() / 1000)]
  );
  return { day, metrics };
};

/** 保存済みの日別の数字（古い順） */
export var listAnalyticsDays = async (db, days) => {
  await ensureAnalyticsTables(db);
  const rows = await db.query(
    `SELECT day, metrics, updated_at
    FROM analytics_daily
    WHERE day >= date('now', '+9 hours', '-' || $1 || ' days')
    ORDER BY day ASC`,
    [days]
  );
  return rows.map((row) => ({ day: row.day, updatedAt: toNumber(row.updated_at), ...(typeof row.metrics === "string" ? JSON.parse(row.metrics) : row.metrics) }));
};

/** 今の契約数（その場で数える。日別の表の最新日より新しい） */
export var getCurrentSubscriptionCounts = async (db, nowSeconds) => {
  const rows = await db.query(
    `SELECT type, count(DISTINCT user_id) AS count FROM subscriptions
    WHERE is_disabled = FALSE AND current_period_end > $1 AND type IN ('LITE', 'STANDARD', 'PREMIUM')
    GROUP BY type`,
    [nowSeconds]
  );
  const counts = { LITE: 0, STANDARD: 0, PREMIUM: 0 };
  for (const row of rows) counts[row.type] = toNumber(row.count);
  return counts;
};

var PNL_CACHE_SECONDS = 600;

/**
 * 収支（今日のここまでと今月）。今日の分はその場で Stripe と各サービスに聞き、今月の昨日までは保存済みの日別を足す
 * 売上は Stripe の入金（手数料・返金を引いた net）。App Store・Google Play の売上は入らない
 * 10 分だけ Cache API に置く（外部 API をページを開くたびに呼ばない）
 */
export var getLiveProfitAndLoss = async (env, db, nowSeconds, { fresh = false } = {}) => {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request("https://aipictors-api.internal/analytics/pnl");
  if (cache && !fresh) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.json();
  }
  const today = jstDayBefore(nowSeconds, 0);
  const todayRange = { start: toJstDayRange(today).start, end: nowSeconds };
  const monthStart = `${today.slice(0, 8)}01`;
  const [stripeToday, costsToday, rows] = await Promise.all([
    collectStripe(env.STRIPE_SECRET_KEY, todayRange).catch(() => null),
    collectCosts(env, today, todayRange, { skipOpenai: true }),
    db.query(`SELECT day, metrics FROM analytics_daily WHERE day >= $1 AND day < $2 ORDER BY day ASC`, [monthStart, today]),
  ]);
  const pastDays = rows.map((row) => ({ day: row.day, ...(typeof row.metrics === "string" ? JSON.parse(row.metrics) : row.metrics) }));
  const costKeys = ["cloudflare", "runpod", "google", "openai"];
  const monthCosts = Object.fromEntries(costKeys.map((key) => [key, 0]));
  let monthRevenue = 0;
  let daysWithCosts = 0;
  for (const day of pastDays) {
    monthRevenue += toNumber(day.stripe?.net);
    if (day.costs) daysWithCosts += 1;
    for (const key of costKeys) monthCosts[key] += toNumber(day.costs?.items?.[key]?.jpy);
  }
  const todayRevenue = toNumber(stripeToday?.net);
  for (const key of costKeys) monthCosts[key] += toNumber(costsToday.items?.[key]?.jpy);
  monthRevenue += todayRevenue;
  const monthCostTotal = costKeys.reduce((total, key) => total + monthCosts[key], 0);
  const elapsedDays = pastDays.length + (nowSeconds - todayRange.start) / 86400;
  const [year, month] = today.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const result = {
    at: nowSeconds,
    today: {
      day: today,
      revenue: todayRevenue,
      costs: Object.fromEntries(costKeys.map((key) => [key, toNumber(costsToday.items?.[key]?.jpy)])),
      costTotal: costsToday.jpy,
      profit: todayRevenue - costsToday.jpy,
      fxUsdJpy: costsToday.fxUsdJpy,
      errors: costsToday.errors,
    },
    month: {
      from: monthStart,
      revenue: monthRevenue,
      costs: monthCosts,
      costTotal: monthCostTotal,
      profit: monthRevenue - monthCostTotal,
      elapsedDays: Math.round(elapsedDays * 100) / 100,
      daysInMonth,
      daysWithCosts,
      storedDays: pastDays.length,
      projectedProfit: elapsedDays > 0 ? Math.round(((monthRevenue - monthCostTotal) / elapsedDays) * daysInMonth) : null,
    },
  };
  if (cache) {
    await cache.put(cacheKey, new Response(JSON.stringify(result), { headers: { "Cache-Control": `max-age=${PNL_CACHE_SECONDS}` } }));
  }
  return result;
};
