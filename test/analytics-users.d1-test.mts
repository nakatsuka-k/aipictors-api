// 分析ページの利用者の数字: 登録（UTC）・投稿といいね（日本時間の文字列）・ログイン（翌日のうちだけ数える）
import assert from "node:assert/strict"
import { Miniflare } from "miniflare"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { collectUsersDay, collectUsersMonth, listUsersMonths, nextMonth } = await import(`${API}/lib/analytics-users.ts`)

const d1 = await createTestD1()
const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('ok') } }",
  d1Databases: ["CORE"],
})
const core = await mf.getD1Database("CORE")
for (const statement of [
  `CREATE TABLE wp_users (ID INTEGER PRIMARY KEY, user_registered TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE works (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL, time TEXT NOT NULL)`,
  `CREATE TABLE favorited_works (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL, favTime TEXT NOT NULL)`,
  `CREATE TABLE user_login_streaks (user_id INTEGER PRIMARY KEY, last_login_date TEXT, previous_login_date TEXT)`,
  // 11/05 の日本時間は 11/04 15:00 UTC 〜 11/05 15:00 UTC
  `INSERT INTO wp_users (ID, user_registered, is_deleted) VALUES
    (1, '2026-10-01T00:00:00.000+00:00', 0),
    (2, '2026-11-04T14:59:59.000+00:00', 0),
    (3, '2026-11-04T15:00:00.000+00:00', 0),
    (4, '2026-11-05T14:59:59.999+00:00', 1),
    (5, '2026-11-05T15:00:00.000+00:00', 0)`,
  `INSERT INTO works (userId, time) VALUES
    (1, '2026-11-05T00:00:00.000+00:00'), (1, '2026-11-05T12:00:00.000+00:00'), (2, '2026-11-05T23:59:59.999+00:00'),
    (3, '2026-11-06T00:00:00.000+00:00'), (3, '2026-11-04T23:59:59.000+00:00')`,
  `INSERT INTO favorited_works (userId, favTime) VALUES
    (2, '2026-11-05T01:00:00.000+00:00'), (4, '2026-11-05T02:00:00.000+00:00'), (0, '2026-11-05T03:00:00.000+00:00'),
    (5, '2026-11-06T03:00:00.000+00:00')`,
  `INSERT INTO user_login_streaks (user_id, last_login_date, previous_login_date) VALUES
    (1, '2026-11-05T00:00:00.000+00:00', '2026-11-04T00:00:00.000+00:00'),
    (2, '2026-11-06T00:00:00.000+00:00', '2026-11-05T00:00:00.000+00:00'),
    (3, '2026-11-06T00:00:00.000+00:00', '2026-10-31T00:00:00.000+00:00'),
    (4, '2026-10-30T00:00:00.000+00:00', NULL),
    (5, '2026-10-01T00:00:00.000+00:00', NULL)`,
]) {
  await core.prepare(statement).run()
}

try {
  const day = await collectUsersDay(core, "2026-11-05", "2026-11-06", null)
  // 新規は 3・4（4 は退会済みでも新規には数える）、累計は退会を除く 1・2・3
  assert.deepEqual(day.registered, { new: 2, total: 3 })
  assert.equal(day.posters, 2)
  assert.equal(day.posts, 3)
  assert.equal(day.likers, 2)
  assert.equal(day.likes, 3)
  assert.equal(day.active, 3)
  // その日: 1 と、翌日も来た 2。7 日: + 10/31 のあと翌日に来た 3、10/30 の 4 も 7 日以内。30 日: 10/01 の 5 は外
  assert.deepEqual(day.login, { dau: 2, wau: 4, mau: 4 })

  // 翌日を過ぎたら数えず、保存済みの値を残す
  const later = await collectUsersDay(core, "2026-11-05", "2026-11-08", { login: { dau: 9, wau: 9, mau: 9 } })
  assert.deepEqual(later.login, { dau: 9, wau: 9, mau: 9 })
  assert.equal((await collectUsersDay(core, "2026-11-05", "2026-11-08", null)).login, null)
  assert.equal(await collectUsersDay(null, "2026-11-05", "2026-11-06", null), null)

  assert.equal(nextMonth("2026-12"), "2027-01")
  const month = await collectUsersMonth(core, d1.db, "2026-11")
  assert.deepEqual(month.registered, { new: 4, total: 4 })
  assert.equal(month.active, 5)
  await collectUsersMonth(core, d1.db, "2026-11")
  await collectUsersMonth(core, d1.db, "2026-10")
  const months = await listUsersMonths(d1.db)
  assert.deepEqual(months.map((row: { month: string }) => row.month), ["2026-10", "2026-11"])
  assert.deepEqual(months[0].registered, { new: 1, total: 1 })
  console.log("analytics-users: ok")
} finally {
  await mf.dispose()
  await d1.dispose()
}
