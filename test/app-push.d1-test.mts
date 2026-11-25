// アプリのプッシュ通知: 生成の完了（残りがあれば送らない・2 分に 1 回）、ランキング入り（1 日 1 通・R18 は送らない）、週のまとめ、設定
import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { Miniflare } from "miniflare"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const push = await import(`${API}/lib/app-push.ts`)

const d1 = await createTestD1()
const side = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["CORE", "ACTIVITY"] })
const CORE = await side.getD1Database("CORE")
const ACTIVITY = await side.getD1Database("ACTIVITY")
await CORE.prepare("CREATE TABLE user_profiles (userId INTEGER PRIMARY KEY, fcm_token TEXT)").run()
await CORE.prepare("CREATE TABLE works (id INTEGER PRIMARY KEY, title TEXT)").run()
await CORE.prepare(
  "CREATE TABLE work_rankings (favDate TEXT, rankingType TEXT, posttype TEXT, worksR18 INTEGER, worksId INTEGER, userId INTEGER, rank INTEGER, favCount INTEGER, event_id INTEGER, PRIMARY KEY (favDate, rankingType, posttype, worksR18, worksId))",
).run()
await ACTIVITY.prepare("CREATE TABLE notifications (id INTEGER PRIMARY KEY, userId INTEGER, notifyType INTEGER, notifyTime TEXT)").run()

const TOKEN = (n: number) => `token-${n}-xxxxxxxxxxxxxxxxxxxxxxxx`
await CORE.prepare("INSERT INTO user_profiles VALUES (1, ?1), (2, ?2), (3, NULL), (4, ?3)").bind(TOKEN(1), TOKEN(2), TOKEN(4)).run()

// FCM と Google のトークンの代わり
const sent: any[] = []
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const env = {
  FIREBASE_PROJECT_ID: "p",
  FIREBASE_CLIENT_EMAIL: "x@example.com",
  FIREBASE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
}
globalThis.fetch = (async (url: string, init: any) => {
  if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "a", expires_in: 3600 }))
  const body = JSON.parse(init.body)
  if (body.message.token === TOKEN(4)) return new Response('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', { status: 404 })
  sent.push(body.message)
  return new Response("{}")
}) as any

const queue = (userId: number, status: string, platform = "flutter") =>
  d1.GENLOG.prepare(
    "INSERT INTO generated_queues (user_id, request_content, request_time, status, nanoid, platform, uuid) VALUES (?1, '{}', '2026-11-25', ?2, 'n', ?3, 'u')",
  )
    .bind(userId, status, platform)
    .run()

const done = (userId: string, now: number, platform = "flutter") =>
  push.notifyGenerationDone({ env, db: d1.db, genlog: d1.genlog, core: CORE, userId, platform, now })

try {
  // ---- 生成の完了 ----
  await queue(1, "generating")
  assert.equal((await done("1", 1000)).skipped, "pending")
  await d1.GENLOG.prepare("UPDATE generated_queues SET status = 'generated'").run()
  assert.equal((await done("1", 1000, "web")).skipped, "platform")
  assert.equal((await done("1", 1000)).result, "sent")
  assert.equal(sent.at(-1).data.type, "generation")
  assert.equal(sent.at(-1).token, TOKEN(1))
  // 続けて終わっても 2 分は送らない
  assert.equal((await done("1", 1060)).skipped, "interval")
  assert.equal((await done("1", 1200)).result, "sent")
  // トークンの無い人・オフにした人
  assert.equal((await done("3", 1000)).skipped, "no_token")
  await push.savePushPreferences(d1.db, "2", { generation: false }, 1000)
  assert.equal((await done("2", 1000)).skipped, "preference")
  assert.deepEqual(await push.getPushPreferences(d1.db, "2"), { generation: false, ranking: true, digest: true })
  assert.deepEqual(await push.getPushPreferences(d1.db, "9"), { generation: true, ranking: true, digest: true })
  // 使えなくなったトークンは消す
  assert.equal((await done("4", 1000)).result, "invalid")
  assert.equal((await CORE.prepare("SELECT fcm_token FROM user_profiles WHERE userId = 4").first()).fcm_token, null)

  // ---- ランキング ----
  // 2026-11-30（月）12:00 JST: デイリーは 11/29、ウィークリーは 11/23
  const monday = Date.UTC(2026, 10, 30, 3, 0) / 1000
  const r = push.rankingRangesFor(monday)
  assert.deepEqual(r.ranges.map((x: any) => `${x.rankingType}:${x.favDate.slice(0, 10)}`), ["daily:2026-11-29", "weekly:2026-11-23"])
  assert.deepEqual(
    push.rankingRangesFor(Date.UTC(2026, 11, 1, 3, 0) / 1000).ranges.map((x: any) => `${x.rankingType}:${x.favDate.slice(0, 10)}`),
    ["daily:2026-11-30", "monthly:2026-11-01"],
  )
  await CORE.prepare("INSERT INTO works VALUES (10, 'A'), (11, 'B'), (12, 'R18')").run()
  await CORE.prepare(
    `INSERT INTO work_rankings VALUES
     ('2026-11-29T00:00:00.000+00:00', 'daily', 'image', 0, 10, 1, 5, 1, NULL),
     ('2026-11-29T00:00:00.000+00:00', 'daily', 'image', 0, 11, 1, 2, 1, NULL),
     ('2026-11-23T00:00:00.000+00:00', 'weekly', 'image', 0, 10, 1, 30, 1, NULL),
     ('2026-11-29T00:00:00.000+00:00', 'daily', 'image', 1, 12, 2, 1, 1, NULL),
     ('2026-11-29T00:00:00.000+00:00', 'dailyGenerate', 'image', 0, 11, 2, 1, 1, NULL)`,
  ).run()
  sent.length = 0
  const ranking = await push.runRankingPush({ env, db: d1.db, core: CORE, now: monday })
  assert.equal(ranking.sent, 1)
  assert.equal(sent[0].notification.title, "「A」がウィークリーランキング 30 位に入りました")
  assert.match(sent[0].notification.body, /ほかに 2 件/)
  assert.equal(sent[0].data.url, "/works/10")
  // 同じ日の 2 回目は送らない
  assert.equal((await push.runRankingPush({ env, db: d1.db, core: CORE, now: monday + 300 })).sent, 0)

  // ---- 週のまとめ ----
  const sunday = Date.UTC(2026, 10, 29, 10, 0) / 1000
  await ACTIVITY.prepare(
    `INSERT INTO notifications (userId, notifyType, notifyTime) VALUES
     (1, 0, '2026-11-28T10:00:00.000+00:00'), (1, 0, '2026-11-27T10:00:00.000+00:00'), (1, 1, '2026-11-27T10:00:00.000+00:00'),
     (1, 2, '2026-11-26T10:00:00.000+00:00'), (1, 0, '2026-11-10T10:00:00.000+00:00')`,
  ).run()
  sent.length = 0
  const digest = await push.runWeeklyDigestPush({ env, db: d1.db, core: CORE, activity: ACTIVITY, now: sunday })
  // 行があるのは 2（反応なし）と 1（下で作る）
  assert.equal(digest.sent, 0)
  await push.savePushPreferences(d1.db, "1", {}, 1000)
  const digest2 = await push.runWeeklyDigestPush({ env, db: d1.db, core: CORE, activity: ACTIVITY, now: sunday })
  assert.equal(digest2.sent, 1)
  assert.equal(sent[0].notification.title, "今週の反応: いいね 2・コメント 2")
  assert.equal((await push.runWeeklyDigestPush({ env, db: d1.db, core: CORE, activity: ACTIVITY, now: sunday + 300 })).sent, 0)

  console.log("app push ok")
} finally {
  await d1.dispose()
  await side.dispose()
}
