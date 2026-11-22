// 終わった生成の依頼の記録を消す: npx tsx test/generation-queue-purge.test.mts
import assert from "node:assert/strict"

const { pickPurgeableQueueIds, purgeOldGenerationQueues, QUEUE_KEEP_DAYS } = await import(
  new URL("../src/lib/generation-retention.ts", import.meta.url).pathname
)

const cutoff = "2026-10-01 00:00:00"

// 期限より前の終わった依頼だけ。待ち・生成中は残す。期限内の行に着いたら止める
assert.deepEqual(
  pickPurgeableQueueIds(
    [
      { id: 1, request_time: "2026-07-11 03:03:21.707169", status: "generated" },
      { id: 2, request_time: "2026-07-12 00:00:00", status: "generating" },
      { id: 3, request_time: "2026-08-01 00:00:00", status: "error" },
      { id: 4, request_time: "2026-09-30 23:59:59", status: "canceled" },
      { id: 5, request_time: "2026-10-01 00:00:01", status: "generated" },
      { id: 6, request_time: "2026-07-01 00:00:00", status: "generated" },
    ],
    cutoff,
  ),
  [1, 3, 4],
)
assert.deepEqual(pickPurgeableQueueIds([], cutoff), [])
assert.deepEqual(pickPurgeableQueueIds([{ id: 9, request_time: null, status: "generated" }], cutoff), [])

// D1 には 1 回読んで 1 回だけ消す。消すものがなければ書かない
const calls: { sql: string; params: unknown[] }[] = []
const rows = [
  { id: 10, request_time: "2026-01-01 00:00:00", status: "generated" },
  { id: 11, request_time: "2026-11-22 00:00:00", status: "generated" },
]
const genlog = {
  prepare(sql: string) {
    return {
      bind(...params: unknown[]) {
        calls.push({ sql, params })
        return {
          all: async () => ({ results: rows }),
          run: async () => ({}),
        }
      },
    }
  },
}
const now = Date.parse("2026-11-23T00:00:00Z")
assert.deepEqual(await purgeOldGenerationQueues({ GENLOG: genlog }, now), { purged: 1 })
assert.equal(calls.length, 2)
assert.match(calls[0].sql, /ORDER BY id LIMIT/)
assert.match(calls[1].sql, /^DELETE FROM generated_queues WHERE id IN/)
assert.equal(calls[1].params[0], "[10]")

calls.length = 0
rows.splice(0, 1)
assert.deepEqual(await purgeOldGenerationQueues({ GENLOG: genlog }, now), { purged: 0 })
assert.equal(calls.length, 1)

assert.equal(await purgeOldGenerationQueues({}, now), null)
assert.equal(QUEUE_KEEP_DAYS, 45)

console.log("ok")
