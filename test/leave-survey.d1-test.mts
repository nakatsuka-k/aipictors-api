// 解約・退会の理由の深掘り: 追加質問の保存（知らない形は捨てる）・解約の理由だけを残す API・退会の理由・分析の集計
import assert from "node:assert/strict"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { app } = await import(`${API}/app.ts`)
const { sanitizeLeaveDetails } = await import(`${API}/lib/leave-survey.ts`)

import { createTestD1 } from "./d1.mts"
const d1 = await createTestD1()
const db = d1.db
const env: Record<string, unknown> = { DB: d1.DB, GENLOG: d1.GENLOG, INTERNAL_API_TOKEN: "internal", ANALYTICS_READ_TOKEN: "analytics" }

const call = async (method: string, path: string, body?: unknown, token = "internal") => {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  )
  return { status: res.status, body: (await res.json()) as any }
}

// 形の確認
assert.equal(sanitizeLeaveDetails(null), null)
assert.equal(sanitizeLeaveDetails({}), null)
assert.deepEqual(
  sanitizeLeaveDetails({
    choices: { why: ["no_time", "no_time", "BAD KEY", 3, "how_to"], "bad group": ["x"], empty: [] },
    text: "  ",
    improvement: " もっとモデルを ",
    source: "ios",
  }),
  { choices: { why: ["no_time", "how_to"] }, improvement: "もっとモデルを", source: "ios" },
)
assert.equal(sanitizeLeaveDetails({ text: "あ".repeat(900) }).text.length, 500)

const now = Math.floor(Date.now() / 1000)
await db.execute(
  `INSERT INTO subscriptions(nanoid, user_id, type, status, is_disabled, created_at, current_period_start, current_period_end, stripe_subscription_id)
   VALUES ('n1', '10', 'STANDARD', 'active', FALSE, $1, $1, $2, 'sub_store_1')`,
  [now - 45 * 86400, now + 10 * 86400],
)

// 解約の理由だけを残す（アプリのストア課金）
let res = await call("POST", "/internal/subscriptions/cancel-reason", {
  userId: "10",
  reason: "quality",
  reasonNote: null,
  reasonDetails: { choices: { problem: ["face_hand", "feature"], feature: ["inpaint"] }, improvement: "手をきれいに", source: "ios" },
})
assert.equal(res.status, 200)
let rows = await db.query("SELECT user_id, pass_type, reason, months, details FROM subscription_cancel_reasons")
assert.equal(rows.length, 1)
assert.equal(rows[0].pass_type, "STANDARD")
assert.equal(rows[0].months, 1.5)
assert.deepEqual(JSON.parse(rows[0].details), {
  choices: { problem: ["face_hand", "feature"], feature: ["inpaint"] },
  improvement: "手をきれいに",
  source: "ios",
})

// 理由が無い・知らない理由は残さない
res = await call("POST", "/internal/subscriptions/cancel-reason", { userId: "10", reason: "unknown" })
assert.equal(res.status, 200)
assert.equal((await db.query("SELECT id FROM subscription_cancel_reasons")).length, 1)

// 古い画面（details なし）も今まで通り
res = await call("POST", "/internal/subscriptions/cancel-reason", { userId: "11", reason: "other", reasonNote: "引っ越しで忙しい" })
assert.equal(res.status, 200)
rows = await db.query("SELECT reason, note, details, pass_type FROM subscription_cancel_reasons WHERE user_id = '11'")
assert.deepEqual(rows[0], { reason: "other", note: "引っ越しで忙しい", details: null, pass_type: null })

// 退会の理由
res = await call("POST", "/internal/users/20/leave-reason", {
  reason: "privacy",
  outcome: "pause",
  details: { choices: { what: ["known"] }, source: "web" },
})
assert.equal(res.status, 200)
res = await call("POST", "/internal/users/21/leave-reason", { reason: "other", outcome: "withdraw", note: "しばらく離れます" })
assert.equal(res.status, 200)
res = await call("POST", "/internal/users/21/leave-reason", { reason: "nope" })
assert.equal(res.status, 400)
res = await call("POST", "/internal/users/abc/leave-reason", { reason: "other" })
assert.equal(res.status, 400)
// 内部トークンが要る
res = await call("POST", "/internal/users/21/leave-reason", { reason: "other" }, "analytics")
assert.equal(res.status, 401)

// 集計（分析用のトークンでも読める）
res = await call("GET", "/internal/analytics/leave-reasons?days=30", undefined, "analytics")
assert.equal(res.status, 200)
assert.equal(res.body.subscription.total, 2)
assert.equal(res.body.subscription.withDetails, 1)
assert.deepEqual(
  res.body.subscription.choices.map((c: any) => `${c.reason}.${c.group}.${c.key}=${c.count}`).sort(),
  ["quality.feature.inpaint=1", "quality.problem.face_hand=1", "quality.problem.feature=1"],
)
assert.equal(res.body.subscription.texts.length, 2)
assert.equal(res.body.account.total, 2)
assert.deepEqual(
  res.body.account.summary.map((s: any) => [s.reason, s.outcomes]).sort(),
  [
    ["other", { withdraw: 1 }],
    ["privacy", { pause: 1 }],
  ],
)
assert.equal(res.body.account.texts[0].note, "しばらく離れます")
res = await call("GET", "/internal/analytics/leave-reasons", undefined, "wrong")
assert.equal(res.status, 401)

console.log("leave-survey ok")
await d1.dispose()
process.exit(0)
