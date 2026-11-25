import assert from "node:assert/strict"
import { collectOpenaiCost } from "../src/lib/costs"
import { addRecentNightPods } from "../src/lib/cost-breakdown"

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

// RunPod: 昼は一覧にない夜の台を、直近の請求の Pod 別の実額で足す
const base = {
  pods: [
    { id: "free1", role: "free", status: "RUNNING", monthlyUsd: 180 },
    { id: "paid1", role: "paid", status: "RUNNING", monthlyUsd: 180 },
    { id: "old", role: "other", status: "EXITED", monthlyUsd: 0 },
  ],
  monthlyUsd: 420,
}
const days = [
  { costs: { items: { runpod: { byPod: { free1: 6, paid1: 6, old: 13, night1: 3, night2: 1 } } } } },
  { costs: { items: { runpod: { byPod: { free1: 6, paid1: 6, night2: 2 } } } } },
]
const withNight = addRecentNightPods(base, days)
const nightRow = withNight.pods.find((pod) => pod.role === "night")
assert.equal(nightRow.monthlyUsd, 90) // (4 + 2) / 2 日 × 30
assert.equal(withNight.monthlyUsd, 510)

// 夜の台が今動いていれば、その行を平均に置き換える（二重に数えない）
const running = addRecentNightPods(
  { pods: [...base.pods, { id: "night3", name: "aipictors-night-x", role: "night", status: "RUNNING", monthlyUsd: 52.5 }], monthlyUsd: 472.5 },
  days
)
assert.equal(running.pods.filter((pod) => pod.role === "night").length, 1)
assert.equal(running.monthlyUsd, 510)

console.log("costs-scope ok")
