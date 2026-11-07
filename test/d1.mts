// テスト用の D1（Miniflare。本物の D1 と同じ SQLite と同じ制限で動く。本番にはつながらない）
// migrations/gen と migrations/genlog を流した 2 つの D1 を作って、バインドとクライアントを返す
import { Miniflare } from "miniflare"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname
const API = process.env.API_SRC ?? join(ROOT, "src")

export const splitSql = (sql: string) =>
  sql
    .replace(/^--.*$/gm, "")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)

const applyMigrations = async (d1: any, dir: string) => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const statement of splitSql(readFileSync(join(dir, file), "utf8"))) {
      await d1.prepare(statement).run()
    }
  }
}

export const createTestD1 = async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["DB", "GENLOG"],
  })
  const DB = await mf.getD1Database("DB")
  const GENLOG = await mf.getD1Database("GENLOG")
  await applyMigrations(DB, join(ROOT, "migrations/gen"))
  await applyMigrations(GENLOG, join(ROOT, "migrations/genlog"))
  const { createD1Client } = await import(`${API}/lib/db-d1.ts`)
  const db = createD1Client(DB)
  const genlog = createD1Client(GENLOG)
  return { mf, DB, GENLOG, db, genlog, dispose: () => mf.dispose() }
}
