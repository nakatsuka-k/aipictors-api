// 作品のコメントへのリアクション: 1 人 1 つ・付け替え・外す・自分のコメントと消えたコメントには付けない
import assert from "node:assert/strict"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { listCommentReactions, reactToComment } = await import(`${API}/lib/comment-reactions.ts`)

const d1 = await createTestD1()
// サイトの DB の comments の代わり
const CORE = await d1.mf.getD1Database("GENLOG")
await CORE.prepare("CREATE TABLE comments (id INTEGER PRIMARY KEY, ownerId INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0)").run()
await CORE.prepare("INSERT INTO comments (id, ownerId, is_deleted) VALUES (10, 1, 0), (11, 2, 0), (12, 1, 1)").run()

const react = (userId: string, commentId: string, emoji: string, now = 100) =>
  reactToComment({ db: d1.db, core: CORE, userId, commentId, emoji, now })

try {
  // 付ける・同じ人は付け替え
  assert.deepEqual((await react("2", "10", "❤️")).data, [{ emoji: "❤️", userIds: ["2"] }])
  await react("3", "10", "❤️", 101)
  await react("4", "10", "✨", 102)
  assert.deepEqual((await react("3", "10", "🎉", 103)).data, [
    { emoji: "❤️", userIds: ["2"] },
    { emoji: "✨", userIds: ["4"] },
    { emoji: "🎉", userIds: ["3"] },
  ])

  // 外す
  assert.deepEqual((await react("3", "10", "")).data, [
    { emoji: "❤️", userIds: ["2"] },
    { emoji: "✨", userIds: ["4"] },
  ])

  // 自分のコメント・消えたコメント・ない絵文字は付けない
  assert.equal((await react("1", "10", "❤️")).status, 400)
  assert.equal((await react("2", "12", "❤️")).status, 404)
  assert.equal((await react("2", "99", "❤️")).status, 404)
  assert.equal((await react("2", "10", "💩")).status, 400)

  // まとめて読む（付いていないコメント・おかしい ID は含めない）
  await react("1", "11", "🙏")
  assert.deepEqual(await listCommentReactions({ db: d1.db, commentIds: ["10", "11", "13", "x"] }), {
    "10": [
      { emoji: "❤️", userIds: ["2"] },
      { emoji: "✨", userIds: ["4"] },
    ],
    "11": [{ emoji: "🙏", userIds: ["1"] }],
  })

  console.log("comment reactions ok")
} finally {
  await d1.dispose()
}
