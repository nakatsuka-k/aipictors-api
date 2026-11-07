// D1（SQLite）用のクライアント。Neon 版と同じ query / queryOne / execute / executeResult / lockedQuery を持つ。
// - SQL のプレースホルダは Postgres と同じ $1, $2 … のまま書ける（?1, ?2 … に置き換えて渡す。SQLite は番号付きを使える）
// - 配列の引数は JSON 文字列にして渡す。SQL 側は `IN (SELECT value FROM json_each($1))` で受ける
// - 真偽値は 1 / 0、undefined は NULL
// - D1 は 1 つの DB への書き込みを 1 本ずつ順に実行する。1 文はそれだけで原子的なので、
//   Postgres 版でユーザごとのロックを取っていた lockedQuery はロックなしの 1 文でよい
// - 複数の文をまとめて原子的に実行したいときは batch（1 つのトランザクション。途中で失敗するとすべて取り消し）。
//   「前の文が 1 行も変えなかったら全部取り消す」は guard() を挟む（d1_guard 表の CHECK 制約で失敗させる）

type D1Like = {
  prepare(query: string): D1PreparedLike
  batch(statements: D1PreparedLike[]): Promise<Array<{ results?: unknown[]; meta?: { changes?: number; last_row_id?: number } }>>
}
type D1PreparedLike = {
  bind(...values: unknown[]): D1PreparedLike
  all(): Promise<{ results?: unknown[]; meta?: { changes?: number; last_row_id?: number } }>
  run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>
}

export type Statement = { text: string; params?: unknown[] }
export type BatchResult = { rows: Record<string, unknown>[]; changes: number; lastRowId: number | null }

// 文字列リテラル・識別子の引用の中は置き換えない
export const toSqlitePlaceholders = (text: string) => {
  let out = ""
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      out += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      out += ch
      continue
    }
    if (ch === "$" && /[0-9]/.test(text[i + 1] ?? "")) {
      out += "?"
      continue
    }
    out += ch
  }
  return out
}

// 生成の表の日時は Neon（timestamp without time zone）と同じ「YYYY-MM-DD HH:MM:SS.sss」の文字列で持つ。
// Neon の時と同じく、Date は UTC の時刻、ISO 形式の文字列はタイムゾーンを無視した時刻として入れる（文字列の大小で比べられる）
const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:Z|[+-]\d{2}:?\d{2})?$/
export const toTimestampText = (value: Date | string) => {
  if (value instanceof Date) return value.toISOString().replace("T", " ").replace("Z", "")
  const m = ISO_TIMESTAMP.exec(value)
  return m ? `${m[1]} ${m[2]}` : value
}

export const toSqliteParam = (value: unknown) => {
  if (value === undefined) return null
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "bigint") return Number(value)
  if (value instanceof Date) return toTimestampText(value)
  if (typeof value === "string" && ISO_TIMESTAMP.test(value)) return toTimestampText(value)
  if (Array.isArray(value)) return JSON.stringify(value)
  if (value !== null && typeof value === "object") return JSON.stringify(value)
  return value
}

// Postgres で boolean だった列（D1 では 0 / 1）。応答の形を変えないよう、読んだときに true / false に戻す。
// 別名（camelCase）で読んでいる箇所もあるので両方
const BOOLEAN_COLUMNS = new Set(
  [
    "is_anonymous", "show_nickname", "celebrate", "expiry_dm", "in_guild", "is_achievement_visible",
    "is_deleted", "is_reserved", "is_protected", "is_generated", "is_disabled", "staff_unread", "user_unread", "is_stripe",
  ].flatMap((name) => [name, name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())]),
)
// 生成の表の日時の列。Neon の driver は Date で返していた（JSON にすると ISO 形式の UTC）ので同じ形にする
const TIMESTAMP_COLUMNS = new Set(
  ["request_time", "generation_time", "request_to_sd_time", "created_at", "updated_at"].flatMap((name) => [
    name,
    name.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
  ]),
)
const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/
const restoreBooleans = (rows: unknown[]) => {
  for (const row of rows as Record<string, unknown>[]) {
    for (const key in row) {
      const value = row[key]
      if (BOOLEAN_COLUMNS.has(key) && (value === 0 || value === 1)) row[key] = value === 1
      else if (TIMESTAMP_COLUMNS.has(key) && typeof value === "string" && TIMESTAMP_TEXT.test(value)) {
        row[key] = new Date(`${value.replace(" ", "T").slice(0, 23)}Z`)
      }
    }
  }
  return rows
}

// SQL の中で使っている一番大きい番号まで渡す（D1 は余った引数があるとエラーになる）
const usedParamCount = (sql: string) => {
  let max = 0
  for (const match of sql.matchAll(/\?(\d+)/g)) max = Math.max(max, Number(match[1]))
  return max
}

const sqlCache = new Map<string, { sql: string; count: number }>()
const compile = (text: string) => {
  let compiled = sqlCache.get(text)
  if (!compiled) {
    const sql = toSqlitePlaceholders(text)
    compiled = { sql, count: usedParamCount(sql) }
    if (sqlCache.size > 2000) sqlCache.clear()
    sqlCache.set(text, compiled)
  }
  return compiled
}

export const GUARD_TABLE_SQL = "CREATE TABLE IF NOT EXISTS d1_guard (ok INTEGER NOT NULL CONSTRAINT d1_guard_failed CHECK (ok = 1))"
// 直前の文で変わった行数が条件を満たさなければ batch 全体を取り消す
export const guard = (condition = "changes() > 0"): Statement => ({
  text: `INSERT INTO d1_guard(ok) SELECT CASE WHEN ${condition} THEN 1 ELSE 0 END`,
})
export const guardCleanup: Statement = { text: "DELETE FROM d1_guard" }
export const isGuardFailure = (error: unknown) => String((error as Error)?.message ?? error).includes("d1_guard_failed")

// エラーに SQL の先頭を付ける（引数の値は付けない）
const withSql = async <T>(sql: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    err.message = `${err.message} [sql: ${sql.replace(/\s+/g, " ").slice(0, 160)}]`
    throw err
  }
}

export const createD1Client = (d1: D1Like) => {
  const prepare = (text: string, params: unknown[] = []) => {
    const { sql, count } = compile(text)
    const values = params.slice(0, count).map(toSqliteParam)
    while (values.length < count) values.push(null)
    const statement = d1.prepare(sql)
    return values.length > 0 ? statement.bind(...values) : statement
  }
  const client = {
    dialect: "sqlite" as const,
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      const result = await withSql(text, () => prepare(text, params).all())
      return restoreBooleans(result.results ?? []) as T[]
    },
    async queryOne<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | null> {
      const rows = await client.query<T>(text, params)
      return rows[0] ?? null
    },
    async execute(text: string, params: unknown[] = []) {
      await withSql(text, () => prepare(text, params).run())
    },
    async executeResult(text: string, params: unknown[] = []) {
      const result = await withSql(text, () => prepare(text, params).run())
      return { rowCount: result.meta?.changes ?? 0, lastRowId: result.meta?.last_row_id ?? null }
    },
    // D1 では 1 文が原子的で、書き込みは 1 本ずつ順に実行されるのでロックは要らない
    async lockedQuery<T = Record<string, unknown>>(_lockKeys: string[], text: string, params: unknown[] = []): Promise<T[]> {
      return client.query<T>(text, params)
    },
    async lockedQueryOne<T = Record<string, unknown>>(_lockKeys: string[], text: string, params: unknown[] = []): Promise<T | null> {
      return client.queryOne<T>(text, params)
    },
    // まとめて 1 つのトランザクションで実行する（途中で失敗したらすべて取り消し）
    async batch(statements: Statement[]): Promise<BatchResult[]> {
      if (statements.length === 0) return []
      const results = await withSql(statements.map((s) => s.text).join(" ; "), () =>
        d1.batch(statements.map((s) => prepare(s.text, s.params ?? []))),
      )
      return results.map((r) => ({
        rows: restoreBooleans(r.results ?? []) as Record<string, unknown>[],
        changes: r.meta?.changes ?? 0,
        lastRowId: r.meta?.last_row_id ?? null,
      }))
    },
  }
  return client
}

export type D1Client = ReturnType<typeof createD1Client>
