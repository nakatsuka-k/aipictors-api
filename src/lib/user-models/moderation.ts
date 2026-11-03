// 通報と非表示
import type { Db } from "./common"
import { bad, oneOf } from "./input"
import { getRow, requireRow } from "./queries"
import { toUserModel } from "./serialize"
import type { UserModelRow } from "./serialize"
// ---- モデレーション（通報・無効化） ----

export const USER_MODEL_REPORT_REASONS = ["COPYRIGHT", "REAL_PERSON", "ILLEGAL", "WRONG_RATING", "BROKEN", "SPAM", "OTHER"] as const

// 未解決の通報がこの件数を超えたモデルは自動で一覧から外す（管理者が確認して戻せる）
export const USER_MODEL_AUTO_HIDE_REPORTS = 5

export const reportUserModel = async (db: Db, id: string, input: Record<string, unknown>, now: number) => {
  const userId = typeof input.userId === "string" ? input.userId.trim() : ""
  if (!userId) throw bad("INVALID_INPUT", "userId が必要です")
  const reason = oneOf(input.reason ?? null, USER_MODEL_REPORT_REASONS, "reason")!
  const detail = typeof input.detail === "string" ? input.detail.trim().slice(0, 1000) : ""
  const row = await requireRow(db, id)
  if (row.user_id === userId) throw bad("INVALID_INPUT", "自分のモデルは通報できません")
  await db.execute(
    `INSERT INTO user_model_reports(model_id, reporter_user_id, reason, detail, created_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (model_id, reporter_user_id) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail,
        created_at = EXCLUDED.created_at, resolved_at = NULL`,
    [id, userId, reason, detail, now],
  )
  const open = await db.queryOne<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM user_model_reports WHERE model_id = $1 AND resolved_at IS NULL",
    [id],
  )
  const openReports = Number(open?.n ?? 0)
  let autoHidden = false
  if (openReports >= USER_MODEL_AUTO_HIDE_REPORTS && row.status === "READY") {
    await db.execute(
      "UPDATE user_models SET status = 'DISABLED', disabled_reason = $2, updated_at = $3 WHERE id = $1 AND status = 'READY'",
      [id, `auto: ${openReports} reports`, now],
    )
    autoHidden = true
  }
  return { id, reported: true, openReports, autoHidden }
}

// 管理者による無効化 / 生成ワーカーからの sha256 不一致の通知
export const disableUserModel = async (db: Db, id: string, input: Record<string, unknown>, now: number) => {
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim().slice(0, 500) : "disabled"
  const row = await requireRow(db, id)
  if (reason === "sha256_mismatch") {
    // 同じファイルを参照するモデルはすべて使えない
    const disabled = await db.query<{ id: string }>(
      `UPDATE user_models SET status = 'DISABLED', disabled_reason = $2, updated_at = $3
        WHERE r2_key = $1 AND status = 'READY' RETURNING id`,
      [row.r2_key, reason, now],
    )
    return { id, disabledCount: disabled.length }
  }
  await db.execute("UPDATE user_models SET status = 'DISABLED', disabled_reason = $2, updated_at = $3 WHERE id = $1", [
    id,
    reason,
    now,
  ])
  await db.execute("UPDATE user_model_reports SET resolved_at = $2 WHERE model_id = $1 AND resolved_at IS NULL", [id, now])
  return { id, disabledCount: 1 }
}

export const enableUserModel = async (db: Db, id: string, now: number) => {
  await requireRow(db, id, { statuses: ["DISABLED"] })
  await db.execute("UPDATE user_models SET status = 'READY', disabled_reason = NULL, updated_at = $2 WHERE id = $1", [id, now])
  await db.execute("UPDATE user_model_reports SET resolved_at = $2 WHERE model_id = $1 AND resolved_at IS NULL", [id, now])
  return toUserModel((await getRow(db, id))!)
}

export const listUserModelReports = async (db: Db, query: { offset?: string; limit?: string }) => {
  const offset = Math.max(0, Number.parseInt(String(query.offset ?? "0"), 10) || 0)
  const limit = Math.max(1, Math.min(100, Number.parseInt(String(query.limit ?? "50"), 10) || 50))
  const rows = await db.query<UserModelRow & { report_count: number | string; reasons: string; last_reported_at: number | string }>(
    `SELECT m.*, r.report_count, r.reasons, r.last_reported_at
       FROM (SELECT model_id, COUNT(*) AS report_count, STRING_AGG(DISTINCT reason, ',') AS reasons,
                    MAX(created_at) AS last_reported_at
               FROM user_model_reports WHERE resolved_at IS NULL GROUP BY model_id) r
       JOIN user_models m ON m.id = r.model_id
      WHERE m.status <> 'DELETED'
      ORDER BY r.report_count DESC, r.last_reported_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  )
  return {
    reports: rows.map((row) => ({
      model: toUserModel(row),
      status: row.status,
      disabledReason: row.disabled_reason,
      reportCount: Number(row.report_count),
      reasons: String(row.reasons ?? "").split(",").filter(Boolean),
      lastReportedAt: Number(row.last_reported_at),
    })),
  }
}
