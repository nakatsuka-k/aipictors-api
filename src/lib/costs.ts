// @ts-nocheck -- 周りのファイルに合わせて型は付けていない

/**
 * 収支用の費用（日本時間の 1 日、または今日のここまで）
 * - Cloudflare: 使用量 × 定価（無料枠は月の量を 30 で割って日ごとに引く）＋契約（月額は 30 日、年額は 365 日で割る）
 * - RunPod: 請求 API の時間ごとの実額（Pod と保存領域）
 * - Google（Gemini API）: BigQuery の請求エクスポートの実額（クレジット差し引き後）
 * - OpenAI（組織 techpage）: Costs API の実額。日ごとの区切りが UTC なので、同じ日付の UTC の 1 日分を入れる
 * - xAI（Grok）: 管理 API の利用額（USD）。日本時間の範囲で聞ける
 * どれかが失敗しても取れたところだけ返す（errors に理由）
 */

var ACCOUNT_ID = "7f2a200bf2994f36f45e733751a30be6";
var GCP_PROJECT = "gen-lang-client-0028298935";
var GCP_DATASET = "billing_export";
var FALLBACK_USD_JPY = 155;

var toNumber = (value) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

var round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

/** 範囲の長さ（日）。無料枠と契約を日割りするのに使う */
var rangeDays = (range) => (range.end - range.start) / 86400;

var over = (used, includedPerMonth, days) => Math.max(0, used - (includedPerMonth / 30) * days);

var R2_CLASS_A = new Set([
  "ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload",
  "CreateMultipartUpload", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts",
  "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration", "LifecycleStorageTierTransition",
]);
var R2_FREE = new Set(["DeleteObject", "DeleteObjects", "DeleteBucket", "AbortMultipartUpload"]);

var cloudflareGraphql = async (token, query, variables) => {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors?.length) throw new Error(`cloudflare graphql: ${body.errors[0].message}`);
  return body.data?.viewer?.accounts?.[0] ?? {};
};

/** Cloudflare の契約（Workers Paid・Stream・Pro など）を日割り。価格 0 の従量契約は数えない */
var cloudflareFixedUsd = async (token, days) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/subscriptions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  if (!body.success) throw new Error(`cloudflare subscriptions: ${JSON.stringify(body.errors).slice(0, 120)}`);
  const plans = {};
  let usd = 0;
  for (const sub of body.result ?? []) {
    const price = toNumber(sub.price);
    if (!price || sub.currency !== "USD") continue;
    const perDay = sub.frequency === "yearly" ? price / 365 : price / 30;
    plans[sub.rate_plan?.public_name ?? sub.id] = round(perDay * days);
    usd += perDay * days;
  }
  return { usd, plans };
};

/** Stream の再生分数（1,000 分 $1）。請求の使用量 API から時間ごとに読む */
var streamMinutesViewed = async (token, range) => {
  const params = new URLSearchParams({
    time_delta: "hour",
    since: new Date(range.start * 1000).toISOString(),
    until: new Date(range.end * 1000 - 1000).toISOString(),
  });
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/billing/usage?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  if (!body.success) return 0;
  return (body.result?.data?.[0]?.metrics?.[0] ?? []).reduce((total, n) => total + toNumber(n), 0);
};

export var collectCloudflareCost = async (token, range) => {
  if (!token) return null;
  const days = rangeDays(range);
  const variables = {
    a: ACCOUNT_ID,
    s: new Date(range.start * 1000).toISOString(),
    e: new Date(range.end * 1000).toISOString(),
  };
  const usage = await cloudflareGraphql(
    token,
    `query($a: String!, $s: Time!, $e: Time!) { viewer { accounts(filter: { accountTag: $a }) {
      workers: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $s, datetime_lt: $e }) { sum { requests cpuTimeUs } }
      r2ops: r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $s, datetime_lt: $e }) { sum { requests } dimensions { actionType } }
      r2storage: r2StorageAdaptiveGroups(limit: 1000, filter: { datetime_geq: $s, datetime_lt: $e }) { max { payloadSize metadataSize } dimensions { bucketName } }
      d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $s, datetime_lt: $e }) { sum { rowsRead rowsWritten } }
      d1storage: d1StorageAdaptiveGroups(limit: 1000, filter: { datetime_geq: $s, datetime_lt: $e }) { max { databaseSizeBytes } dimensions { databaseId } }
      doInvocations: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $s, datetime_lt: $e }) { sum { requests } }
      doPeriodic: durableObjectsPeriodicGroups(limit: 1000, filter: { datetime_geq: $s, datetime_lt: $e }) { sum { activeTime } }
      kv: kvOperationsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $s, datetime_lt: $e }) { sum { requests } dimensions { actionType } }
    } } }`,
    variables
  );
  const sum = (rows, pick) => (rows ?? []).reduce((total, row) => total + toNumber(pick(row)), 0);

  const workerRequests = sum(usage.workers, (r) => r.sum.requests);
  const workerCpuMs = sum(usage.workers, (r) => r.sum.cpuTimeUs) / 1000;
  const workers = (over(workerRequests, 10e6, days) * 0.3 + over(workerCpuMs, 30e6, days) * 0.02) / 1e6;

  let classA = 0;
  let classB = 0;
  for (const row of usage.r2ops ?? []) {
    const type = row.dimensions.actionType;
    if (R2_FREE.has(type)) continue;
    if (R2_CLASS_A.has(type)) classA += toNumber(row.sum.requests);
    else classB += toNumber(row.sum.requests);
  }
  const r2Ops = (over(classA, 1e6, days) * 4.5 + over(classB, 10e6, days) * 0.36) / 1e6;
  const r2Gb = sum(usage.r2storage, (r) => toNumber(r.max.payloadSize) + toNumber(r.max.metadataSize)) / 1e9;
  const r2Storage = Math.max(0, r2Gb - 10) * 0.015 * (days / 30);

  const d1Read = sum(usage.d1, (r) => r.sum.rowsRead);
  const d1Written = sum(usage.d1, (r) => r.sum.rowsWritten);
  const d1Gb = sum(usage.d1storage, (r) => r.max.databaseSizeBytes) / 1e9;
  const d1 = over(d1Read, 25e9, days) * 0.001 / 1e6 + over(d1Written, 50e6, days) / 1e6 + Math.max(0, d1Gb - 5) * 0.75 * (days / 30);

  const doRequests = sum(usage.doInvocations, (r) => r.sum.requests);
  const doGbSeconds = (sum(usage.doPeriodic, (r) => r.sum.activeTime) / 1e6) * (128 / 1024);
  const durableObjects = (over(doRequests, 1e6, days) * 0.15 + over(doGbSeconds, 400000, days) * 12.5) / 1e6;

  let kvReads = 0;
  let kvWrites = 0;
  for (const row of usage.kv ?? []) {
    if (row.dimensions.actionType === "read") kvReads += toNumber(row.sum.requests);
    else kvWrites += toNumber(row.sum.requests);
  }
  const kv = (over(kvReads, 10e6, days) * 0.5 + over(kvWrites, 1e6, days) * 5) / 1e6;

  const [fixed, minutes] = await Promise.all([
    cloudflareFixedUsd(token, days),
    streamMinutesViewed(token, range).catch(() => 0),
  ]);
  const stream = minutes / 1000;

  const detail = {
    workers: round(workers),
    r2Ops: round(r2Ops),
    r2Storage: round(r2Storage),
    d1: round(d1),
    durableObjects: round(durableObjects),
    kv: round(kv),
    stream: round(stream),
    plans: round(fixed.usd),
  };
  const usd = workers + r2Ops + r2Storage + d1 + durableObjects + kv + stream + fixed.usd;
  return {
    usd: round(usd),
    detail,
    plans: fixed.plans,
    usage: { workerRequests, workerCpuMs: Math.round(workerCpuMs), r2Gb: round(r2Gb, 1), d1Read, d1Written, streamMinutes: minutes },
  };
};

/** RunPod: 時間ごとの請求額（Pod は GPU とディスク、保存領域は別） */
export var collectRunpodCost = async (apiKey, range) => {
  if (!apiKey) return null;
  const params = new URLSearchParams({
    bucketSize: "hour",
    startTime: new Date(range.start * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    endTime: new Date(range.end * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
  });
  const get = async (path) => {
    const response = await fetch(`https://rest.runpod.io/v1/billing/${path}?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`runpod ${path} ${response.status}`);
    return response.json();
  };
  const [pods, volumes] = await Promise.all([get("pods"), get("networkvolumes")]);
  const byPod = {};
  let podUsd = 0;
  for (const row of pods ?? []) {
    const amount = toNumber(row.amount);
    podUsd += amount;
    byPod[row.podId] = round((byPod[row.podId] ?? 0) + amount);
  }
  const volumeUsd = (volumes ?? []).reduce((total, row) => total + toNumber(row.amount), 0);
  return { usd: round(podUsd + volumeUsd), detail: { pods: round(podUsd), volumes: round(volumeUsd) }, byPod };
};

var base64Url = (input) => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** サービスアカウントの鍵で Google のアクセストークンを取る（BigQuery の読み取りだけ） */
var googleAccessToken = async (serviceAccountJson) => {
  const key = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/bigquery.readonly",
      aud: key.token_uri,
      iat: now,
      exp: now + 3600,
    })
  )}`;
  const pem = key.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsigned));
  const response = await fetch(key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64Url(signature)}`,
    }),
  });
  const body = await response.json();
  if (!body.access_token) throw new Error(`google token: ${JSON.stringify(body).slice(0, 120)}`);
  return body.access_token;
};

var bigquery = async (token, sql) => {
  const response = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${GCP_PROJECT}/queries`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 30000 }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`bigquery ${response.status}: ${JSON.stringify(body.error?.message ?? body).slice(0, 160)}`);
  const fields = (body.schema?.fields ?? []).map((field) => field.name);
  return (body.rows ?? []).map((row) => Object.fromEntries(row.f.map((cell, i) => [fields[i], cell.v])));
};

/** Google Cloud（Gemini API）: 請求エクスポートの実額。エクスポートが届く前は null（未着として扱う） */
export var collectGoogleCost = async (serviceAccountJson, range) => {
  if (!serviceAccountJson) return null;
  const token = await googleAccessToken(serviceAccountJson);
  const tables = await bigquery(
    token,
    `SELECT table_name FROM \`${GCP_PROJECT}.${GCP_DATASET}.INFORMATION_SCHEMA.TABLES\` WHERE table_name LIKE 'gcp_billing_export_v1_%'`
  );
  if (!tables.length) return { pending: true, amount: 0, currency: null, bySku: {} };
  const table = `\`${GCP_PROJECT}.${GCP_DATASET}.${tables[0].table_name}\``;
  const rows = await bigquery(
    token,
    `SELECT currency, sku.description AS sku,
      SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS amount
    FROM ${table}
    WHERE usage_start_time >= TIMESTAMP_SECONDS(${range.start}) AND usage_start_time < TIMESTAMP_SECONDS(${range.end})
    GROUP BY 1, 2`
  );
  let amount = 0;
  let currency = null;
  const bySku = {};
  for (const row of rows) {
    const value = toNumber(row.amount);
    amount += value;
    currency = row.currency;
    if (Math.abs(value) >= 0.01) bySku[row.sku] = round(value, 2);
  }
  return { pending: false, amount: round(amount, 2), currency, bySku };
};

/** OpenAI: 組織の費用（Costs API は UTC の 1 日ごと） */
export var collectOpenaiCost = async (adminKey, day) => {
  if (!adminKey) return null;
  const start = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  const params = new URLSearchParams({ start_time: String(start), end_time: String(start + 86400), bucket_width: "1d", limit: "1" });
  // Costs API は 1 分 10 回まで。まとめて集め直すときに当たるので少し待って取り直す
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await fetch(`https://api.openai.com/v1/organization/costs?${params}`, {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    if (response.status !== 429 || attempt === 3) break;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }
  const body = await response.json();
  if (!response.ok) throw new Error(`openai costs ${response.status}: ${body.error?.message ?? ""}`.slice(0, 160));
  let usd = 0;
  for (const bucket of body.data ?? []) {
    for (const result of bucket.results ?? []) usd += toNumber(result.amount?.value);
  }
  return { usd: round(usd) };
};

var toTokyoText = (seconds) =>
  new Date((seconds + 9 * 3600) * 1000).toISOString().slice(0, 19).replace("T", " ");

/** xAI（Grok）: チームの利用額。範囲は日本時間で渡す（endTime は含まない） */
export var collectXaiCost = async (managementKey, teamId, range) => {
  if (!managementKey || !teamId) return null;
  const response = await fetch(`https://management-api.x.ai/v1/billing/teams/${teamId}/usage`, {
    method: "POST",
    headers: { Authorization: `Bearer ${managementKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      analyticsRequest: {
        timeRange: { startTime: toTokyoText(range.start), endTime: toTokyoText(range.end), timezone: "Asia/Tokyo" },
        timeUnit: "TIME_UNIT_NONE",
        values: [{ name: "usd", aggregation: "AGGREGATION_SUM" }],
        groupBy: ["description"],
        filters: [],
      },
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`xai usage ${response.status}: ${JSON.stringify(body).slice(0, 120)}`);
  let usd = 0;
  const byModel = {};
  for (const series of body.timeSeries ?? []) {
    const value = (series.dataPoints ?? []).reduce((total, point) => total + toNumber(point.values?.[0]), 0);
    usd += value;
    if (value >= 0.001) byModel[series.group?.[0] ?? "?"] = round(value);
  }
  return { usd: round(usd), byModel };
};

/** 1 ドルの円（無料の為替 API。取れなければ前の値か 155） */
export var fetchUsdJpy = async () => {
  const response = await fetch("https://open.er-api.com/v6/latest/USD");
  const body = await response.json();
  const rate = toNumber(body?.rates?.JPY);
  if (!(rate > 50 && rate < 500)) throw new Error("fx: bad rate");
  return rate;
};

/**
 * 1 日（または今日のここまで）の費用。day は日本時間の日付（OpenAI の区切りに使う）
 * 返り値の jpy が円の合計。各サービスの jpy も付ける
 */
export var collectCosts = async (env, day, range, options = {}) => {
  const errors = [];
  const safe = async (name, run) => {
    try {
      return await run();
    } catch (error) {
      errors.push(`${name}: ${String(error?.message ?? error).slice(0, 200)}`);
      return null;
    }
  };
  const [fx, cloudflare, runpod, google, openai, xai] = await Promise.all([
    options.fxUsdJpy ? options.fxUsdJpy : safe("fx", fetchUsdJpy),
    safe("cloudflare", () => collectCloudflareCost(env.CF_BILLING_TOKEN, range)),
    safe("runpod", () => collectRunpodCost(env.RUNPOD_API_KEY, range)),
    safe("google", () => collectGoogleCost(env.GCP_BILLING_SA_JSON, range)),
    options.skipOpenai ? null : safe("openai", () => collectOpenaiCost(env.OPENAI_ADMIN_KEY, day)),
    safe("xai", () => collectXaiCost(env.XAI_MANAGEMENT_KEY, env.XAI_TEAM_ID, range)),
  ]);
  const fxUsdJpy = fx ?? FALLBACK_USD_JPY;
  const toJpy = (usd) => Math.round(usd * fxUsdJpy);
  const items = {};
  if (cloudflare) items.cloudflare = { ...cloudflare, jpy: toJpy(cloudflare.usd) };
  if (runpod) items.runpod = { ...runpod, jpy: toJpy(runpod.usd) };
  if (google) {
    const jpy = google.currency === "USD" ? toJpy(google.amount) : Math.round(google.amount);
    items.google = { ...google, jpy };
  }
  if (openai) items.openai = { ...openai, jpy: toJpy(openai.usd) };
  if (xai) items.xai = { ...xai, jpy: toJpy(xai.usd) };
  const jpy = Object.values(items).reduce((total, item) => total + toNumber(item.jpy), 0);
  return { fxUsdJpy, jpy, items, errors };
};
