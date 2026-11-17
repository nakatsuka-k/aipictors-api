// @ts-nocheck
// 実績: 完了した依頼のうち、依頼者が「実績として公開してよい」を許可したものを、透かし入りの画像でクリエイターの実績に出す
// - 透かし入りの画像は画像縮小 Worker（aipictors-cron image-resize-worker の POST /internal/showcase）が作り、files の showcase/ に置く。
//   元の納品画像の URL は当事者以外に出さない
// - 出す条件: 完了（COMPLETED / ADMIN_COMPLETED）・依頼者の許可あり・クリエイターが非表示にしていない・全年齢の依頼・画像ができている
// - 画像を作るのは許可・完了のときにその場で試し、できなければ 5 分ごとの runRequestJob でやり直す
import { parseJsonArray } from "./config"

const DONE = "'COMPLETED', 'ADMIN_COMPLETED'"

/** 実績に出す依頼の条件（r = coin_requests） */
export const SHOWCASE_VISIBLE_SQL = `r.status IN (${DONE}) AND r.showcase_allowed = 1 AND r.showcase_hidden = 0 AND r.is_r18 = 0 AND r.showcase_image_urls IS NOT NULL AND r.showcase_image_urls <> '[]'`

/** 透かし入りの画像を作り直すまでの間隔（混んでいた・失敗したとき） */
const RETRY_SECONDS = 30 * 60

/** 実績に載せる画像の数（納品の画像が多くても先頭から） */
const MAX_SHOWCASE_IMAGES = 4

const toShowcaseItem = (row) => ({
  requestId: String(row.id),
  planId: row.plan_id === null || row.plan_id === undefined ? null : String(row.plan_id),
  planTitle: row.plan_title ?? null,
  creatorUserId: String(row.creator_user_id),
  imageUrls: parseJsonArray(row.showcase_image_urls),
  completedAt: row.completed_at ? Number(row.completed_at) : null,
})

/** 実績の一覧（planId か creatorUserId で絞る。新しい完了順） */
export const listShowcase = async ({ db, planId = null, creatorUserId = null, limit = 24, offset = 0 }) => {
  const where = [SHOWCASE_VISIBLE_SQL]
  const params = []
  if (planId) {
    params.push(Number(planId))
    where.push(`r.plan_id = $${params.length}`)
  }
  if (creatorUserId) {
    params.push(String(creatorUserId))
    where.push(`r.creator_user_id = $${params.length}`)
  }
  if (params.length === 0) return []
  params.push(Math.min(60, Math.max(1, Math.floor(Number(limit) || 24))), Math.min(10000, Math.max(0, Math.floor(Number(offset) || 0))))
  const rows = await db.query(
    `SELECT r.id, r.plan_id, r.creator_user_id, r.showcase_image_urls, r.completed_at, p.title AS plan_title
       FROM coin_requests r LEFT JOIN request_plans p ON p.id = r.plan_id
      WHERE ${where.join(" AND ")}
      ORDER BY r.completed_at DESC, r.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  return rows.map(toShowcaseItem)
}

export const countShowcase = async ({ db, planId = null, creatorUserId = null }) => {
  const column = planId ? "r.plan_id" : "r.creator_user_id"
  const value = planId ? Number(planId) : String(creatorUserId)
  const row = await db.queryOne(`SELECT COUNT(*) AS n FROM coin_requests r WHERE ${SHOWCASE_VISIBLE_SQL} AND ${column} = $1`, [value])
  return Number(row?.n ?? 0)
}

/** 作品で納品したときは、その作品の大きいサムネイルを元にする（公開中で削除されていないものだけ） */
const workImageUrl = async (core, workId) => {
  if (!core || !workId) return null
  const row = await core
    .prepare(`SELECT large_thumbnail_image_url AS url FROM works WHERE id = ?1 AND is_deleted = 0 AND adminViewMode = 0 AND viewMode IN (0, 1) AND ageLimit = 0`)
    .bind(Number(workId))
    .first()
    .catch(() => null)
  return row?.url || null
}

/** 画像縮小 Worker に 1 枚の透かし入りを頼む。{ url } / { retry: true }（混んでいる・失敗）/ { skip: true }（作れない画像） */
const requestWatermark = async (env, url) => {
  if (!env.IMAGE_RESIZE || !env.SHOWCASE_TOKEN) return { retry: true }
  try {
    const response = await env.IMAGE_RESIZE.fetch("https://image-resize.internal/internal/showcase", {
      method: "POST",
      headers: { "content-type": "application/json", "x-showcase-token": env.SHOWCASE_TOKEN },
      body: JSON.stringify({ url }),
    })
    const data = await response.json().catch(() => ({}))
    if (response.ok && typeof data.url === "string") return { url: data.url }
    // 大きすぎる・形式が違う・見つからない画像は飛ばす（何度やっても作れない）
    if (["TOO_LARGE", "UNSUPPORTED", "NOT_FOUND", "INVALID_URL"].includes(data.error)) return { skip: true }
    return { retry: true }
  } catch {
    return { retry: true }
  }
}

/**
 * 透かし入りの画像を作って保存する（もうあれば何もしない）。
 * 1 枚でも混んでいて作れなければ保存せず、時刻だけ残してあとでやり直す
 */
export const ensureShowcaseImages = async ({ db, env, core, now, requestId }) => {
  const row = await db.queryOne(
    `SELECT id, status, is_r18, showcase_allowed, showcase_image_urls, delivery_image_urls, delivered_work_id FROM coin_requests WHERE id = $1`,
    [requestId],
  )
  if (!row || row.showcase_image_urls !== null) return { ok: true, skipped: true }
  if (!["COMPLETED", "ADMIN_COMPLETED"].includes(row.status) || Number(row.showcase_allowed) !== 1 || Number(row.is_r18) === 1) {
    return { ok: true, skipped: true }
  }
  const sources = parseJsonArray(row.delivery_image_urls).slice(0, MAX_SHOWCASE_IMAGES)
  if (sources.length === 0) {
    const url = await workImageUrl(core, row.delivered_work_id)
    if (url) sources.push(url)
  }
  const urls = []
  for (const source of sources) {
    const result = await requestWatermark(env, source)
    if (result.retry) {
      await db.execute(`UPDATE coin_requests SET showcase_failed_at = $2 WHERE id = $1`, [requestId, now])
      return { ok: false, retry: true }
    }
    if (result.url) urls.push(result.url)
  }
  // 作れる画像がなかったときも [] を入れて、やり直さない（一覧には出ない）
  await db.execute(`UPDATE coin_requests SET showcase_image_urls = $2, showcase_failed_at = NULL WHERE id = $1 AND showcase_image_urls IS NULL`, [
    requestId,
    JSON.stringify(urls),
  ])
  return { ok: true, count: urls.length }
}

/** 5 分ごと: 許可されたのに画像がまだの依頼を少しずつ作る */
export const runShowcaseJob = async ({ db, env, core, now, limit = 5 }) => {
  if (!env.IMAGE_RESIZE || !env.SHOWCASE_TOKEN) return 0
  const rows = await db.query(
    `SELECT id FROM coin_requests
      WHERE status IN (${DONE}) AND showcase_allowed = 1 AND is_r18 = 0 AND showcase_image_urls IS NULL
        AND (showcase_failed_at IS NULL OR showcase_failed_at < $1)
      ORDER BY completed_at DESC LIMIT $2`,
    [now - RETRY_SECONDS, limit],
  )
  let made = 0
  for (const row of rows) {
    const result = await ensureShowcaseImages({ db, env, core, now, requestId: row.id }).catch(() => ({ ok: false }))
    if (result.ok && !result.skipped) made++
  }
  return made
}
