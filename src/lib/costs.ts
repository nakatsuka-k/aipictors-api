// @ts-nocheck -- 周りのファイルに合わせて型は付けていない

/**
 * 収支用の費用（日本時間の 1 日、または今日のここまで）
 * - Cloudflare: 使用量 × 定価（無料枠は月の量を 30 で割って日ごとに引く）＋契約（月額は 30 日、年額は 365 日で割る）
 * - RunPod: 請求 API の時間ごとの実額（Pod と保存領域）
 * - Google（Gemini API）: BigQuery の請求エクスポートの実額（クレジット差し引き後）
 * - OpenAI（組織 techpage）: Costs API の実額のうち Aipictors のキーの分だけ。日ごとの区切りが UTC なので、同じ日付の UTC の 1 日分を入れる
 * - xAI（Grok）: 管理 API の利用額（USD）。日本時間の範囲で聞ける
 * どれかが失敗しても取れたところだけ返す（errors に理由）
 */

var ACCOUNT_ID = "7f2a200bf2994f36f45e733751a30be6";
var ZONE_ID = "e24f556403c24f96875f6466349b048f";

/**
 * ほかの Worker から Service Binding で呼ばれる Worker と、外から入るホスト。
 * Service Binding の呼び出しはリクエスト料金がかからないが、実行回数（workersInvocationsAdaptive）には入る
 * （aipictors-api は 1 日 110 万回のほぼすべてが system からの呼び出し）。この Worker の fetch は、ホストへの外からの要求数で数える。
 * 外の入口がない Worker はホストを空にする（0 回）
 */
var BINDING_WORKER_HOSTS = {
  "aipictors-api": ["backend.aipictors.com"],
  "aipictors-system": ["api.aipictors.com"],
  "aipictors-image-tagger": [],
};

/** WAF で止めた要求は Worker まで届かない */
var NOT_REACHING_WORKER = new Set(["block", "managed_challenge", "challenge", "js_challenge", "jschallenge"]);
var GCP_PROJECT = "gen-lang-client-0028298935";
var GCP_DATASET = "billing_export";
var FALLBACK_USD_JPY = 155;

/**
 * OpenAI の組織 techpage はほかの案件・OpenClaw と共用なので、Aipictors のキーだけ数える（キーの id は管理画面の API keys で見る）。
 * OPENAI_AIPICTORS_KEY_IDS（カンマ区切り）で上書きできる
 */
var OPENAI_AIPICTORS_KEY_IDS = ["key_WzzNWEEDQaebONu8"]; // Aipictors-お題提案機能

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
export var cloudflareFixedUsd = async (token, days) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/subscriptions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  if (!body.success) throw new Error(`cloudflare subscriptions: ${JSON.stringify(body.errors).slice(0, 120)}`);
  const plans = {};
  let usd = 0;
  for (const sub of body.result ?? []) {
    const price = toNumber(sub.price);
    // 解約して期間が終わった契約（Pro は 2026-11-19 で更新しない）は state が空になり、次の請求日もない
    if (!price || sub.currency !== "USD" || sub.state !== "Paid") continue;
    const perDay = sub.frequency === "yearly" ? price / 365 : price / 30;
    plans[sub.rate_plan?.public_name ?? sub.id] = round(perDay * days);
    usd += perDay * days;
  }
  return { usd, plans };
};

/**
 * 課金される Workers のリクエスト数。Service Binding で呼ばれる Worker の fetch を、ホストへの外からの要求数に置き換える。
 * ゾーンを読めなければ null（呼び出し側は全部の実行回数で数える）
 */
var billableWorkerRequests = async (token, variables, invocations) => {
  const hosts = [...new Set(Object.values(BINDING_WORKER_HOSTS).flat())];
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($z: String!, $s: Time!, $e: Time!, $h: [string!]) { viewer { zones(filter: { zoneTag: $z }) {
        http: httpRequestsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $s, datetime_lt: $e, clientRequestHTTPHost_in: $h }) {
          count dimensions { clientRequestHTTPHost securityAction }
        }
      } } }`,
      variables: { z: ZONE_ID, s: variables.s, e: variables.e, h: hosts },
    }),
  });
  const body = await response.json();
  if (body.errors?.length) throw new Error(`cloudflare zone graphql: ${body.errors[0].message}`);
  const external = {};
  for (const row of body.data?.viewer?.zones?.[0]?.http ?? []) {
    if (NOT_REACHING_WORKER.has(row.dimensions.securityAction)) continue;
    external[row.dimensions.clientRequestHTTPHost] = (external[row.dimensions.clientRequestHTTPHost] ?? 0) + toNumber(row.count);
  }
  let total = 0;
  for (const row of invocations ?? []) {
    const hostsOf = BINDING_WORKER_HOSTS[row.dimensions?.scriptName];
    if (hostsOf && row.dimensions?.eventType === "fetch") continue;
    total += toNumber(row.sum.requests);
  }
  for (const host of hosts) total += external[host] ?? 0;
  return total;
};

/**
 * Containers（pictorchan-bot・自動判定の image-tagger）。割り当てたメモリ・ディスクの時間と、実際に使った CPU の時間で数える
 * （メモリ $0.0000025/GiB 秒・無料 25 GiB 時間、CPU $0.00002/vCPU 秒・無料 375 vCPU 分、ディスク $0.00000007/GB 秒・無料 200 GB 時間。月あたり）
 */
var collectContainersCost = async (token, variables, days) => {
  const usage = await cloudflareGraphql(
    token,
    `query($a: String!, $s: Time!, $e: Time!) { viewer { accounts(filter: { accountTag: $a }) {
      containers: cloudchamberMetricsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $s, datetime_lt: $e }) { sum { allocatedMemory allocatedDisk cpuTimeSec } }
    } } }`,
    variables
  );
  const rows = usage.containers ?? [];
  const memoryGibSeconds = rows.reduce((total, row) => total + toNumber(row.sum.allocatedMemory), 0) / 2 ** 30;
  const diskGbSeconds = rows.reduce((total, row) => total + toNumber(row.sum.allocatedDisk), 0) / 1e9;
  const cpuSeconds = rows.reduce((total, row) => total + toNumber(row.sum.cpuTimeSec), 0);
  const usd =
    over(memoryGibSeconds, 25 * 3600, days) * 0.0000025 +
    over(cpuSeconds, 375 * 60, days) * 0.00002 +
    over(diskGbSeconds, 200 * 3600, days) * 0.00000007;
  return { usd, memoryGibHours: memoryGibSeconds / 3600, cpuSeconds };
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
      workers: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $s, datetime_lt: $e }) { sum { requests cpuTimeUs } dimensions { scriptName eventType } }
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

  const [fixed, minutes, billableRequests, containerUsage] = await Promise.all([
    cloudflareFixedUsd(token, days),
    streamMinutesViewed(token, range).catch(() => 0),
    billableWorkerRequests(token, variables, usage.workers).catch(() => null),
    collectContainersCost(token, variables, days).catch(() => null),
  ]);
  const workers = (over(billableRequests ?? workerRequests, 10e6, days) * 0.3 + over(workerCpuMs, 30e6, days) * 0.02) / 1e6;

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

  const stream = minutes / 1000;
  const containers = containerUsage?.usd ?? 0;

  const detail = {
    workers: round(workers),
    r2Ops: round(r2Ops),
    r2Storage: round(r2Storage),
    d1: round(d1),
    durableObjects: round(durableObjects),
    kv: round(kv),
    stream: round(stream),
    containers: round(containers),
    plans: round(fixed.usd),
  };
  const usd = workers + r2Ops + r2Storage + d1 + durableObjects + kv + stream + containers + fixed.usd;
  return {
    usd: round(usd),
    detail,
    plans: fixed.plans,
    usage: {
      workerRequests,
      workerRequestsBillable: billableRequests,
      workerCpuMs: Math.round(workerCpuMs),
      r2Gb: round(r2Gb, 1),
      d1Read,
      d1Written,
      streamMinutes: minutes,
      containerMemoryGibHours: containerUsage ? round(containerUsage.memoryGibHours, 1) : null,
      containerCpuSeconds: containerUsage ? Math.round(containerUsage.cpuSeconds) : null,
    },
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
  // REST v1（rest.runpod.io）は 2026-11-15 で終了。v2 は配列を { records: [...] } で包み、金額は totalAmount
  const get = async (path) => {
    const response = await fetch(`https://api.runpod.io/v2/billing/${path}?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`runpod ${path} ${response.status}`);
    return (await response.json()).records;
  };
  const [pods, volumes] = await Promise.all([get("pods"), get("network-volumes")]);
  const byPod = {};
  let podUsd = 0;
  for (const row of pods ?? []) {
    const amount = toNumber(row.totalAmount);
    podUsd += amount;
    byPod[row.podId] = round((byPod[row.podId] ?? 0) + amount);
  }
  const volumeUsd = (volumes ?? []).reduce((total, row) => total + toNumber(row.totalAmount), 0);
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

/**
 * OpenAI: Aipictors のキーの費用（Costs API は UTC の 1 日ごと）。otherUsd は組織のほかのキーの分（合計には入れない）
 */
export var collectOpenaiCost = async (adminKey, day, keyIds = OPENAI_AIPICTORS_KEY_IDS) => {
  if (!adminKey) return null;
  const start = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  const params = new URLSearchParams({ start_time: String(start), end_time: String(start + 86400), bucket_width: "1d", limit: "1", group_by: "api_key_id" });
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
  const ours = new Set(keyIds);
  let usd = 0;
  let otherUsd = 0;
  for (const bucket of body.data ?? []) {
    for (const result of bucket.results ?? []) {
      if (ours.has(result.api_key_id)) usd += toNumber(result.amount?.value);
      else otherUsd += toNumber(result.amount?.value);
    }
  }
  return { usd: round(usd), otherUsd: round(otherUsd), keyIds: [...ours] };
};

var openaiKeyIds = (env) => {
  const ids = String(env.OPENAI_AIPICTORS_KEY_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  return ids.length ? ids : OPENAI_AIPICTORS_KEY_IDS;
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
  // options.only: 指定したサービスだけ取る（集め直し用）
  const want = (name) => !options.only || options.only.includes(name);
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
    want("cloudflare") ? safe("cloudflare", () => collectCloudflareCost(env.CF_BILLING_TOKEN, range)) : null,
    want("runpod") ? safe("runpod", () => collectRunpodCost(env.RUNPOD_API_KEY, range)) : null,
    want("google") ? safe("google", () => collectGoogleCost(env.GCP_BILLING_SA_JSON, range)) : null,
    options.skipOpenai || !want("openai") ? null : safe("openai", () => collectOpenaiCost(env.OPENAI_ADMIN_KEY, day, openaiKeyIds(env))),
    want("xai") ? safe("xai", () => collectXaiCost(env.XAI_MANAGEMENT_KEY, env.XAI_TEAM_ID, range)) : null,
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
