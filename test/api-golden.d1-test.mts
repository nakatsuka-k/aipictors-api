// D1（Miniflare）に対して HTTP の入口からリクエストを流し、応答を test/fixtures/api-golden.json と比べる。
// 分割・整理で応答が変わっていないことの確認用。ルート一覧も test/fixtures/routes.json と比べる。
// クエリ回数と往復の段数（同時に投げた文は 1 段）は UPDATE_GOLDEN=1 のとき test/fixtures/query-counts.json に書き出す（比べない。速度改善の記録。段数は実行のタイミングで少し揺れる）。
//
//   作り直し（応答を意図して変えたときだけ）: UPDATE_GOLDEN=1 npx tsx test/api-golden.pg-test.mts
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname
const UPDATE = process.env.UPDATE_GOLDEN === "1"

const { app } = await import(`${API}/app.ts`)
const d1 = await createTestD1()
const stats = { count: 0, rounds: 0 }
const env = { DB: d1.DB, GENLOG: d1.GENLOG, INTERNAL_API_TOKEN: "internal", ADMIN_API_TOKEN: "admin" }

const NOW = Date.parse("2026-11-04T12:00:00+09:00")
Date.now = () => NOW
const sec = Math.floor(NOW / 1000)
const originalLog = console.log
const originalWarn = console.warn
console.warn = () => {}

const normalize = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, v) => {
      if (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return "<uuid>"
      if (key === "id" && typeof v === "string" && /^[0-9a-z]{12}$/.test(v)) return "<model-id>"
      if (key === "modelId" || key === "uploadId") return `<${key}>`
      if ((key === "created_at" || key === "updated_at") && typeof v === "string") return `<${key}>` // DB の NOW()
      if (typeof v === "string" && /user_[0-9a-z]{12}/.test(v)) return v.replace(/user_[0-9a-z]{12}/g, "user_<model-id>")
      return v
    }),
  )

const fakeBucket = {
  createMultipartUpload: async (key: string) => ({ key, uploadId: "upload" }),
  resumeMultipartUpload: () => ({ abort: async () => {}, complete: async () => ({}), uploadPart: async () => ({ partNumber: 1, etag: "e" }) }),
  head: async () => null,
  get: async () => null,
  delete: async () => {},
}

type Req = { name: string; method?: string; path: string; body?: unknown; token?: string | null }

const internal = (name: string, method: string, path: string, body?: unknown): Req => ({ name, method, path, body })

const sha = "a".repeat(64)
const requests: Req[] = [
  { name: "healthz", path: "/healthz", token: null },
  { name: "notFound", path: "/no-such-path", token: null },
  { name: "unauthorized", path: "/internal/coins/1", token: "wrong" },

  // コイン
  internal("coins summary empty", "GET", "/internal/coins/100"),
  internal("coins grant", "POST", "/internal/coins/grant", { userId: "100", freeCoins: 100, premiumCoins: 50, reason: "test", source: "test:1" }),
  internal("coins summary ledger", "GET", "/internal/coins/100?includeLedger=1&includeExpiringLots=1"),
  internal("coins invalid paging", "GET", "/internal/coins/100?includeLedgerLimit=x"),
  internal("coins ensure-initial-grant free", "POST", "/internal/coins/ensure-initial-grant", { userId: "101", includeLedger: true, includeExpiringLots: true }),
  internal("coins ensure-initial-grant again", "POST", "/internal/coins/ensure-initial-grant", { userId: "101", planType: "STANDARD" }),
  internal("coins consume", "POST", "/internal/coins/consume", { userId: "100", amount: 30, reason: "image-generation:txt2img", source: "task:a" }),
  internal("coins consume insufficient", "POST", "/internal/coins/consume", { userId: "100", amount: 100000, reason: "x", source: "task:b" }),
  internal("coins consume invalid", "POST", "/internal/coins/consume", { userId: "100", amount: -1 }),
  internal("coins consume-breakdown", "POST", "/internal/coins/consume-breakdown", { userId: "100", source: "task:a" }),
  internal("coins bulk-adjust", "POST", "/internal/coins/bulk-adjust", { userIds: ["100", "102"], freeDelta: 10, reason: "bulk", source: "bulk:1" }),
  internal("coins gemini-allowance", "GET", "/internal/coins/gemini-allowance/100"),
  internal("coins admin-history", "GET", "/internal/coins/admin-history?userId=100&limit=5"),
  internal("coins daily runs", "GET", "/internal/coins/daily-job/runs"),
  internal("coins daily run", "POST", "/internal/coins/daily-job/run"),

  // 感謝
  internal("support transfer", "POST", "/internal/coins/support", { senderUserId: "100", recipientUserId: "103", coinType: "FREE", amount: 10, source: "s1" }),
  internal("support transfer premium anon", "POST", "/internal/coins/support", { senderUserId: "100", recipientUserId: "103", coinType: "PREMIUM", amount: 10, source: "s2", isAnonymous: true }),
  internal("support to self", "POST", "/internal/coins/support", { senderUserId: "100", recipientUserId: "100", coinType: "FREE", amount: 1 }),
  internal("support rankings", "GET", "/internal/coins/support/rankings?kind=received"),
  internal("support rankings sent", "GET", "/internal/coins/support/rankings?kind=sent"),
  internal("support rankings recipient", "GET", "/internal/coins/support/rankings?kind=sent&recipientUserId=103"),
  internal("support period weekly", "GET", "/internal/coins/support/rankings-period?kind=received&period=weekly&periodKey=2026-11-02"),
  internal("support period monthly", "GET", "/internal/coins/support/rankings-period?kind=sent&period=monthly&periodKey=2026-11"),
  internal("support weeks", "GET", "/internal/coins/support/weeks"),
  internal("support recent", "GET", "/internal/coins/support/recent?limit=5"),
  internal("support summary", "GET", "/internal/coins/support/summary/103"),
  internal("support totals", "GET", "/internal/coins/support/totals/103"),
  { name: "public rankings", path: "/api/coins/support/rankings/public?kind=received&limit=3", token: null },
  internal("support revert", "POST", "/internal/coins/support/revert", { senderUserId: "100", recipientUserId: "103", source: "s1" }),
  internal("grant-support", "POST", "/internal/coins/grant-support", { recipientUserId: "104", amount: 5, senderUserId: "1", coinType: "PREMIUM" }),
  internal("amazon list", "GET", "/internal/coins/amazon-exchange?userId=100"),
  internal("amazon admin", "GET", "/internal/coins/amazon-exchange/admin"),

  // サブスク
  internal("sub current none", "GET", "/internal/subscriptions/current/200"),
  internal("sub upsert", "POST", "/internal/subscriptions/upsert", {
    nanoid: "sub-200",
    userId: "200",
    type: "STANDARD",
    status: "active",
    isDisabled: false,
    createdAt: sec - 1000,
    currentPeriodStart: sec - 1000,
    currentPeriodEnd: 4102444800,
    trialStart: null,
    trialEnd: null,
    stripeSubscriptionId: "sub_test_200",
    stripeLatestInvoiceId: null,
    stripePaymentIntentId: null,
    stripeSubscriptionItemId: null,
    stripePriceId: null,
    stripeProductId: null,
  }),
  internal("sub current", "GET", "/internal/subscriptions/current/200"),
  internal("sub by nanoid", "GET", "/internal/subscriptions/by-nanoid/sub-200"),
  internal("sub has previous", "GET", "/internal/subscriptions/has-previous/200"),
  internal("sub unpaid", "GET", "/internal/subscriptions/unpaid/200"),
  internal("sub disable invalid", "POST", "/internal/subscriptions/disable", {}),

  // ポイント・料金
  internal("points get", "GET", "/internal/points/300"),
  internal("points grant", "POST", "/internal/points/grant", { userId: "300", points: 100, reason: "test" }),
  internal("points consume", "POST", "/internal/points/consume", { userId: "300", points: 10, reason: "test" }),
  { name: "admin pricing", path: "/admin/pricing", token: "admin" },
  { name: "admin pricing unauthorized", path: "/admin/pricing", token: "wrong" },

  // 生成のキュー
  internal("tasks create", "POST", "/internal/image-generation/tasks/create", {
    nanoid: "task-1",
    userId: 400,
    requestOriginContent: "",
    requestContent: "{}",
    type: "txt2img",
    status: "wait",
    priority: 0,
    requestTime: "2026-11-04T12:00:00",
    platform: "web",
    sd: 3,
    cost: 100,
    uuid: "11111111-1111-4111-8111-111111111111",
    count: 2,
  }),
  internal("tasks by nanoid", "GET", "/internal/image-generation/tasks/by-nanoid/task-1"),
  internal("tasks count", "GET", "/internal/image-generation/tasks/count/400?status=wait&status=generating"),
  internal("tasks cost", "GET", "/internal/image-generation/tasks/cost/400?fromDate=2026-11-01T00:00:00Z&status=wait"),
  internal("tasks list", "GET", "/internal/image-generation/tasks?userId=400&take=5&skip=0"),
  internal("tasks cancelable", "GET", "/internal/image-generation/tasks/cancelable/task-1?userId=400"),
  internal("results list", "GET", "/internal/image-generation/results?userId=400&take=5&skip=0"),
  internal("results count", "GET", "/internal/image-generation/results/count/400?fromDate=2026-11-01T00:00:00Z"),
  internal("results protected", "GET", "/internal/image-generation/results/protected-count/400"),
  internal("reserved latest", "GET", "/internal/image-generation/reserved-tasks/latest/400"),
  internal("reserved count", "GET", "/internal/image-generation/reserved-tasks/count/400"),

  // ユーザーモデル
  internal("models list empty", "GET", "/internal/user-models"),
  internal("models create", "POST", "/internal/user-models/uploads", {
    thumbnailUrl: "https://example.com/t.png",
    userId: "500",
    kind: "LORA",
    baseModel: "SDXL",
    rating: "G",
    name: "テスト",
    sha256: sha,
    sizeBytes: 1024,
    filename: "a.safetensors",
  }),
  internal("models mine", "GET", "/internal/user-models/mine/500"),
  internal("models bad id", "GET", "/internal/user-models/!!"),
  internal("models reports", "GET", "/internal/user-models/reports"),

  // サポートと告知
  internal("support thread", "POST", "/internal/support/thread", { userId: "600" }),
  internal("support unread", "POST", "/internal/support/unread", { userId: "600" }),
  internal("support admin tickets", "POST", "/internal/support/admin/tickets", {}),
  { name: "email unsubscribe invalid", path: "/email/unsubscribe", token: null },
]

const results: Record<string, unknown> = {}
const counts: Record<string, { queries: number; rounds: number }> = {}
for (const r of requests) {
  stats.count = 0
  stats.rounds = 0
  const headers: Record<string, string> = {}
  if (r.token !== null) headers.authorization = `Bearer ${r.token ?? "internal"}`
  if (r.body !== undefined) headers["content-type"] = "application/json"
  const res = await app.fetch(
    new Request(`http://api.test${r.path}`, {
      method: r.method ?? "GET",
      headers,
      body: r.body === undefined ? undefined : JSON.stringify(r.body),
    }),
    { ...env, USER_MODELS: fakeBucket },
    { waitUntil: () => {}, passThroughOnException: () => {} },
  )
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // JSON でない応答はそのまま比べる
  }
  results[r.name] = normalize({
    status: res.status,
    contentType: res.headers.get("content-type"),
    cacheControl: res.headers.get("cache-control"),
    body,
  })
  counts[r.name] = { queries: stats.count, rounds: stats.rounds }
}

const routes = (app.routes as Array<{ method: string; path: string }>)
  .filter((route) => route.method !== "ALL")
  .map((route) => `${route.method} ${route.path}`)
  .sort()

await d1.dispose()
console.log = originalLog
console.warn = originalWarn

const goldenPath = `${FIXTURES}api-golden.json`
const routesPath = `${FIXTURES}routes.json`
if (UPDATE) {
  writeFileSync(goldenPath, `${JSON.stringify(results, null, 2)}\n`)
  writeFileSync(routesPath, `${JSON.stringify(routes, null, 2)}\n`)
  console.log(`updated golden: ${Object.keys(results).length} requests, ${routes.length} routes`)
} else {
  assert.deepEqual(routes, JSON.parse(readFileSync(routesPath, "utf8")), "ルート一覧が変わった")
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"))
  const diffs = Object.keys(golden).filter((name) => JSON.stringify(results[name]) !== JSON.stringify(golden[name]))
  for (const name of diffs) {
    console.log(`--- ${name}`)
    try {
      assert.deepEqual(results[name], golden[name])
    } catch (e) {
      console.log(String((e as Error).message).split("\n").slice(0, 40).join("\n"))
    }
  }
  assert.equal(diffs.length, 0, `応答が変わった: ${diffs.join(", ")}`)
  console.log(`${Object.keys(results).length} requests, ${routes.length} routes passed`)
}
process.exit(0)
