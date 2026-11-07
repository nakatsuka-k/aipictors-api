// @ts-nocheck
// Cloudflare の外（Fly の生成ワーカー）から生成の D1（GENLOG）を読み書きする入口。内部トークンが必要。
// D1 は Worker からしか直接使えないので、ワーカーは SQL をここへ送る（SQLite の SQL、引数は $1 … か ?1 …）。
//   POST /internal/d1/genlog/query  { sql, params }            → { rows, changes, lastRowId }
//   POST /internal/d1/genlog/batch  { statements: [{ sql, params }] } → { results: [...] }（1 つのトランザクション）
// コイン・サブスクの DB（DB）は対象外（それらは従来どおり /internal/coins などの API を使う）
import { Hono } from "hono"
import { requireInternalAuth } from "../lib/auth"
import { getGenlogDb } from "../lib/db"
import { json } from "../lib/json"

const MAX_STATEMENTS = 50
// 表を作り変える文は通さない（表の定義は migrations/genlog で管理する）
const FORBIDDEN = /^\s*(DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM)\b/i

const parseStatement = (value) => {
  if (!value || typeof value.sql !== "string" || value.sql.length === 0 || value.sql.length > 20000) return null
  if (FORBIDDEN.test(value.sql)) return null
  if (value.params !== undefined && !Array.isArray(value.params)) return null
  return { text: value.sql, params: value.params ?? [] }
}

export const d1ProxyRoutes = new Hono()
d1ProxyRoutes.use("*", requireInternalAuth)

d1ProxyRoutes.post("/genlog/query", async (c) => {
  const statement = parseStatement(await c.req.json().catch(() => null))
  if (!statement) return json({ error: "Invalid statement" }, 400)
  const db = await getGenlogDb(c.env)
  const [result] = await db.batch([statement])
  return json({ error: null, rows: result.rows, changes: result.changes, lastRowId: result.lastRowId })
})

d1ProxyRoutes.post("/genlog/batch", async (c) => {
  const body = await c.req.json().catch(() => null)
  const list = Array.isArray(body?.statements) ? body.statements : null
  if (!list || list.length === 0 || list.length > MAX_STATEMENTS) return json({ error: "Invalid statements" }, 400)
  const statements = list.map(parseStatement)
  if (statements.some((s) => s === null)) return json({ error: "Invalid statement" }, 400)
  const db = await getGenlogDb(c.env)
  const results = await db.batch(statements)
  return json({ error: null, results })
})
