// 操作の記録の日別のまとめ: 生のイベント（Analytics Engine の JSONEachRow）→ D1 のまとめと R2 の生データ、読み出しの API
import assert from "node:assert/strict"
import { gunzipSync } from "node:zlib"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { app } = await import(`${API}/app.ts`)
const { summarizeEvents, rollupEventDay, archiveKeyOf } = await import(`${API}/lib/event-log.ts`)

import { createTestD1 } from "./d1.mts"
const d1 = await createTestD1()
const db = d1.db

const row = (over: Record<string, unknown>) => ({
  ts: 1764255600,
  event: "page_view",
  source: "",
  page: "top",
  path: "/",
  referrer: "",
  sid: "s1",
  user: "",
  auth: "out",
  device: "mobile",
  os: "ios",
  lang: "ja",
  country: "JP",
  traffic: "ok",
  extra: "",
  visit: "",
  value: 0,
  client_ms: 0,
  weight: 1,
  ...over,
})

// s1: google から作品ページに来て生成画面で生成 → コイン不足 → プラン → 決済 → 課金（ログインは途中から）
// s2: 直接トップに来て 1 ページで離脱
// s3: データセンターからの通信（数えない）
const rows = [
  row({ sid: "s1", page: "post", path: "/posts/1", referrer: "google", client_ms: 1000 }),
  row({ sid: "s1", page: "generation", path: "/generation", referrer: "nav:post", client_ms: 2000, auth: "in", user: "u1" }),
  row({ sid: "s1", event: "generate_success", page: "generation", path: "/generation", client_ms: 3000, auth: "in", user: "u1" }),
  row({ sid: "s1", event: "shortage_view", source: "free", page: "generation", path: "/generation", client_ms: 4000, auth: "in", user: "u1" }),
  row({ sid: "s1", event: "shortage_plans", source: "free", page: "generation", path: "/generation", client_ms: 5000, auth: "in", user: "u1" }),
  // 届いた順は前後しても、ブラウザの時刻で並べ直す
  row({ sid: "s1", event: "purchase", page: "plus", path: "/plus/success", client_ms: 8000, auth: "in", user: "u1" }),
  row({ sid: "s1", event: "begin_checkout", page: "plus", path: "/plus", client_ms: 7000, auth: "in", user: "u1" }),
  row({ sid: "s1", page: "plus", path: "/plus", referrer: "nav:generation", client_ms: 6000, auth: "in", user: "u1" }),
  row({ sid: "s2", page: "top", path: "/", referrer: "direct", client_ms: 1000, device: "desktop" }),
  row({ sid: "s3", traffic: "dc" }),
]

const summary = summarizeEvents(rows)
assert.deepEqual(summary.totals, { events: 9, dcEvents: 1, sessions: 2, users: 1 })
const funnel = (name: string) => summary.funnels.filter((f: any) => f.funnel === name).map((f: any) => f.sessions)
assert.deepEqual(funnel("generate_to_paid"), [1, 1, 1, 1, 1, 1])
assert.deepEqual(funnel("coin_shortage"), [1, 1, 1, 1])
assert.deepEqual(funnel("visit_to_generate"), [2, 1, 1])
assert.deepEqual(funnel("plus_page"), [1, 1, 1])
assert.deepEqual(funnel("signup"), [2, 0, 0, 0])
const page = (name: string) => summary.pages.find((p: any) => p.page === name)
assert.deepEqual(page("post"), { page: "post", views: 1, sessions: 1, entries: 1, exits: 0, bounces: 0 })
// s1 の最後の表示は /plus（purchase は page_view ではない）
assert.equal(page("plus").exits, 1)
assert.deepEqual(page("top"), { page: "top", views: 1, sessions: 1, entries: 1, exits: 1, bounces: 1 })
assert.deepEqual(
  summary.entries.sort((a: any, b: any) => a.referrer.localeCompare(b.referrer)),
  [
    { referrer: "direct", page: "top", device: "desktop", sessions: 1, bounces: 1 },
    { referrer: "google", page: "post", device: "mobile", sessions: 1, bounces: 0 },
  ],
)
// 最初の表示はログイン前でも、同じセッションの人として数える
const firstView = summary.events.find((e: any) => e.event === "page_view" && e.page === "post")
assert.equal(firstView.users, 1)

// 流入元ごとのサブスクまでの到達: いちばん先まで進んだ段階まで数える（順番は問わない）
const sourceRows = [
  // google → 作品 → 生成画面 → コイン不足 → プラン → 決済 → 有料プラン
  ...rows.slice(0, 8).map((r) => (r.event === "purchase" ? { ...r, extra: '{"item":"pass"}' } : r)),
  // direct で 1 ページだけ（サイドバーのプランのリンク・広告枠が出ただけでは回遊・案内を見たに数えない）
  rows[8],
  row({ sid: "s2", event: "plus_nav_view", source: "sidebar", page: "top", path: "/", client_ms: 1100, device: "desktop" }),
  row({ sid: "s2", event: "dlsite_view", source: "r_post_side", page: "top", path: "/", client_ms: 1200, device: "desktop" }),
  // x からプランのページに直接来てお試しを始めた
  row({ sid: "s4", page: "plus", path: "/plus", referrer: "x", client_ms: 1000 }),
  row({ sid: "s4", event: "trial_checkout", source: "plus", page: "plus", path: "/plus", client_ms: 2000, auth: "in", user: "u4" }),
  row({ sid: "s4", event: "trial_started", source: "success", page: "plus", path: "/plus/success", client_ms: 3000, auth: "in", user: "u4" }),
  // x から来てコインだけ買った（サブスクに数えない。決済もコインは数えない）
  row({ sid: "s5", page: "post", path: "/posts/2", referrer: "x", client_ms: 1000 }),
  row({ sid: "s5", event: "shortage_view", page: "generation", path: "/generation", client_ms: 2000 }),
  row({ sid: "s5", event: "begin_checkout", page: "generation", path: "/generation", client_ms: 3000, extra: '{"item":"coins"}' }),
  row({ sid: "s5", event: "purchase", page: "generation", path: "/generation", client_ms: 4000, extra: '{"item":"coins"}' }),
  // 30 分空いてサイト内の移動から始まったセッションは internal
  row({ sid: "s6", page: "post", path: "/posts/3", referrer: "nav:top", client_ms: 1000 }),
]
const sourceSummary = summarizeEvents(sourceRows)
const sourceSteps = (referrer: string) =>
  sourceSummary.sources
    .filter((r: any) => r.referrer === referrer)
    .map((r: any) => [r.stepName, r.sessions])
assert.deepEqual(sourceSteps("google"), [
  ["visit", 1], ["explore", 1], ["upsell_view", 1], ["plan", 1], ["checkout", 1], ["subscribe", 1], ["pass", 1],
])
assert.deepEqual(sourceSteps("direct"), [
  ["visit", 1], ["explore", 0], ["upsell_view", 0], ["plan", 0], ["checkout", 0], ["subscribe", 0],
])
assert.deepEqual(sourceSteps("x"), [
  ["visit", 2], ["explore", 2], ["upsell_view", 2], ["plan", 1], ["checkout", 1], ["subscribe", 1], ["trial", 1],
])
assert.deepEqual(sourceSteps("internal").map((r: any[]) => r[1]), [1, 0, 0, 0, 0, 0])

// rollup: SQL API と R2 の代わり
const day = "2026-11-27"
const lines = rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
const sqls: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  const sql = String(init.body)
  sqls.push(sql)
  // 最初の 1 時間だけデータがある
  return new Response(sqls.length === 1 ? lines : "", { status: 200 })
}) as typeof fetch
const stored = new Map<string, { body: ArrayBuffer; options: any }>()
const bucket = { put: async (key: string, body: ArrayBuffer, options: any) => stored.set(key, { body, options }) }
const env: Record<string, unknown> = {
  DB: d1.DB,
  GENLOG: d1.GENLOG,
  INTERNAL_API_TOKEN: "internal",
  ANALYTICS_READ_TOKEN: "analytics",
  CF_ANALYTICS_TOKEN: "cf",
  EVENT_ARCHIVE: bucket,
}
const result = await rollupEventDay(env, db, day)
globalThis.fetch = realFetch
assert.equal(result.rows, 10)
assert.equal(sqls.length, 24)
assert.match(sqls[0], /FROM aipictors_events/)
assert.match(sqls[0], /timestamp >= toDateTime\('2026-11-26 15:00:00'\)/)
assert.match(sqls[23], /timestamp < toDateTime\('2026-11-27 15:00:00'\)/)
assert.equal(result.archiveKey, archiveKeyOf(day))
assert.equal(result.archiveKey, "events/2026/11/27.ndjson.gz")
const archived = gunzipSync(Buffer.from(stored.get(result.archiveKey)!.body)).toString()
assert.equal(archived, lines)

const funnelRows = await db.query("SELECT step_name, sessions, users FROM event_funnel_daily WHERE day = $1 AND funnel = 'generate_to_paid' ORDER BY step", [day])
assert.deepEqual(funnelRows.map((r: any) => [r.step_name, r.sessions, r.users]), [
  ["generation_view", 1, 1],
  ["generate", 1, 1],
  ["upsell_view", 1, 1],
  ["upsell_click", 1, 1],
  ["checkout", 1, 1],
  ["paid", 1, 1],
])

// 作り直しても重ならない
globalThis.fetch = (async () => new Response(lines, { status: 200 })) as typeof fetch
await rollupEventDay(env, db, day)
let pv = await db.query("SELECT SUM(events) AS n FROM event_daily WHERE day = $1 AND event = 'page_view'", [day])
// 24 回とも同じ行が返るので 24 倍。まとめは毎回消してから入れ直す
assert.equal(Number(pv[0].n), 4 * 24)
await rollupEventDay(env, db, day).then(() => null)
pv = await db.query("SELECT SUM(events) AS n FROM event_daily WHERE day = $1 AND event = 'page_view'", [day])
assert.equal(Number(pv[0].n), 4 * 24)
// 生が無い日は上書きしない
globalThis.fetch = (async () => new Response("", { status: 200 })) as typeof fetch
assert.equal((await rollupEventDay(env, db, day)).skipped, "no rows")
pv = await db.query("SELECT SUM(events) AS n FROM event_daily WHERE day = $1 AND event = 'page_view'", [day])
assert.equal(Number(pv[0].n), 4 * 24)
globalThis.fetch = realFetch
// 1 回目の結果に戻す
globalThis.fetch = (async (_u: string, init: RequestInit) => new Response(String(init.body).includes("15:00:00') AND timestamp < toDateTime('2026-11-26 16") ? lines : "", { status: 200 })) as typeof fetch
await rollupEventDay(env, db, day)
globalThis.fetch = realFetch

const call = async (path: string, token = "analytics") => {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, { headers: { authorization: `Bearer ${token}` } }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  )
  return { status: res.status, body: (await res.json()) as any }
}

let res = await call(`/internal/analytics/events?from=${day}&to=${day}&kind=funnels`)
assert.equal(res.status, 200)
assert.equal(res.body.rows.filter((r: any) => r.funnel === "coin_shortage").length, 4)
res = await call(`/internal/analytics/events?from=${day}&to=${day}&event=shortage`)
assert.deepEqual(
  res.body.rows.map((r: any) => [r.event, r.source, r.events]),
  [
    ["shortage_plans", "free", 1],
    ["shortage_view", "free", 1],
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
)
res = await call(`/internal/analytics/events?from=${day}&to=${day}&kind=sources`)
assert.equal(res.status, 200)
// rows の purchase は item が無いのでサブスクには数えない（決済を始めたところまで）
assert.deepEqual(
  res.body.rows.filter((r: any) => r.referrer === "google").map((r: any) => [r.step_name, r.sessions, r.users, r.days]),
  [
    ["visit", 1, 1, 1],
    ["explore", 1, 1, 1],
    ["upsell_view", 1, 1, 1],
    ["plan", 1, 1, 1],
    ["checkout", 1, 1, 1],
    ["subscribe", 0, 0, 1],
  ],
)
assert.equal(res.body.rows.filter((r: any) => r.referrer === "direct" && r.device === "desktop").length, 6)
res = await call(`/internal/analytics/events?from=${day}&to=${day}&kind=runs`)
assert.equal(res.body.rows[0].events, 9)
assert.equal(res.body.rows[0].dc_events, 1)
res = await call(`/internal/analytics/events?kind=bad`)
assert.equal(res.status, 400)
res = await call(`/internal/analytics/events`, "wrong")
assert.equal(res.status, 401)

await d1.dispose()
console.log("event-log ok")
