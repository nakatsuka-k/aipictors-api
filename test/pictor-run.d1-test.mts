// ぴくたーちゃんラン: チャット（書き込み・返信・メンション・連投の制限・削除）とスコアランキング（累計・今週・あり得ないスコア）
import assert from "node:assert/strict"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { app } = await import(`${API}/app.ts`)
const { pictorRunWeekStart } = await import(`${API}/lib/pictor-run.ts`)

import { createTestD1 } from "./d1.mts"
const d1 = await createTestD1()
const env = { DB: d1.DB, GENLOG: d1.GENLOG, INTERNAL_API_TOKEN: "internal" }

const call = async (path: string, body: unknown, token = "internal") => {
  const res = await app.fetch(
    new Request(`http://api.test/internal/pictor-run${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  )
  return { status: res.status, body: (await res.json()) as { error: string | null; data: any } }
}

const alice = { id: "1", name: "アリス", login: "alice", iconUrl: "https://assets.aipictors.com/a.webp", badge: { level: 12, achievement: null } }
const bob = { id: "2", name: "ボブ", login: "bob", iconUrl: null, badge: null }

// 内部トークンがないと呼べない
assert.equal((await call("/messages/list", {}, "wrong")).status, 401)

// 書き込みと一覧
const first = await call("/messages/create", { user: alice, body: "  こんにちは  " })
assert.equal(first.status, 200)
assert.equal(first.body.data.message.body, "こんにちは")
assert.deepEqual(first.body.data.message.user.badge, { level: 12, achievement: null })
const firstId = first.body.data.message.id

// スタンプだけ・返信・メンション（本文に名前がないメンションは捨てる）
const reply = await call("/messages/create", {
  user: bob,
  body: "@アリス よろしく",
  replyToId: firstId,
  mentions: [{ userId: "1", name: "アリス" }, { userId: "9", name: "いない人" }],
})
assert.equal(reply.body.data.message.replyTo.name, "アリス")
assert.equal(reply.body.data.message.replyTo.excerpt, "こんにちは")
assert.deepEqual(reply.body.data.message.mentions, [{ userId: "1", name: "アリス" }])
const sticker = await call("/messages/create", { user: bob, stickerId: "5", stickerUrl: "https://assets.aipictors.com/s.webp" })
assert.equal(sticker.body.data.message.stickerUrl, "https://assets.aipictors.com/s.webp")

// 空・長すぎ・同じ文の連投・続けすぎは弾く
assert.equal((await call("/messages/create", { user: alice, body: "   " })).status, 400)
assert.equal((await call("/messages/create", { user: alice, body: "あ".repeat(201) })).status, 400)
assert.equal((await call("/messages/create", { user: alice, body: "こんにちは" })).body.error, "duplicate")
await call("/messages/create", { user: alice, body: "2" })
await call("/messages/create", { user: alice, body: "3" })
await call("/messages/create", { user: alice, body: "4" })
assert.equal((await call("/messages/create", { user: alice, body: "5" })).body.error, "rate_limited")

const list = await call("/messages/list", {})
assert.equal(list.body.data.messages.length, 6)
assert.equal(list.body.data.messages[0].body, "こんにちは")
// afterId より新しいものだけ
const newer = await call("/messages/list", { afterId: reply.body.data.message.id })
assert.equal(newer.body.data.messages.length, 4)

// 他人のは消せない。本人とモデレーターは消せて、開いている人にも消えたことが伝わる
assert.equal((await call("/messages/delete", { messageId: firstId, userId: "2" })).body.data.deleted, false)
assert.equal((await call("/messages/delete", { messageId: firstId, userId: "1" })).body.data.deleted, true)
assert.equal((await call("/messages/delete", { messageId: sticker.body.data.message.id, userId: "1", isModerator: true })).body.data.deleted, true)
const afterDelete = await call("/messages/list", { afterId: firstId })
assert.equal(afterDelete.body.data.messages.length, 4)
assert.ok(afterDelete.body.data.deletedIds.includes(firstId))

// スコア: あり得ないものは弾く（10 秒で 1000m は進めない）
assert.equal((await call("/scores/submit", { user: alice, score: 1000, coins: 0, durationMs: 10_000 })).status, 400)
assert.equal((await call("/scores/submit", { user: alice, score: -1, coins: 0, durationMs: 10_000 })).status, 400)
const s1 = await call("/scores/submit", { user: alice, score: 120, coins: 5, durationMs: 20_000 })
assert.deepEqual(s1.body.data, { best: 120, isNewBest: true, rank: 1 })
const s2 = await call("/scores/submit", { user: alice, score: 80, coins: 2, durationMs: 15_000 })
assert.deepEqual(s2.body.data, { best: 120, isNewBest: false, rank: 1 })
const s3 = await call("/scores/submit", { user: bob, score: 300, coins: 10, durationMs: 45_000 })
assert.deepEqual(s3.body.data, { best: 300, isNewBest: true, rank: 1 })

const all = await call("/scores/ranking", { period: "all", userId: "1" })
assert.deepEqual(all.body.data.items.map((i: any) => [i.rank, i.user.name, i.score, i.coins]), [[1, "ボブ", 300, 10], [2, "アリス", 120, 5]])
assert.deepEqual(all.body.data.me, { rank: 2, score: 120 })

// 今週: 先週の記録は入らない
const weekStart = pictorRunWeekStart(Math.floor(Date.now() / 1000))
await d1.DB.prepare("UPDATE pictor_run_plays SET created_at = ? WHERE user_id = '2'").bind(weekStart - 10).run()
const week = await call("/scores/ranking", { period: "week", userId: "2" })
assert.deepEqual(week.body.data.items.map((i: any) => [i.rank, i.user.name, i.score]), [[1, "アリス", 120]])
assert.equal(week.body.data.me, null)
// 月曜 0 時（日本時間）: 2026-11-14(土) 12:00 JST → 2026-11-09(月) 00:00 JST
assert.equal(pictorRunWeekStart(Date.UTC(2026, 10, 14, 3) / 1000), Date.UTC(2026, 10, 8, 15) / 1000)

await d1.dispose()
console.log("pictor-run: ok")
