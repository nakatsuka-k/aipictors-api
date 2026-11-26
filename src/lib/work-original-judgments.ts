// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// 作品がオリジナルか二次創作かの運営の判定。作品のタグ（作者の申告）とは別に、モデレーターが管理画面で付ける
// 判定は DB（aipictors-gen）の work_original_judgments、付けた・変えた・外した記録は work_original_judgment_logs、作品本体はサイトの DB（SYSTEM_CORE の works）
// 使い道: 作品ページの「オリジナル」バッジ（ORIGINAL だけ）と、作品への推しのプレミアムコイン（ORIGINAL は可、FAN_WORK は不可、未判定はタグで見る。lib/coin-support/recipient.ts）

/** ORIGINAL = オリジナル、FAN_WORK = 二次創作 */
export const WORK_ORIGINAL_JUDGMENTS = ["ORIGINAL", "FAN_WORK"]

/** 一度に読む作品の数（作品一覧の 1 ページ分） */
export const WORK_ORIGINAL_JUDGMENTS_MAX_IDS = 200

const NOTE_MAX = 500

const isWorkId = (id) => /^\d{1,12}$/.test(String(id ?? ""))

const toIds = (workIds) =>
  Array.from(new Set((workIds ?? []).map((id) => String(id)).filter(isWorkId))).slice(0, WORK_ORIGINAL_JUDGMENTS_MAX_IDS)

const toJudgment = (row, withDetail) =>
  withDetail
    ? { judgment: row.judgment, note: row.note ?? null, judgedBy: String(row.judged_by), judgedAt: Number(row.judged_at) }
    : { judgment: row.judgment }

/**
 * 作品ごとの判定。{ [workId]: { judgment } }（未判定の作品は含めない）
 * withDetail: 管理画面向けに、メモ・判定した人・日時も返す（作品ページには判定だけ出す）
 */
export const getWorkOriginalJudgments = async ({ db, workIds, withDetail = false }) => {
  const ids = toIds(workIds)
  if (ids.length === 0) return {}
  const rows = await db.query(
    `SELECT work_id, judgment, note, judged_by, judged_at FROM work_original_judgments
     WHERE work_id IN (SELECT value FROM json_each($1))`,
    [ids]
  )
  const result = {}
  for (const row of rows) result[String(row.work_id)] = toJudgment(row, withDetail)
  return result
}

/** 1 作品の判定（ORIGINAL / FAN_WORK / 未判定は null）。読めないときは null */
export const getWorkOriginalJudgment = async (db, workId) => {
  if (!db || !isWorkId(workId)) return null
  try {
    const row = await db.queryOne(`SELECT judgment FROM work_original_judgments WHERE work_id = $1`, [String(workId)])
    return WORK_ORIGINAL_JUDGMENTS.includes(row?.judgment) ? row.judgment : null
  } catch (error) {
    console.log(JSON.stringify({ event: "work_original_judgment.read_failed", message: String(error?.message ?? error) }))
    return null
  }
}

/**
 * 判定を付ける・変える（judgment が null なら外して未判定に戻す）。記録はいつも残す。消えた作品・無い作品には付けない
 * moderatorUserId はフロントのサーバーがモデレーターだと確かめて渡す
 */
export const setWorkOriginalJudgment = async ({ db, core, workId, judgment, note, moderatorUserId, now }) => {
  const id = String(workId ?? "")
  if (!isWorkId(id)) return { error: "Invalid workId", status: 400 }
  if (judgment !== null && !WORK_ORIGINAL_JUDGMENTS.includes(judgment)) return { error: "Invalid judgment", status: 400 }
  if (!/^\d{1,12}$/.test(String(moderatorUserId ?? ""))) return { error: "Invalid moderatorUserId", status: 400 }
  if (!core) return { error: "Core DB is not configured", status: 500 }
  const work = await core.prepare(`SELECT is_deleted FROM works WHERE id = ?1`).bind(Number(id)).first()
  if (!work || Number(work.is_deleted) === 1) return { error: "作品が見つかりません", status: 404 }
  const text = typeof note === "string" && note.trim().length > 0 ? note.trim().slice(0, NOTE_MAX) : null
  const by = String(moderatorUserId)
  const log = {
    text: `INSERT INTO work_original_judgment_logs (work_id, judgment, note, judged_by, judged_at) VALUES ($1, $2, $3, $4, $5)`,
    params: [id, judgment, text, by, now],
  }
  await db.batch(
    judgment === null
      ? [{ text: `DELETE FROM work_original_judgments WHERE work_id = $1`, params: [id] }, log]
      : [
          {
            text: `INSERT INTO work_original_judgments (work_id, judgment, note, judged_by, judged_at) VALUES ($1, $2, $3, $4, $5)
                   ON CONFLICT (work_id) DO UPDATE SET judgment = excluded.judgment, note = excluded.note, judged_by = excluded.judged_by, judged_at = excluded.judged_at`,
            params: [id, judgment, text, by, now],
          },
          log,
        ]
  )
  const current = await getWorkOriginalJudgments({ db, workIds: [id], withDetail: true })
  return { data: current[id] ?? null }
}

/** 1 作品の判定の記録（新しい順） */
export const listWorkOriginalJudgmentLogs = async ({ db, workId }) => {
  if (!isWorkId(workId)) return []
  const rows = await db.query(
    `SELECT judgment, note, judged_by, judged_at FROM work_original_judgment_logs WHERE work_id = $1 ORDER BY id DESC LIMIT 50`,
    [String(workId)]
  )
  return rows.map((row) => ({
    judgment: row.judgment ?? null,
    note: row.note ?? null,
    judgedBy: String(row.judged_by),
    judgedAt: Number(row.judged_at),
  }))
}
