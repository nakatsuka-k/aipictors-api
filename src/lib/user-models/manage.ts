// 更新・削除・利用の記録・ファイルの配信
import { UserModelError, isUserModelId } from "./common"
import type { Db, UserModelDeps } from "./common"
import { bad, parseEditable, requireUserId } from "./input"
import { requireRow } from "./queries"
import { parseJsonArray, parseRecommendedSettings, readRecommendedSettings, toUserModel } from "./serialize"
import type { UserModelRecommendedSettings, UserModelRow } from "./serialize"
import { abortQuietly, shaLockKey } from "./upload"
// ---- 編集・削除 ----

export const updateUserModel = async (db: Db, id: string, input: Record<string, unknown>, now: number) => {
  const userId = requireUserId(input.userId)
  const row = await requireRow(db, id, { userId })
  const e = parseEditable(input)
  // サムネイルは消せない。残っている画像があればその 1 枚目にする
  const nextSamples = e.sampleImageUrls ?? parseJsonArray(row.sample_image_urls)
  const nextThumbnailUrl =
    e.thumbnailUrl === null ? (nextSamples[0] ?? null) : e.thumbnailUrl
  if (e.thumbnailUrl === null && nextThumbnailUrl === null) {
    throw bad("THUMBNAIL_REQUIRED", "サムネイルは外せません。別の画像を設定してください")
  }

  // 他の項目だけ直したときは、自動で入れた印を残す（中身が変わったら登録者のもの）
  const currentSettings = readRecommendedSettings(row.recommended_settings)
  const withoutSource = (settings: UserModelRecommendedSettings | null | undefined) =>
    settings ? parseRecommendedSettings({ ...settings, source: undefined, sampleCount: undefined }) : null
  const isSettingsUnchanged =
    e.recommendedSettings !== undefined &&
    JSON.stringify(withoutSource(e.recommendedSettings)) === JSON.stringify(withoutSource(currentSettings))
  const nextSettings = isSettingsUnchanged ? currentSettings : e.recommendedSettings
  const updated = await db.queryOne<UserModelRow>(
    `UPDATE user_models SET
        name = COALESCE($2, name),
        description = COALESCE($3, description),
        base_model = COALESCE($4, base_model),
        trigger_words = COALESCE($5, trigger_words),
        recommended_weight = COALESCE($6, recommended_weight),
        rating = COALESCE($7, rating),
        tags = COALESCE($8, tags),
        thumbnail_url = CASE WHEN $9 THEN $10 ELSE thumbnail_url END,
        sample_image_urls = COALESCE($11, sample_image_urls),
        updated_at = $12,
        recommended_settings = CASE WHEN $13 THEN $14 ELSE recommended_settings END,
        recommended_settings_auto_at = CASE WHEN $13 THEN COALESCE(recommended_settings_auto_at, $12) ELSE recommended_settings_auto_at END
      WHERE id = $1 AND status <> 'DELETED'
      RETURNING *`,
    [
      row.id,
      e.name ?? null,
      e.description ?? null,
      e.baseModel ?? null,
      e.triggerWords ?? null,
      e.recommendedWeight ?? null,
      e.rating ?? null,
      e.tags ? JSON.stringify(e.tags) : null,
      nextThumbnailUrl !== undefined,
      nextThumbnailUrl ?? null,
      e.sampleImageUrls ? JSON.stringify(e.sampleImageUrls) : null,
      now,
      e.recommendedSettings !== undefined,
      nextSettings ? JSON.stringify(nextSettings) : null,
    ],
  )
  if (!updated) throw new UserModelError(404, "NOT_FOUND", "モデルが見つかりません")
  return toUserModel(updated)
}

// 論理削除。同じファイルを参照する行が残っていなければ R2 からも削除する
export const deleteUserModel = async (deps: UserModelDeps, id: string, userIdInput: unknown) => {
  const userId = requireUserId(userIdInput)
  const row = await requireRow(deps.db, id, { userId })
  const result = await deps.db.lockedQueryOne<{ deleted: string | null; refs: number | string }>(
    [shaLockKey(row.sha256)],
    `WITH target AS (
        UPDATE user_models SET status = 'DELETED', upload_id = NULL, updated_at = $3
         WHERE id = $1 AND user_id = $2 AND status <> 'DELETED'
        RETURNING id
      )
      SELECT (SELECT id FROM target) AS deleted,
             (SELECT COUNT(*) FROM user_models WHERE r2_key = $4 AND status <> 'DELETED' AND id <> $1) AS refs`,
    [row.id, userId, deps.now, row.r2_key],
  )
  if (!result?.deleted) throw new UserModelError(404, "NOT_FOUND", "モデルが見つかりません")
  let fileDeleted = false
  if (row.status === "UPLOADING") {
    await abortQuietly(deps.bucket, row.r2_key, row.upload_id)
  } else if (Number(result.refs) === 0) {
    await deps.bucket.delete(row.r2_key)
    fileDeleted = true
  }
  return { modelId: row.id, status: "DELETED" as const, fileDeleted }
}

// ---- 生成側から ----

export const markUserModelUsed = async (db: Db, id: string, countInput: unknown, now: number) => {
  const count = countInput === undefined ? 1 : Number(countInput)
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw bad("INVALID_INPUT", "count は 1〜1000 です")
  const row = isUserModelId(id)
    ? await db.queryOne<{ use_count: number | string; last_used_at: number | string }>(
        `UPDATE user_models SET use_count = use_count + $2, last_used_at = $3
          WHERE id = $1 AND status IN ('READY', 'DISABLED') RETURNING use_count, last_used_at`,
        [id, count, now],
      )
    : null
  if (!row) throw new UserModelError(404, "NOT_FOUND", "モデルが見つかりません")
  return { id, useCount: Number(row.use_count), lastUsedAt: Number(row.last_used_at) }
}

// GPU 側がダウンロード後に計算した sha256 を報告する。不一致なら同じファイルを参照する READY の行をすべて DISABLED に
export const verifyUserModelFile = async (db: Db, id: string, sha256Input: unknown, now: number) => {
  const actual = typeof sha256Input === "string" ? sha256Input.toLowerCase() : ""
  if (!/^[0-9a-f]{64}$/.test(actual)) throw bad("INVALID_INPUT", "sha256 が不正です")
  const row = await requireRow(db, id)
  if (actual === row.sha256) {
    await db.execute("UPDATE user_models SET verified_at = $2 WHERE r2_key = $1 AND verified_at IS NULL", [row.r2_key, now])
    return { id: row.id, ok: true, disabledCount: 0 }
  }
  const disabled = await db.query<{ id: string }>(
    `UPDATE user_models SET status = 'DISABLED', disabled_reason = $2, updated_at = $3
      WHERE r2_key = $1 AND status = 'READY' RETURNING id`,
    [row.r2_key, `sha256 mismatch: ${actual}`, now],
  )
  console.warn(JSON.stringify({ event: "user_models.sha256_mismatch", id: row.id, expected: row.sha256, actual }))
  return { id: row.id, ok: false, disabledCount: disabled.length }
}

// Range: bytes=a-b / bytes=a- / bytes=-n（単一範囲のみ）
export const parseRangeHeader = (header: string | null | undefined, size: number) => {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === "" && m[2] === "")) return "invalid" as const
  let start: number
  let end: number
  if (m[1] === "") {
    const suffix = Number(m[2])
    if (suffix === 0) return "invalid" as const
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return "invalid" as const
  return { offset: start, length: end - start + 1 }
}

export const getUserModelFileResponse = async (deps: Pick<UserModelDeps, "db" | "bucket">, id: string, rangeHeader: string | null) => {
  const row = await requireRow(deps.db, id, { statuses: ["READY"] })
  const size = Number(row.size_bytes)
  const range = parseRangeHeader(rangeHeader, size)
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } })
  }
  const object = await deps.bucket.get(row.r2_key, range ? { range } : undefined)
  if (!object || !("body" in object) || !object.body) {
    throw new UserModelError(404, "FILE_MISSING", "モデルのファイルが見つかりません")
  }
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="user_${row.id}.safetensors"`,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "x-model-sha256": row.sha256,
    "x-model-size": String(size),
  })
  if (object.httpEtag) headers.set("etag", object.httpEtag)
  if (range) {
    headers.set("content-length", String(range.length))
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`)
    return new Response(object.body, { status: 206, headers })
  }
  headers.set("content-length", String(size))
  return new Response(object.body, { status: 200, headers })
}
