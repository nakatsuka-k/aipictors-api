// お問い合わせ: AI で解決できないものは運営に引き継ぐ（waiting_staff）。運営の対応エージェントは SUPPORT_AGENT_TOKEN で /admin/* だけ使える
import assert from "node:assert/strict"
import { Hono } from "hono"
import { createTestD1 } from "./d1.mts"

const API = process.env.API_SRC ?? new URL("../src", import.meta.url).pathname
const { supportRoutes } = await import(`${API}/routes/support.ts`)

const d1 = await createTestD1()
const env = {
  DB: d1.DB,
  GENLOG: d1.GENLOG,
  INTERNAL_API_TOKEN: "internal",
  SUPPORT_AGENT_TOKEN: "agent",
  GEMINI_API_KEY: "dummy",
}
const app = new Hono()
app.route("/internal/support", supportRoutes)

// Gemini の代わり: 次に返す答えを決めておく
let nextAnswer = { answer: "調べます", handoff: true, category: "bug", summary: "不具合の相談" }
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).includes("generativelanguage.googleapis.com")) {
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(nextAnswer) }] } }] })
  }
  return realFetch(url as string, init)
}) as typeof fetch

const call = async (path: string, token: string, body: Record<string, unknown>) => {
  const res = await app.request(
    `/internal/support${path}`,
    { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  )
  return { status: res.status, json: (await res.json()) as any }
}

try {
  // AI が引き継ぐと決めたら waiting_staff になり、運営の一覧に出る
  const first = await call("/messages", "internal", { userId: "10", body: "ボタンが押せません" })
  assert.equal(first.status, 200)
  const ticket = first.json.data.ticket
  assert.equal(ticket.status, "waiting_staff")
  assert.ok(ticket.escalatedAt)

  // 対応エージェントのトークンは /admin/* だけ使える
  const list = await call("/admin/tickets", "agent", { status: "waiting_staff" })
  assert.equal(list.status, 200)
  assert.equal(list.json.data.tickets.length, 1)
  assert.equal((await call("/messages", "agent", { userId: "10", body: "x" })).status, 401)
  assert.equal((await call("/admin/tickets", "wrong", {})).status, 401)

  // 確認中に利用者が書き足したら、確認中のまま運営に知らせる
  nextAnswer = { answer: "受け取りました", handoff: false, category: "bug", summary: "追加" }
  await call("/admin/ticket", "agent", { ticketId: ticket.id }) // 既読にする
  const more = await call("/messages", "internal", { userId: "10", ticketId: ticket.id, body: "スマホです" })
  assert.equal(more.json.data.ticket.status, "waiting_staff")
  assert.equal(Boolean(more.json.data.ticket.staffUnread), true)

  // 運営が返事をすると staff_replied になり、利用者に未読が付く
  const reply = await call("/admin/reply", "agent", { ticketId: ticket.id, body: "直しました" })
  assert.equal(reply.status, 200)
  assert.equal(reply.json.data.ticket.status, "staff_replied")
  assert.equal(Boolean(reply.json.data.ticket.userUnread), true)

  // 「運営に相談したい」も引き継ぎになる（Discord ではなくこのチャットで返事する）
  const second = await call("/messages", "internal", { userId: "11", body: "質問です" })
  const escalated = await call("/escalate", "internal", { userId: "11", ticketId: second.json.data.ticket.id })
  assert.equal(escalated.json.data.ticket.status, "waiting_staff")
  assert.match(escalated.json.data.messages[0].body, /このチャットでお返事します/)
  console.log("support handoff: ok")
} finally {
  globalThis.fetch = realFetch
  await d1.dispose()
}
