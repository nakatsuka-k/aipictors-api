// 作品のオリジナル判定: 付ける・変える・外す・記録が残る・消えた作品には付けない・プレミアムの推しは判定がタグより優先
import assert from "node:assert/strict"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { getWorkOriginalJudgments, getWorkOriginalJudgment, listWorkOriginalJudgmentLogs, setWorkOriginalJudgment } = await import(
  `${API}/lib/work-original-judgments.ts`
)
const { isOriginalWorkForSupport } = await import(`${API}/lib/coin-support/recipient.ts`)

const d1 = await createTestD1()
// サイトの DB の works・tags・work_tags の代わり
const CORE = await d1.mf.getD1Database("GENLOG")
await CORE.prepare("CREATE TABLE works (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0)").run()
await CORE.prepare("CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE)").run()
await CORE.prepare("CREATE TABLE work_tags (work_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0)").run()
await CORE.prepare("INSERT INTO works (id, userId, is_deleted) VALUES (10, 1, 0), (11, 1, 0), (12, 1, 1), (13, 2, 0)").run()
await CORE.prepare("INSERT INTO tags (id, name) VALUES (1, 'オリジナル'), (2, '初音ミク')").run()
// 10 はオリジナルのタグ付き、11 は二次創作のタグだけ
await CORE.prepare("INSERT INTO work_tags (work_id, tag_id) VALUES (10, 1), (11, 2)").run()

const set = (workId: string, judgment: string | null, now = 100, note: string | null = null) =>
  setWorkOriginalJudgment({ db: d1.db, core: CORE, workId, judgment, note, moderatorUserId: "9", now })

try {
  // 未判定はタグで見る
  assert.equal(await getWorkOriginalJudgment(d1.db, "10"), null)
  assert.equal(await isOriginalWorkForSupport(CORE, "10", "1", d1.db), true)
  assert.equal(await isOriginalWorkForSupport(CORE, "11", "1", d1.db), false)

  // 付ける（判定がタグより優先）
  assert.deepEqual((await set("11", "ORIGINAL", 100, "  オリジナルキャラ  ")).data, { judgment: "ORIGINAL", note: "オリジナルキャラ", judgedBy: "9", judgedAt: 100 })
  assert.equal(await isOriginalWorkForSupport(CORE, "11", "1", d1.db), true)
  assert.equal((await set("10", "FAN_WORK", 101)).data.judgment, "FAN_WORK")
  assert.equal(await isOriginalWorkForSupport(CORE, "10", "1", d1.db), false)
  // オリジナルの判定でも、受け取る人の作品でなければ不可
  await set("13", "ORIGINAL", 102)
  assert.equal(await isOriginalWorkForSupport(CORE, "13", "1", d1.db), false)
  assert.equal(await isOriginalWorkForSupport(CORE, "13", "2", d1.db), true)

  // まとめて読む（未判定・おかしい ID は含めない。作品ページ向けは判定だけ）
  assert.deepEqual(await getWorkOriginalJudgments({ db: d1.db, workIds: ["10", "11", "14", "x"] }), {
    "10": { judgment: "FAN_WORK" },
    "11": { judgment: "ORIGINAL" },
  })

  // 変える・外す。記録は全部残る（新しい順）
  await set("11", "FAN_WORK", 103)
  assert.equal((await set("11", null, 104)).data, null)
  assert.equal(await getWorkOriginalJudgment(d1.db, "11"), null)
  assert.deepEqual(
    (await listWorkOriginalJudgmentLogs({ db: d1.db, workId: "11" })).map((log: { judgment: string | null; judgedAt: number }) => [log.judgment, log.judgedAt]),
    [[null, 104], ["FAN_WORK", 103], ["ORIGINAL", 100]],
  )
  // 外したら未判定（タグ）に戻る
  assert.equal(await isOriginalWorkForSupport(CORE, "11", "1", d1.db), false)

  // 消えた作品・無い作品・おかしい値には付けない
  assert.equal((await set("12", "ORIGINAL")).status, 404)
  assert.equal((await set("99", "ORIGINAL")).status, 404)
  assert.equal((await set("10", "OTHER")).status, 400)
  assert.equal((await set("x", "ORIGINAL")).status, 400)

  // db を渡さない呼び出し（今までの形）はタグだけで見る
  assert.equal(await isOriginalWorkForSupport(CORE, "10", "1"), true)

  console.log("work original judgments ok")
} finally {
  await d1.dispose()
}
