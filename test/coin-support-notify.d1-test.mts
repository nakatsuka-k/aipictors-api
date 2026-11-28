// ユーザーへの推しのお知らせ: 推しが通ったら受け取った人にコインのお知らせ（notifyType 0・workId 0）を 1 行、匿名なら名前を出さない、
// 推しを表示しない設定・コメントの通知オフの人には出さない、断られた推しでは出さない、プッシュは 1 時間に 1 通・金額を書かない
import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { Miniflare } from "miniflare"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { app } = await import(`${API}/app.ts`)
const coins = await import(`${API}/lib/coins.ts`)
const notify = await import(`${API}/lib/coin-support/notify.ts`)

const d1 = await createTestD1()
const db = d1.db
const side = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: ["CORE", "ACTIVITY"] })
const CORE = await side.getD1Database("CORE")
const ACTIVITY = await side.getD1Database("ACTIVITY")
await CORE.prepare("CREATE TABLE wp_users (ID INTEGER PRIMARY KEY, display_name TEXT)").run()
await CORE.prepare("CREATE TABLE user_profiles (userId INTEGER PRIMARY KEY, userName TEXT, fcm_token TEXT, web_fcm_token TEXT)").run()
await CORE.prepare(
  "CREATE TABLE user_settings (userId INTEGER PRIMARY KEY, hide_coin_support INTEGER, notNotificationComment INTEGER, reject_premium_coin_support INTEGER, reject_free_coin_support_receive INTEGER, reject_coin_support INTEGER)",
).run()
await ACTIVITY.prepare(
  "CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, userId INTEGER, workId INTEGER, comment TEXT, stampId INTEGER, ownerUserId INTEGER, notifyInnerCount INTEGER, notifyType INTEGER, notifyTime TEXT, commentId INTEGER)",
).run()
const TOKEN = "app-token-xxxxxxxxxxxxxxxxxxxxxxxx"
for (const id of [100, 101, 102, 103, 104]) {
  await CORE.prepare("INSERT INTO wp_users (ID, display_name) VALUES (?1, ?2)").bind(id, `login${id}`).run()
  await CORE.prepare("INSERT INTO user_profiles (userId, userName, fcm_token) VALUES (?1, ?2, ?3)").bind(id, `user${id}`, id === 101 ? TOKEN : null).run()
}
// 102: 推しを表示しない、103: コメントの通知オフ、104: 推しを受け付けない
await CORE.prepare("INSERT INTO user_settings (userId, hide_coin_support) VALUES (102, 1)").run()
await CORE.prepare("INSERT INTO user_settings (userId, notNotificationComment) VALUES (103, 1)").run()
await CORE.prepare("INSERT INTO user_settings (userId, reject_coin_support) VALUES (104, 1)").run()

const pushes: any[] = []
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
globalThis.fetch = (async (url: string, init: any) => {
  if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "a", expires_in: 3600 }))
  pushes.push(JSON.parse(init.body).message)
  return new Response("{}")
}) as any

const env: Record<string, unknown> = {
  DB: d1.DB,
  GENLOG: d1.GENLOG,
  SYSTEM_CORE: CORE,
  SYSTEM_ACTIVITY: ACTIVITY,
  INTERNAL_API_TOKEN: "internal",
  FIREBASE_PROJECT_ID: "p",
  FIREBASE_CLIENT_EMAIL: "x@example.com",
  FIREBASE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
}
let seq = 0
const support = async (input: Record<string, unknown>) => {
  const body = { source: `t-${++seq}`, ...input }
  const waits: Promise<unknown>[] = []
  const res = await app.fetch(
    new Request("http://api.test/internal/coins/support", {
      method: "POST",
      headers: { authorization: "Bearer internal", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {} },
  )
  await Promise.all(waits)
  return res.status
}
const rows = async (userId: number) =>
  ((await ACTIVITY.prepare("SELECT workId, comment, ownerUserId, notifyType, commentId FROM notifications WHERE userId = ?1 ORDER BY id").bind(userId).all()).results ?? []) as any[]

try {
  // 文面
  assert.equal(notify.buildSupportNotificationMessage({ senderName: "あい", isAnonymous: false, coinType: "PREMIUM", amount: 1200 }), "あいさんがあなたを推しました（プレミアムコイン 1,200）")
  assert.equal(notify.buildSupportNotificationMessage({ senderName: "あい", isAnonymous: true, coinType: "FREE", amount: 3 }), "匿名のユーザーがあなたを推しました（フリーコイン 3）")
  assert.equal(notify.buildSupportNotificationMessage({ senderName: "", isAnonymous: false, coinType: "FREE", amount: 1 }), "ユーザーさんがあなたを推しました（フリーコイン 1）")

  await coins.ensureInitialCoinGrant({ db, userId: "100", planType: "FREE" })
  await coins.applyCoinDelta({ db, userId: "100", freeDelta: 100, premiumDelta: 100, kind: "GRANT", reason: "test" })

  // ふつうの推し: コインのお知らせの形で 1 行、プッシュ 1 通（金額なし）
  assert.equal(await support({ senderUserId: "100", recipientUserId: "101", coinType: "FREE", amount: 5 }), 200)
  assert.deepEqual(await rows(101), [{ workId: 0, comment: "user100さんがあなたを推しました（フリーコイン 5）", ownerUserId: -1, notifyType: 0, commentId: 100 }])
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0].token, TOKEN)
  assert.equal(pushes[0].notification.body, "user100さんがあなたを推しました")
  assert.doesNotMatch(JSON.stringify(pushes[0]), /フリーコイン/)

  // 匿名: 名前を出さない。続けての推しも一覧には出るが、プッシュは 1 時間に 1 通
  assert.equal(await support({ senderUserId: "100", recipientUserId: "101", coinType: "FREE", amount: 2, isAnonymous: true }), 200)
  const after = await rows(101)
  assert.equal(after.length, 2)
  assert.equal(after[1].comment, "匿名のユーザーがあなたを推しました（フリーコイン 2）")
  assert.doesNotMatch(after[1].comment, /user100/)
  assert.equal(after[1].commentId, -1)
  assert.equal(pushes.length, 1)

  // 同じ source の送り直し（推しは二重にならない）ではお知らせも出さない
  await support({ senderUserId: "100", recipientUserId: "101", coinType: "FREE", amount: 2, isAnonymous: true, source: `t-${seq}` })
  assert.equal((await rows(101)).length, 2)

  // 推しを表示しない・コメントの通知オフの人には出さない（推しそのものは通る）
  assert.equal(await support({ senderUserId: "100", recipientUserId: "102", coinType: "FREE", amount: 1 }), 200)
  assert.equal(await support({ senderUserId: "100", recipientUserId: "103", coinType: "FREE", amount: 1 }), 200)
  assert.deepEqual(await rows(102), [])
  assert.deepEqual(await rows(103), [])

  // 断られた推し（受け付けない設定・作品への推し・残高不足）では出さない
  assert.equal(await support({ senderUserId: "100", recipientUserId: "104", coinType: "FREE", amount: 1 }), 403)
  assert.deepEqual(await rows(104), [])
  assert.equal(await support({ senderUserId: "100", recipientUserId: "101", coinType: "FREE", amount: 1, workId: "5" }), 403)
  assert.equal(await support({ senderUserId: "100", recipientUserId: "101", coinType: "FREE", amount: 100000 }), 409)
  assert.equal((await rows(101)).length, 2)

  console.log("coin support notify ok")
} finally {
  await d1.dispose()
  await side.dispose()
}
