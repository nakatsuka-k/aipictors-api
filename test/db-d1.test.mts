// D1 クライアントの変換（プレースホルダ・引数・日時・真偽値）が Neon 版と同じ結果になること
import assert from "node:assert/strict"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { toSqlitePlaceholders, toSqliteParam, toTimestampText } = await import(`${API}/lib/db-d1.ts`)

assert.equal(toSqlitePlaceholders("SELECT $1, '$2', \"$3\", $10"), "SELECT ?1, '$2', \"$3\", ?10")
assert.equal(toSqliteParam(true), 1)
assert.equal(toSqliteParam(undefined), null)
assert.equal(toSqliteParam(["a", "b"]), '["a","b"]')
// Neon（timestamp without time zone）と同じく、タイムゾーンは無視して時刻だけ入れる
assert.equal(toSqliteParam("2026-11-04T12:00:00"), "2026-11-04 12:00:00")
assert.equal(toSqliteParam("2026-11-01T00:00:00Z"), "2026-11-01 00:00:00")
assert.equal(toSqliteParam("2026-11-01T00:00:00.123+09:00"), "2026-11-01 00:00:00.123")
assert.equal(toTimestampText(new Date("2026-11-04T03:00:00.000Z")), "2026-11-04 03:00:00.000")
assert.equal(toSqliteParam("2026-11-04"), "2026-11-04")
assert.equal(toSqliteParam("{\"a\":\"2026-11-04T12:00:00\"}"), "{\"a\":\"2026-11-04T12:00:00\"}")

const d1 = await createTestD1()
const g = d1.genlog
await g.execute(
  `INSERT INTO generated_queues (user_id, request_content, request_time, status, nanoid, platform, uuid, is_deleted, created_at)
   VALUES (1, '{}', $1, 'wait', 'n1', 'web', 'u1', $2, '2026-11-07 17:24:48.774685')`,
  [new Date("2026-11-08T02:24:48.000Z"), false],
)
const row = await g.queryOne<any>("SELECT request_time, created_at, is_deleted, status FROM generated_queues WHERE nanoid = 'n1'")
assert.ok(row.request_time instanceof Date)
assert.equal(row.request_time.toISOString(), "2026-11-08T02:24:48.000Z")
assert.equal(row.created_at.toISOString(), "2026-11-07T17:24:48.774Z")
assert.equal(row.is_deleted, false)
// 文字列の大小で日時を比べられる
assert.equal((await g.queryOne<any>("SELECT COUNT(*) AS n FROM generated_queues WHERE request_time >= $1", ["2026-11-08T00:00:00Z"])).n, 1)
assert.equal((await g.queryOne<any>("SELECT COUNT(*) AS n FROM generated_queues WHERE request_time >= $1", [new Date("2026-11-08T02:24:49Z")])).n, 0)
// 配列の引数
assert.equal((await g.queryOne<any>("SELECT COUNT(*) AS n FROM generated_queues WHERE status IN (SELECT value FROM json_each($1))", [["wait", "error"]])).n, 1)
// batch の途中で guard が失敗したらすべて取り消される
const { guard } = await import(`${API}/lib/db-d1.ts`)
await assert.rejects(
  g.batch([{ text: "UPDATE generated_queues SET status = 'error' WHERE nanoid = 'n1'" }, { text: "UPDATE generated_queues SET status = 'x' WHERE nanoid = 'none'" }, guard()]),
  /d1_guard_failed/,
)
assert.equal((await g.queryOne<any>("SELECT status FROM generated_queues WHERE nanoid = 'n1'")).status, "wait")
await d1.dispose()
console.log("ok  db-d1")
