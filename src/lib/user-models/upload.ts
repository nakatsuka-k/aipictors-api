// アップロード（予約・パート・完了・中止）
import {
  STALE_UPLOAD_SECONDS,
  USER_MODEL_KINDS,
  USER_MODEL_PART_SIZE,
  UserModelError,
  getUserModelSettings,
  newUserModelId,
  userModelPartCount,
  userModelPartLength,
  userModelR2Key,
} from "./common"
import type { Db, ModelBucket, UserModelDeps, UserModelKind, UserModelStatus } from "./common"
import { bad, oneOf, optionalString, parseEditable, requireUserId } from "./input"
import { getRow, getUserModelLimit, requireRow } from "./queries"
import { createSafetensorsValidator } from "./safetensors"
import { toUserModel } from "./serialize"
import type { UserModelRow, UserModelSourceLicense } from "./serialize"
// ---- アップロード ----

export const userLockKey = (userId: string) => `user-models:user:${userId}`

export const shaLockKey = (sha256: string) => `user-models:sha:${sha256}`

export const abortQuietly = async (bucket: ModelBucket, key: string, uploadId: string | null) => {
  if (!uploadId) return
  try {
    await bucket.resumeMultipartUpload(key, uploadId).abort()
  } catch (e) {
    console.warn(JSON.stringify({ event: "user_models.abort_failed", key, error: String(e) }))
  }
}

// URL からの取り込み（import_status あり）は Workflow が順番待ちになることもあるので長めに待つ
export const STALE_IMPORT_SECONDS = 3 * 24 * 60 * 60

export const cleanupStaleUploads = async (deps: UserModelDeps, userId: string) => {
  const stale = await deps.db.query<{ id: string; r2_key: string; upload_id: string | null }>(
    `WITH stale AS (
        SELECT id, r2_key, upload_id FROM user_models
         WHERE user_id = $1 AND status = 'UPLOADING'
           AND created_at < CASE WHEN import_status IS NULL THEN $2::bigint ELSE $4::bigint END
         FOR UPDATE
      ),
      upd AS (
        UPDATE user_models SET status = 'DELETED', upload_id = NULL, updated_at = $3
         WHERE id IN (SELECT id FROM stale)
      )
      SELECT id, r2_key, upload_id FROM stale`,
    [userId, deps.now - STALE_UPLOAD_SECONDS, deps.now, deps.now - STALE_IMPORT_SECONDS],
  )
  for (const row of stale) await abortQuietly(deps.bucket, row.r2_key, row.upload_id)
}

// 上限・重複を確認して行を入れる（アップロードと URL からの取り込みで共通）。同じ sha256 の READY があれば即 READY。
// existingSizeMustMatch=false（取り込み）のときは既存ファイルのサイズを使う（Civitai の申告サイズは KB 単位の概算のため）
export type ReserveUserModelInput = {
  id: string
  userId: string
  kind: UserModelKind
  sha256: string
  sizeBytes: number
  filename: string
  limit: number
  planType: string
  fields: Omit<ReturnType<typeof parseEditable>, "name"> & { name: string }
  source?: {
    url: string
    creator: string | null
    license: UserModelSourceLicense | null
    baseModel: string | null
  }
  existingSizeMustMatch?: boolean
}

export const reserveUserModelRow = async (deps: UserModelDeps, input: ReserveUserModelInput): Promise<"READY" | "UPLOADING"> => {
  const { id, userId, sha256, sizeBytes, limit, planType, fields } = input
  const sizeMustMatch = input.existingSizeMustMatch ?? true
  const result = await deps.db.lockedQueryOne<{
    used: number | string
    mine_id: string | null
    uploading_id: string | null
    existing_id: string | null
    existing_size: number | string | null
    inserted_status: UserModelStatus | null
  }>(
    [userLockKey(userId), shaLockKey(sha256)],
    `WITH existing AS (
        SELECT id, size_bytes FROM user_models WHERE sha256 = $3 AND status = 'READY' ORDER BY created_at, id LIMIT 1
      ),
      mine AS (
        SELECT id FROM user_models WHERE user_id = $2 AND sha256 = $3 AND status <> 'DELETED' LIMIT 1
      ),
      uploading AS (
        SELECT id FROM user_models WHERE sha256 = $3 AND status = 'UPLOADING' LIMIT 1
      ),
      used AS (
        SELECT COUNT(*)::int AS n FROM user_models WHERE user_id = $2 AND status <> 'DELETED'
      ),
      ins AS (
        INSERT INTO user_models(
          id, user_id, kind, name, description, base_model, trigger_words, recommended_weight, rating, tags,
          thumbnail_url, sample_image_urls, original_filename, sha256, size_bytes, r2_key, status, created_at, updated_at,
          source_url, source_creator, source_license, source_base_model, import_status, recommended_settings
        )
        SELECT $1, $2, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $3,
               CASE WHEN EXISTS (SELECT 1 FROM existing) THEN (SELECT size_bytes FROM existing) ELSE $15 END, $16,
               CASE WHEN EXISTS (SELECT 1 FROM existing) THEN 'READY' ELSE 'UPLOADING' END, $17, $17,
               $20, $21, $22, $23,
               CASE WHEN $20::text IS NULL THEN NULL WHEN EXISTS (SELECT 1 FROM existing) THEN 'DONE' ELSE 'QUEUED' END,
               $24
         WHERE (SELECT n FROM used) < $18
           AND NOT EXISTS (SELECT 1 FROM mine)
           AND (EXISTS (SELECT 1 FROM existing) OR NOT EXISTS (SELECT 1 FROM uploading))
           AND (NOT $19 OR NOT EXISTS (SELECT 1 FROM existing) OR (SELECT size_bytes FROM existing) = $15)
        RETURNING status
      )
      SELECT (SELECT n FROM used) AS used,
             (SELECT id FROM mine) AS mine_id,
             (SELECT id FROM uploading) AS uploading_id,
             (SELECT id FROM existing) AS existing_id,
             (SELECT size_bytes FROM existing) AS existing_size,
             (SELECT status FROM ins) AS inserted_status`,
    [
      id,
      userId,
      sha256,
      input.kind,
      fields.name,
      fields.description ?? "",
      fields.baseModel ?? "OTHER",
      fields.triggerWords ?? "",
      fields.recommendedWeight ?? 0.8,
      fields.rating ?? "G",
      JSON.stringify(fields.tags ?? []),
      fields.thumbnailUrl ?? null,
      JSON.stringify(fields.sampleImageUrls ?? []),
      input.filename,
      sizeBytes,
      userModelR2Key(sha256),
      deps.now,
      limit,
      sizeMustMatch,
      input.source?.url ?? null,
      input.source?.creator ?? null,
      input.source?.license ? JSON.stringify(input.source.license) : null,
      input.source?.baseModel ?? null,
      fields.recommendedSettings ? JSON.stringify(fields.recommendedSettings) : null,
    ],
  )
  if (!result?.inserted_status) {
    if (result?.mine_id) {
      throw new UserModelError(409, "ALREADY_REGISTERED", `同じファイルはすでに登録済みです（${result.mine_id}）`)
    }
    if (Number(result?.used ?? 0) >= limit) {
      throw new UserModelError(409, "LIMIT_EXCEEDED", `登録できるモデルは ${limit} 個までです（${planType}）`)
    }
    if (sizeMustMatch && result?.existing_id && Number(result.existing_size) !== sizeBytes) {
      throw bad("SIZE_MISMATCH", "sha256 とファイルサイズが一致しません")
    }
    if (result?.uploading_id) {
      throw new UserModelError(409, "ALREADY_UPLOADING", "同じファイルが他でアップロード中です。しばらくしてからやり直してください")
    }
    throw new UserModelError(500, "INSERT_FAILED", "モデルを登録できませんでした")
  }
  return result.inserted_status === "READY" ? "READY" : "UPLOADING"
}

export const createUserModelUpload = async (deps: UserModelDeps, input: Record<string, unknown>) => {
  const userId = requireUserId(input.userId)
  const kind = oneOf(input.kind, USER_MODEL_KINDS, "kind")
  if (!kind) throw bad("INVALID_INPUT", "kind が必要です")
  const filename = optionalString(input.filename, "filename", 255)
  if (!filename || !/\.safetensors$/i.test(filename)) {
    throw bad("INVALID_EXTENSION", ".safetensors 形式のファイルのみアップロードできます")
  }
  const sha256 = typeof input.sha256 === "string" ? input.sha256.toLowerCase() : ""
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw bad("INVALID_INPUT", "sha256 が不正です")
  const sizeBytes = input.sizeBytes
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 16) {
    throw bad("INVALID_INPUT", "sizeBytes が不正です")
  }
  const editable = parseEditable(input)
  if (!editable.name) throw bad("INVALID_INPUT", "name を入力してください")

  const { maxBytes } = await getUserModelSettings(deps.db)
  if (sizeBytes > maxBytes[kind]) {
    throw new UserModelError(
      400,
      "TOO_LARGE",
      `${kind === "LORA" ? "LoRA" : "チェックポイント"} は ${Math.floor(maxBytes[kind] / 1024 / 1024)}MB までです`,
    )
  }
  const { planType, limit } = await getUserModelLimit(deps.db, userId, input.planType, deps.now)
  await cleanupStaleUploads(deps, userId)

  const id = newUserModelId()
  const r2Key = userModelR2Key(sha256)
  const inserted = await reserveUserModelRow(deps, {
    id,
    userId,
    kind,
    sha256,
    sizeBytes,
    filename,
    limit,
    planType,
    fields: { ...editable, name: editable.name },
  })
  if (inserted === "READY") {
    return {
      modelId: id,
      status: "READY" as const,
      deduplicated: true,
      uploadId: null,
      partSize: USER_MODEL_PART_SIZE,
      partCount: 0,
      model: toUserModel((await getRow(deps.db, id))!),
    }
  }
  let uploadId: string
  try {
    const upload = await deps.bucket.createMultipartUpload(r2Key, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { sha256, kind },
    })
    uploadId = upload.uploadId
  } catch (e) {
    await deps.db.execute("UPDATE user_models SET status = 'DELETED', updated_at = $2 WHERE id = $1", [id, deps.now])
    throw e
  }
  await deps.db.execute("UPDATE user_models SET upload_id = $2, updated_at = $3 WHERE id = $1", [id, uploadId, deps.now])
  return {
    modelId: id,
    status: "UPLOADING" as const,
    deduplicated: false,
    uploadId,
    partSize: USER_MODEL_PART_SIZE,
    partCount: userModelPartCount(sizeBytes),
    model: null,
  }
}

export const markDeleted = (db: Db, id: string, now: number) =>
  db.execute("UPDATE user_models SET status = 'DELETED', upload_id = NULL, updated_at = $2 WHERE id = $1", [id, now])

const uploadingRow = async (deps: UserModelDeps, modelId: string, userId?: string | null) => {
  const row = await requireRow(deps.db, modelId, { userId, statuses: ["UPLOADING"] })
  if (!row.upload_id) throw new UserModelError(409, "INVALID_STATUS", "アップロードが開始されていません")
  return row
}

// パートの本文をそのまま R2 の uploadPart に流す。最初のパートは safetensors のヘッダーを検証しながら流す
export const uploadUserModelPart = async (
  deps: UserModelDeps,
  input: { modelId: string; partNumber: number; userId?: string | null; contentLength: number | null; body: ReadableStream<Uint8Array> | null },
) => {
  const row = await uploadingRow(deps, input.modelId, input.userId)
  const size = Number(row.size_bytes)
  const partCount = userModelPartCount(size)
  if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > partCount) {
    throw bad("INVALID_PART", `partNumber は 1〜${partCount} です`)
  }
  const expected = userModelPartLength(size, input.partNumber)
  if (input.contentLength === null) {
    throw new UserModelError(411, "LENGTH_REQUIRED", "Content-Length が必要です")
  }
  if (input.contentLength !== expected || !input.body) {
    throw bad("INVALID_PART_SIZE", `パート ${input.partNumber} は ${expected} バイトです`)
  }
  let stream: ReadableStream<Uint8Array> = input.body
  let validationError: UserModelError | null = null
  if (input.partNumber === 1) {
    stream = stream.pipeThrough(
      createSafetensorsValidator(size, row.kind, (e) => {
        validationError = e
      }),
    )
    // R2 は長さの分かる stream しか受け付けない
    if (typeof FixedLengthStream !== "undefined") {
      stream = stream.pipeThrough(new FixedLengthStream(expected))
    }
  }
  try {
    const part = await deps.bucket.resumeMultipartUpload(row.r2_key, row.upload_id!).uploadPart(input.partNumber, stream)
    return { partNumber: part.partNumber, etag: part.etag }
  } catch (e) {
    if (validationError) {
      // 不正なファイルはやり直しても通らないので破棄して枠を空ける
      await abortQuietly(deps.bucket, row.r2_key, row.upload_id)
      await markDeleted(deps.db, row.id, deps.now)
      throw validationError
    }
    throw e
  }
}

export const completeUserModelUpload = async (
  deps: UserModelDeps,
  input: { modelId: string; userId?: string | null; parts: unknown },
) => {
  const row = await uploadingRow(deps, input.modelId, input.userId)
  const size = Number(row.size_bytes)
  const partCount = userModelPartCount(size)
  if (!Array.isArray(input.parts)) throw bad("INVALID_PARTS", "parts が必要です")
  const parts = (input.parts as Array<{ partNumber?: unknown; etag?: unknown }>)
    .map((p) => ({ partNumber: Number(p?.partNumber), etag: String(p?.etag ?? "") }))
    .sort((a, b) => a.partNumber - b.partNumber)
  if (parts.length !== partCount || parts.some((p, i) => p.partNumber !== i + 1 || !p.etag)) {
    throw bad("INVALID_PARTS", `parts は 1〜${partCount} のすべてのパートが必要です`)
  }
  const object = await deps.bucket.resumeMultipartUpload(row.r2_key, row.upload_id!).complete(parts)
  if (object.size !== size) {
    await deps.bucket.delete(row.r2_key)
    await markDeleted(deps.db, row.id, deps.now)
    throw bad("SIZE_MISMATCH", "アップロードされたファイルのサイズが一致しません")
  }
  const updated = await deps.db.queryOne<UserModelRow>(
    `UPDATE user_models SET status = 'READY', upload_id = NULL, updated_at = $2
      WHERE id = $1 AND status = 'UPLOADING' RETURNING *`,
    [row.id, deps.now],
  )
  if (!updated) throw new UserModelError(409, "INVALID_STATUS", "アップロードはすでに完了または中止されています")
  return toUserModel(updated)
}

export const abortUserModelUpload = async (deps: UserModelDeps, input: { modelId: string; userId?: string | null }) => {
  const row = await uploadingRow(deps, input.modelId, input.userId)
  await abortQuietly(deps.bucket, row.r2_key, row.upload_id)
  await markDeleted(deps.db, row.id, deps.now)
  return { modelId: row.id, status: "DELETED" as const }
}
