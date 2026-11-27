import assert from "node:assert/strict"
import { collectOpenaiCost } from "../src/lib/costs"
import { addRecentExtraPods, averageServices, extraPodUsage } from "../src/lib/cost-breakdown"

// OpenAI: 組織の費用のうち Aipictors のキーだけ数える
const realFetch = globalThis.fetch
let requestedUrl = ""
globalThis.fetch = (async (url: string) => {
  requestedUrl = String(url)
  return new Response(
    JSON.stringify({
      data: [
        {
          results: [
            { api_key_id: "key_aipictors", amount: { value: 0.5 } },
            { api_key_id: "key_openclaw", amount: { value: 11.25 } },
            { api_key_id: null, amount: { value: 0.1 } },
          ],
        },
      ],
    }),
    { status: 200 }
  )
}) as typeof fetch
const openai = await collectOpenaiCost("admin", "2026-11-19", ["key_aipictors"])
globalThis.fetch = realFetch
assert.match(requestedUrl, /group_by=api_key_id/)
assert.equal(openai.usd, 0.5)
assert.equal(openai.otherUsd, 11.35)

// RunPod: 昼は一覧にない夜の台・入れ替えのお試しの台は、1 時間ごとの請求で常時の台数を超えた分だけ足す
// （入れ替えで ID が変わった前の無料用・有料用を「夜の台」に数えない）
const hour = (h: number) => `2026-11-27T${String(h).padStart(2, "0")}:00:00Z`
const records = [
  // 0 時: 前の無料用 old と有料用 paid1（2 台だけ）
  { startTime: hour(0), podId: "old", totalAmount: 0.25 },
  { startTime: hour(0), podId: "paid1", totalAmount: 0.25 },
  // 1 時: old から free1 への入れ替えで 3 台が同時（少ないほうの 0.1 が余分）
  { startTime: hour(1), podId: "old", totalAmount: 0.1 },
  { startTime: hour(1), podId: "free1", totalAmount: 0.2 },
  { startTime: hour(1), podId: "paid1", totalAmount: 0.25 },
  // 2 時: 夜の台 night1 も動いた
  { startTime: hour(2), podId: "free1", totalAmount: 0.2 },
  { startTime: hour(2), podId: "paid1", totalAmount: 0.25 },
  { startTime: hour(2), podId: "night1", totalAmount: 0.3 },
]
const usage = extraPodUsage(records, 2, 24)
assert.ok(Math.abs(usage.dailyExtraUsd - 0.3) < 1e-9) // 0.1 + 0.2（どの Pod が余分かではなく、常時の 2 台を超えた分の金額。各時間の小さいほうから）
assert.ok(Math.abs(usage.dailyTotalUsd - 1.8) < 1e-9)

const base = {
  pods: [
    { id: "free1", role: "free", status: "RUNNING", monthlyUsd: 180 },
    { id: "paid1", role: "paid", status: "RUNNING", monthlyUsd: 180 },
  ],
  monthlyUsd: 360,
}
const withNight = addRecentExtraPods(base, 3, 7)
const nightRow = withNight.pods.find((pod) => pod.role === "night")
assert.equal(nightRow.monthlyUsd, 90) // 1 日 $3 × 30
assert.equal(withNight.monthlyUsd, 450)

// 夜の台が今動いていれば、その行を平均に置き換える（二重に数えない）
const running = addRecentExtraPods(
  { pods: [...base.pods, { id: "night3", name: "aipictors-night-x", role: "night", status: "RUNNING", monthlyUsd: 52.5 }], monthlyUsd: 412.5 },
  3,
  7
)
assert.equal(running.pods.filter((pod) => pod.role === "night").length, 1)
assert.equal(running.monthlyUsd, 450)

// ほかのサービス: 中央値なので 1 日だけ跳ねた日に引っ張られない
const serviceDays = [160, 300, 1240, 260, 290].map((jpy, index) => ({
  day: `2026-11-2${index}`,
  costs: { fxUsdJpy: 150, items: { google: { jpy, currency: "JPY", bySku: { a: jpy } } } },
}))
const services = averageServices(serviceDays)
assert.equal(services.services.google.dailyJpy, 290)
assert.equal(services.services.google.monthlyJpy, 8700)
assert.equal(services.services.google.detail[0].monthlyJpy, 8700)

console.log("costs-scope ok")
