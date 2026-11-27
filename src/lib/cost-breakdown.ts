// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { cloudflareFixedUsd, fetchUsdJpy } from "./costs"

/**
 * 維持費の内訳（/admin/costs）。今の構成で 1 か月動かしたらいくらかを出す
 * - RunPod: 今ある Pod を GraphQL で読み、役割（名前の頭）ごとの 1 日の稼働時間 × 時間単価で月額にする。保存領域・止めた Pod のディスクは今の消費額から Pod の分を引いた残り。
 *   夜の台・お試しの台（昼は一覧にない）は、開くたびに請求 API の直近 7 日の 1 時間ごとの実額を読み、今の常時の台数を超えて同時に動いていた分の平均
 * - ほかのサービス: 保存済みの日別（analytics_daily.metrics.costs）の直近 5 日の中央値 × 30（1 日だけの急な増減に引っ張られず、値下げもすぐ出る）
 */

var FALLBACK_USD_JPY = 155;
var DAYS_PER_MONTH = 30;
var RECENT_DAYS = 7;
/** ほかのサービスの月額は直近この日数の中央値 */
var SERVICE_DAYS = 5;
/** グラフに出す日数 */
var CHART_DAYS = 30;
var CACHE_SECONDS = 60;

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

/** RunPod の請求 API（v2）の 1 時間ごとの Pod 別の実額 */
var runpodHourly = async (apiKey, startSeconds, endSeconds) => {
  const params = new URLSearchParams({
    bucketSize: "hour",
    startTime: new Date(startSeconds * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    endTime: new Date(endSeconds * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
  });
  const response = await fetch(`https://api.runpod.io/v2/billing/pods?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`runpod billing ${response.status}`);
  return (await response.json()).records ?? [];
};

/**
 * 1 時間ごとの実額から、常時の台数（baseCount）を超えて同時に動いていた Pod の分を出す。
 * 各時間で金額の大きい順に baseCount 台を常時の台とみなし、残り（夜の台・入れ替えのお試し・試験用の台）を足す。
 * 無料用・有料用は入れ替わって ID が変わるので、ID ではなく同時に動いていた台数で分ける
 */
export var extraPodUsage = (records, baseCount, hours) => {
  const byHour = new Map();
  let totalUsd = 0;
  for (const row of records) {
    const amount = toNumber(row.totalAmount);
    totalUsd += amount;
    const list = byHour.get(row.startTime) ?? [];
    list.push(amount);
    byHour.set(row.startTime, list);
  }
  let extraUsd = 0;
  for (const list of byHour.values()) {
    list.sort((a, b) => b - a);
    extraUsd += list.slice(baseCount).reduce((total, amount) => total + amount, 0);
  }
  const days = hours / 24;
  return { dailyExtraUsd: days > 0 ? extraUsd / days : 0, dailyTotalUsd: days > 0 ? totalUsd / days : 0 };
};

/**
 * 夜の Pod は毎晩作って 2 時に消すので、昼に読むと一覧にない（名前も夜ごとに変わる）。
 * 直近の 1 時間ごとの請求のうち、今の常時の台数を超えて動いていた分（夜の台・お試しの台）の 1 日平均で数える。
 * 今動いている夜の Pod があれば、その行の月額をこの平均に置き換える（二重に数えない）
 */
export var addRecentExtraPods = (runpod, dailyExtraUsd, days) => {
  const dailyUsd = dailyExtraUsd;
  const monthlyUsd = round(dailyUsd * DAYS_PER_MONTH);
  const nightPods = runpod.pods.filter((pod) => pod.role === "night");
  const others = runpod.pods.filter((pod) => pod.role !== "night");
  const current = nightPods[0];
  const row = {
    id: current?.id ?? "night-recent",
    name: `${current ? `${current.name}・` : ""}直近 ${days} 日の実額の平均（毎晩作って消す台・入れ替えのお試しの台）`,
    role: "night",
    roleLabel: "夜間・一時的な台",
    status: current?.status ?? "EXITED",
    gpu: current?.gpu ?? null,
    gpuCount: current?.gpuCount ?? 1,
    costPerHr: round(dailyUsd / NIGHT_HOURS_PER_DAY, 3),
    hoursPerDay: NIGHT_HOURS_PER_DAY,
    startedAt: current?.startedAt ?? null,
    monthlyUsd,
  };
  const removed = nightPods.reduce((total, pod) => total + pod.monthlyUsd, 0);
  return {
    ...runpod,
    pods: [...others, row].sort((a, b) => b.monthlyUsd - a.monthlyUsd),
    monthlyUsd: round(runpod.monthlyUsd - removed + monthlyUsd),
  };
};

var median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * 日別の費用の直近 N 日の中央値（1 日あたり円）と、細目（Cloudflare の項目・Google の SKU・xAI のモデル）。
 * 細目は平均の割合を中央値の合計にそろえる（同じキーを OpenClaw が使った日などの 1 日だけの増え方に引っ張られない）
 */
export var averageServices = (days) => {
  const withCosts = days.filter((day) => day.costs?.items);
  const count = withCosts.length;
  const services = {};
  for (const key of SERVICE_KEYS) {
    let jpy = 0;
    const daily = [];
    const detail = {};
    for (const day of withCosts) {
      const item = day.costs.items[key];
      daily.push(toNumber(item?.jpy));
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
    const middle = median(daily);
    const scale = jpy > 0 ? (middle * count) / jpy : 0;
    services[key] = {
      dailyJpy: Math.round(middle),
      averageDailyJpy: count ? Math.round(jpy / count) : 0,
      monthlyJpy: Math.round(middle * DAYS_PER_MONTH),
      detail: Object.entries(detail)
        .map(([name, yen]) => ({ name, monthlyJpy: Math.round(((yen * scale) / count) * DAYS_PER_MONTH) }))
        .filter((part) => part.monthlyJpy > 0)
        .sort((a, b) => b.monthlyJpy - a.monthlyJpy),
    };
  }
  return { days: count, method: "median", from: withCosts[0]?.day ?? null, to: withCosts.at(-1)?.day ?? null, services };
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
  // 請求は 1 時間単位でまとまり、直近 1〜2 時間はまだ全部載っていないので、2 時間前の頭までの直近 7 日
  const hourEnd = Math.floor(nowSeconds / 3600) * 3600 - 2 * 3600;
  const hourStart = hourEnd - RECENT_DAYS * 86400;
  const [fx, myself, rows, cloudflarePlans, hourly] = await Promise.all([
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
    env.RUNPOD_API_KEY
      ? runpodHourly(env.RUNPOD_API_KEY, hourStart, hourEnd).catch((error) => {
          errors.push(`runpod billing: ${String(error?.message ?? error).slice(0, 200)}`);
          return null;
        })
      : null,
  ]);
  const fxUsdJpy = fx ?? FALLBACK_USD_JPY;
  const days = rows.map((row) => ({ day: row.day, ...(typeof row.metrics === "string" ? JSON.parse(row.metrics) : row.metrics) }));
  // 今日の行はまだない（00:30 に前日分を保存）ので、昨日までの直近 7 日
  const recent = averageServices(days.slice(-SERVICE_DAYS));
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
  const current = myself ? estimateRunpod(myself) : null;
  const baseCount = current ? current.pods.filter((pod) => pod.status === "RUNNING" && pod.role !== "night").length : 0;
  const usage = hourly ? extraPodUsage(hourly, baseCount, (hourEnd - hourStart) / 3600) : null;
  const runpod = current && usage ? addRecentExtraPods(current, usage.dailyExtraUsd, RECENT_DAYS) : current;
  const runpodMonthlyJpy = runpod ? Math.round(runpod.monthlyUsd * fxUsdJpy) : null;
  // 直近 7 日の実績ペース（請求 API の 1 時間ごと。読めなかったときは保存済みの日別）。RunPod の今の構成が読めなかったときの代わりにも使う
  const runpodFallbackJpy = usage ? Math.round(usage.dailyTotalUsd * fxUsdJpy * DAYS_PER_MONTH) : (() => {
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
