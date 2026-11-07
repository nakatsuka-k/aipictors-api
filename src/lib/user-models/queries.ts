// 読み取り（一覧・自分のモデル・上限）
import { resolveCoinPlanType } from "../daily-coins"
import {
  USER_MODEL_BASE_MODELS,
  USER_MODEL_KINDS,
  USER_MODEL_RATINGS,
  UserModelError,
  getUserModelSettings,
  isUserModelId,
} from "./common"
import type { Db, UserModelStatus } from "./common"
import { oneOf } from "./input"
import { toUserModel } from "./serialize"
import type { UserModelRow } from "./serialize"
// ---- 取得 ----

export const getRow = (db: Db, id: string) =>
  db.queryOne<UserModelRow>("SELECT * FROM user_models WHERE id = $1", [id])

export const requireRow = async (db: Db, id: string, opts: { userId?: string | null; statuses?: UserModelStatus[] } = {}) => {
  const row = isUserModelId(id) ? await getRow(db, id) : null
  if (!row || row.status === "DELETED") {
    throw new UserModelError(404, "NOT_FOUND", "モデルが見つかりません")
  }
  if (opts.userId !== undefined && opts.userId !== null && row.user_id !== opts.userId) {
    throw new UserModelError(403, "FORBIDDEN", "このモデルを操作する権限がありません")
  }
  if (opts.statuses && !opts.statuses.includes(row.status)) {
    throw new UserModelError(409, "INVALID_STATUS", `モデルの状態が ${row.status} のため操作できません`)
  }
  return row
}

export const getUserModel = async (db: Db, id: string) => toUserModel(await requireRow(db, id))

export type ListUserModelsQuery = {
  kind?: string | null
  q?: string | null
  baseModel?: string | null
  sort?: string | null
  ratings?: string | null
  userId?: string | null
  tag?: string | null
  offset?: string | number | null
  limit?: string | number | null
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (m) => `\\${m}`)

export const listUserModels = async (db: Db, query: ListUserModelsQuery) => {
  const kind = query.kind ? oneOf(query.kind, USER_MODEL_KINDS, "kind") : null
  const baseModel = query.baseModel ? oneOf(query.baseModel, USER_MODEL_BASE_MODELS, "baseModel") : null
  const ratings = query.ratings
    ? query.ratings.split(",").map((r) => oneOf(r.trim(), USER_MODEL_RATINGS, "ratings"))
    : null
  const q = query.q?.trim() ? `%${escapeLike(query.q.trim().slice(0, 100))}%` : null
  const tag = query.tag?.trim() ? JSON.stringify(query.tag.trim()) : null
  const offset = Math.max(0, Math.min(10000, Number.parseInt(String(query.offset ?? "0"), 10) || 0))
  const limit = Math.max(1, Math.min(100, Number.parseInt(String(query.limit ?? "30"), 10) || 30))
  const order = query.sort === "new" ? "created_at DESC, id DESC" : "use_count DESC, created_at DESC, id DESC"
  const where = `status = 'READY'
      AND ($1 IS NULL OR kind = $1)
      AND ($2 IS NULL OR base_model = $2)
      AND ($3 IS NULL OR rating IN (SELECT value FROM json_each($3)))
      AND ($4 IS NULL OR name LIKE $4 OR trigger_words LIKE $4 OR description LIKE $4 OR tags LIKE $4)
      AND ($5 IS NULL OR user_id = $5)
      AND ($6 IS NULL OR EXISTS (SELECT 1 FROM json_each(user_models.tags) WHERE json_each.value = $6))`
  const params = [kind, baseModel, ratings, q, query.userId || null, tag]
  const [rows, count] = await Promise.all([
    db.query<UserModelRow>(`SELECT * FROM user_models WHERE ${where} ORDER BY ${order} LIMIT $7 OFFSET $8`, [
      ...params,
      limit,
      offset,
    ]),
    db.queryOne<{ n: number | string }>(`SELECT COUNT(*) AS n FROM user_models WHERE ${where}`, params),
  ])
  const totalCount = Number(count?.n ?? 0)
  return { models: rows.map(toUserModel), totalCount, offset, limit, hasMore: offset + rows.length < totalCount }
}

export const getUserModelLimit = async (db: Db, userId: string, callerPlan: unknown, now: number) => {
  const [{ limits }, planType] = await Promise.all([getUserModelSettings(db), resolveCoinPlanType(db, userId, callerPlan, now)])
  return { planType, limit: limits[planType] }
}

export const listMyUserModels = async (db: Db, userId: string, callerPlan: unknown, now: number) => {
  const [rows, { planType, limit }] = await Promise.all([
    db.query<UserModelRow>(
      "SELECT * FROM user_models WHERE user_id = $1 AND status <> 'DELETED' ORDER BY created_at DESC, id DESC",
      [userId],
    ),
    getUserModelLimit(db, userId, callerPlan, now),
  ])
  return { models: rows.map(toUserModel), limit, used: rows.length, planType }
}
