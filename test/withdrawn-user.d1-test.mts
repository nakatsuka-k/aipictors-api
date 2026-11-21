// 退会した人の個人情報を消す: その人の Discord 連携・お問い合わせ・送信記録のメールアドレスだけ消し、ほかの人のものは残す
import assert from "node:assert/strict"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { scrubWithdrawnUser } = await import(`${API}/lib/withdrawn-user.ts`)

const d1 = await createTestD1()
const run = (sql: string, ...params: unknown[]) => d1.DB.prepare(sql).bind(...params).run()
const all = async (sql: string) => (await d1.DB.prepare(sql).all()).results

try {
  for (const userId of ["10", "20"]) {
    await run(
      "INSERT INTO discord_links(user_id, discord_user_id, discord_username, aipictors_login, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
      userId,
      `d${userId}`,
      `name${userId}`,
      `login${userId}`,
    )
    await run(
      "INSERT INTO support_tickets(id, user_id, contact_email, user_name, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
      Number(userId),
      userId,
      `u${userId}@example.com`,
      `name${userId}`,
    )
    await run(
      "INSERT INTO support_messages(ticket_id, user_id, role, body, created_at) VALUES (?, ?, 'user', ?, 1)",
      Number(userId),
      userId,
      `body${userId}`,
    )
    await run(
      "INSERT INTO email_campaign_sends(campaign, user_id, email, sent_at) VALUES ('c1', ?, ?, 1)",
      userId,
      `u${userId}@example.com`,
    )
  }

  await scrubWithdrawnUser({ db: d1.DB, userId: 10 })
  // 2 回呼んでも同じ
  await scrubWithdrawnUser({ db: d1.DB, userId: "10" })

  assert.deepEqual(await all("SELECT user_id FROM discord_links"), [{ user_id: "20" }])
  assert.deepEqual(await all("SELECT user_id FROM support_tickets"), [{ user_id: "20" }])
  assert.deepEqual(await all("SELECT body FROM support_messages"), [{ body: "body20" }])
  assert.deepEqual(await all("SELECT user_id, email FROM email_campaign_sends ORDER BY user_id"), [
    { user_id: "10", email: "" },
    { user_id: "20", email: "u20@example.com" },
  ])
  console.log("withdrawn-user ok")
} finally {
  await d1.dispose()
}
