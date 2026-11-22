// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { cloudflareFixedUsd, fetchUsdJpy } from "./costs"

/**
 * 維持費の内訳（/admin/costs）。今の構成で 1 か月動かしたらいくらかを出す
 * - RunPod: 今ある Pod を GraphQL で読み、役割（名前の頭）ごとの 1 日の稼働時間 × 時間単価で月額にする。保存領域・止めた Pod のディスクは今の消費額から Pod の分を引いた残り
 * - ほかのサービス: 保存済みの日別（analytics_daily.metrics.costs）の直近 7 日の平均 × 30
 */

var FALLBACK_USD_JPY = 155;
var DAYS_PER_MONTH = 30;
var RECENT_DAYS = 7;
/** グラフに出す日数 */
var CHART_DAYS = 30;
var CACHE_SECONDS = 300;

/** 夜だけ動く Pod の 1 日の時間（aipictors-cron の cron-gpu-night: 19:00〜2:00 JST。安い GPU が借りられない夜は動かない） */
export var NIGHT_HOURS_PER_DAY = 7;

/** Pod 名の頭 → 役割（cron-gpu-night が付ける名前） */
var ROLES = [
  { prefix: "aipictors-free-", role: "free", label: "無料用", hoursPerDay: 24 },
  { prefix: "aipictors-paid-", role: "paid", label: "有料用", hoursPerDay: 24 },
  { prefix: "aipictors-night-", role: "night", label: "夜間（19:00〜2:00）", hoursPerDay: NIGHT_HOURS_PER_DAY },
];

var SERVICE_KEYS = ["cloudflare", "google", "xai", "openai"];

var toNumber = (value) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

var round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

var runpodGraphql = async (apiKey) => {
  const response = await fetch("https://api.runpod.io/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{ myself { clientBalance currentSpendPerHr
        networkVolumes { id name size dataCenterId }
        pods { id name desiredStatus costPerHr gpuCount lastStartedAt containerDiskInGb machine { gpuDisplayName } } } }`,
    }),
  });
  if (!response.ok) throw new Error(`runpod graphql ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(`runpod graphql: ${String(body.errors[0]?.message).slice(0, 160)}`);
  return body.data.myself;
};

/**
 * Pod ごとの月額の見込み。夜の Pod は止まっていても毎晩動くので数え、ほかの止まっている Pod は 0
 * 保存領域などは今の消費額（currentSpendPerHr）から動いている Pod の時間単価を引いた残りを 24 時間ぶん
 */
export var estimateRunpod = (myself) => {
  const pods = (myself.pods ?? []).map((pod) => {
    const role = ROLES.find((item) => pod.name?.startsWith(item.prefix));
    const running = pod.desiredStatus === "RUNNING";
    const costPerHr = toNumber(pod.costPerHr);
    const hoursPerDay = role?.role === "night" ? role.hoursPerDay : running ? 24 : 0;
    return {
      id: pod.id,
      name: pod.name,
      role: role?.role ?? "other",
      roleLabel: role?.label ?? (running ? "その他（常時）" : "停止中"),
      status: pod.desiredStatus,
      gpu: pod.machine?.gpuDisplayName ?? null,
      gpuCount: toNumber(pod.gpuCount),
      costPerHr,
      hoursPerDay,
      startedAt: pod.lastStartedAt ?? null,
      monthlyUsd: round(costPerHr * hoursPerDay * DAYS_PER_MONTH),
    };
  });
  const runningPerHr = pods.filter((pod) => pod.status === "RUNNING").reduce((total, pod) => total + pod.costPerHr, 0);
  const spendPerHr = toNumber(myself.currentSpendPerHr);
  const storagePerHr = Math.max(0, spendPerHr - runningPerHr);
  const storageMonthlyUsd = round(storagePerHr * 24 * DAYS_PER_MONTH);
  const podsMonthlyUsd = pods.reduce((total, pod) => total + pod.monthlyUsd, 0);
  const balance = toNumber(myself.clientBalance);
  return {
    balance: round(balance),
    spendPerHr: round(spendPerHr, 3),
    runwayHours: spendPerHr > 0 ? round(balance / spendPerHr, 1) : null,
    pods: pods.sort((a, b) => b.monthlyUsd - a.monthlyUsd),
    volumes: (myself.networkVolumes ?? []).map((volume) => ({
      id: volume.id,
      name: volume.name,
      sizeGb: toNumber(volume.size),
      dataCenterId: volume.dataCenterId,
    })),
    storage: { perHr: round(storagePerHr, 3), monthlyUsd: storageMonthlyUsd },
    monthlyUsd: round(podsMonthlyUsd + storageMonthlyUsd),
  };
};

/** 日別の費用の直近 N 日の平均（1 日あたり円）と、細目（Cloudflare の項目・Google の SKU・xAI のモデル）の平均 */
export var averageServices = (days) => {
  const withCosts = days.filter((day) => day.costs?.items);
  const count = withCosts.length;
  const services = {};
  for (const key of SERVICE_KEYS) {
    let jpy = 0;
    const detail = {};
    for (const day of withCosts) {
      const item = day.costs.items[key];
      if (!item) continue;
      jpy += toNumber(item.jpy);
      const fx = toNumber(day.costs.fxUsdJpy) || FALLBACK_USD_JPY;
      // 細目は円にそろえる（Google は請求が円、ほかはドル）
      const parts =
        key === "cloudflare" ? item.detail : key === "google" ? item.bySku : key === "xai" ? item.byModel : key === "openai" ? item.byModel ?? item.byLineItem : null;
      for (const [name, value] of Object.entries(parts ?? {})) {
        const yen = key === "google" && item.currency !== "USD" ? toNumber(value) : toNumber(value) * fx;
        detail[name] = (detail[name] ?? 0) + yen;
      }
    }
    services[key] = {
      dailyJpy: count ? Math.round(jpy / count) : 0,
      monthlyJpy: count ? Math.round((jpy / count) * DAYS_PER_MONTH) : 0,
      detail: Object.entries(detail)
        .map(([name, yen]) => ({ name, monthlyJpy: Math.round((yen / count) * DAYS_PER_MONTH) }))
        .filter((part) => part.monthlyJpy > 0)
        .sort((a, b) => b.monthlyJpy - a.monthlyJpy),
    };
  }
  return { days: count, from: withCosts[0]?.day ?? null, to: withCosts.at(-1)?.day ?? null, services };
};

/** 維持費の内訳。5 分だけ Cache API に置く（?fresh=1 で使わない） */
export var getCostBreakdown = async (env, db, nowSeconds, { fresh = false } = {}) => {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request("https://aipictors-api.internal/analytics/costs/breakdown");
  if (cache && !fresh) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.json();
  }
  const errors = [];
  const [fx, myself, rows, cloudflarePlans] = await Promise.all([
    fetchUsdJpy().catch(() => null),
    env.RUNPOD_API_KEY
      ? runpodGraphql(env.RUNPOD_API_KEY).catch((error) => {
          errors.push(`runpod: ${String(error?.message ?? error).slice(0, 200)}`);
          return null;
        })
      : null,
    db.query(
      `SELECT day, metrics FROM analytics_daily WHERE day >= date('now', '+9 hours', '-' || $1 || ' days') ORDER BY day ASC`,
      [CHART_DAYS]
    ),
    env.CF_BILLING_TOKEN ? cloudflareFixedUsd(env.CF_BILLING_TOKEN, DAYS_PER_MONTH).catch(() => null) : null,
  ]);
  const fxUsdJpy = fx ?? FALLBACK_USD_JPY;
  const days = rows.map((row) => ({ day: row.day, ...(typeof row.metrics === "string" ? JSON.parse(row.metrics) : row.metrics) }));
  // 今日の行はまだない（00:30 に前日分を保存）ので、昨日までの直近 7 日
  const recent = averageServices(days.slice(-RECENT_DAYS));
  // Cloudflare の契約は過去の平均ではなく今の契約で数える（解約した Pro・値下げした Stream をすぐ反映する）
  if (cloudflarePlans) {
    const cloudflare = recent.services.cloudflare;
    const plansDetail = cloudflare.detail.find((part) => part.name === "plans");
    const currentPlansJpy = Math.round(cloudflarePlans.usd * fxUsdJpy);
    cloudflare.monthlyJpy += currentPlansJpy - (plansDetail?.monthlyJpy ?? 0);
    cloudflare.detail = [
      ...cloudflare.detail.filter((part) => part.name !== "plans"),
      ...(currentPlansJpy > 0 ? [{ name: "plans", monthlyJpy: currentPlansJpy }] : []),
    ].sort((a, b) => b.monthlyJpy - a.monthlyJpy);
    cloudflare.plans = cloudflarePlans.plans;
  }
  const runpod = myself ? estimateRunpod(myself) : null;
  const runpodMonthlyJpy = runpod ? Math.round(runpod.monthlyUsd * fxUsdJpy) : null;
  // RunPod が読めなかったときは日別の平均で代わりにする
  const runpodFallbackJpy = (() => {
    const withCosts = days.slice(-RECENT_DAYS).filter((day) => day.costs?.items?.runpod);
    if (!withCosts.length) return 0;
    return Math.round((withCosts.reduce((total, day) => total + toNumber(day.costs.items.runpod.jpy), 0) / withCosts.length) * DAYS_PER_MONTH);
  })();
  const servicesTotal = SERVICE_KEYS.reduce((total, key) => total + recent.services[key].monthlyJpy, 0);
  const result = {
    at: nowSeconds,
    fxUsdJpy: round(fxUsdJpy, 2),
    nightHoursPerDay: NIGHT_HOURS_PER_DAY,
    runpod: runpod ? { ...runpod, monthlyJpy: runpodMonthlyJpy } : null,
    recent,
    monthlyJpy: {
      runpod: runpodMonthlyJpy ?? runpodFallbackJpy,
      runpodFromRecent: runpodFallbackJpy,
      ...Object.fromEntries(SERVICE_KEYS.map((key) => [key, recent.services[key].monthlyJpy])),
      total: (runpodMonthlyJpy ?? runpodFallbackJpy) + servicesTotal,
    },
    daily: days.map((day) => ({
      day: day.day,
      jpy: toNumber(day.costs?.jpy),
      items: Object.fromEntries(["runpod", ...SERVICE_KEYS].map((key) => [key, toNumber(day.costs?.items?.[key]?.jpy)])),
    })),
    errors,
  };
  if (cache) {
    await cache.put(cacheKey, new Response(JSON.stringify(result), { headers: { "Cache-Control": `max-age=${CACHE_SECONDS}` } }));
  }
  return result;
};
