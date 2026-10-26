// ユーザーがアップロードしたモデル（LoRA / チェックポイント）
//
// - ファイルは R2（USER_MODELS）に `models/<sha256>.safetensors` で保存する。同じ sha256 の READY なモデルがあれば
//   アップロードせずにそのファイルを参照する（重複排除）。R2 のファイルは参照する行が 0 になったら削除する。
// - アップロードは R2 multipart（50MB 固定のパート、最終パート以外は同サイズ）。最初のパートを流しながら
//   safetensors のヘッダー（先頭 8 バイトの長さ＋JSON）を検証し、ヘッダーから求めたファイルサイズが申告値と一致することも確認する。
// - sha256 はクライアントの申告値。サーバーでは計算しない（重い）。GPU 側がダウンロード後に検証し、
//   不一致なら /verify で同じファイルを参照する行をすべて DISABLED にする。
// - 登録上限はプラン（resolveCoinPlanType）ごと。pricing_settings の user_models.* で上書きできる。
import { resolveCoinPlanType, type CoinPlanType } from "./daily-coins"

export type Db = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
  queryOne<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | null>
  execute(text: string, params?: unknown[]): Promise<void>
  lockedQuery<T = Record<string, unknown>>(lockKeys: string[], text: string, params?: unknown[]): Promise<T[]>
  lockedQueryOne<T = Record<string, unknown>>(lockKeys: string[], text: string, params?: unknown[]): Promise<T | null>
}

export type ModelBucket = Pick<R2Bucket, "createMultipartUpload" | "resumeMultipartUpload" | "get" | "delete">

export type UserModelDeps = { db: Db; bucket: ModelBucket; now: number }

export const USER_MODEL_KINDS = ["LORA", "CHECKPOINT"] as const
export const USER_MODEL_BASE_MODELS = ["SD1.5", "SDXL", "PONY", "ILLUSTRIOUS", "NOOBAI", "OTHER"] as const
export const USER_MODEL_RATINGS = ["G", "R15", "R18", "R18G"] as const
export type UserModelKind = (typeof USER_MODEL_KINDS)[number]
export type UserModelStatus = "UPLOADING" | "READY" | "DISABLED" | "DELETED"

export const USER_MODEL_PART_SIZE = 50 * 1024 * 1024
// 放置されたアップロード（ブラウザを閉じた等）はこの時間で破棄し、上限の枠を空ける
export const STALE_UPLOAD_SECONDS = 24 * 60 * 60
// safetensors のヘッダーは最初のパートに収まっていること（仕様上の上限は 100MB だが実物は数 MB 以下）
const MAX_SAFETENSORS_HEADER_BYTES = 32 * 1024 * 1024

export const defaultUserModelLimits: Record<CoinPlanType, number> = { FREE: 1, LITE: 3, STANDARD: 10, PREMIUM: 30 }
export const defaultUserModelMaxBytes: Record<UserModelKind, number> = {
  LORA: 400 * 1024 * 1024,
  CHECKPOINT: Math.floor(7.5 * 1024 * 1024 * 1024),
}

export class UserModelError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 411 | 416 | 500 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const parseIntSetting = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

// pricing_settings の user_models.limit.<PLAN> / user_models.max_bytes.<KIND> で上書きできる
export const getUserModelSettings = async (db: Db) => {
  const rows = await db.query<{ key: string; value: string }>(
    "SELECT key, value FROM pricing_settings WHERE key LIKE 'user_models.%'",
  )
  const map = new Map(rows.map((row) => [row.key, row.value]))
  const limits = { ...defaultUserModelLimits }
  for (const plan of Object.keys(limits) as CoinPlanType[]) {
    limits[plan] = parseIntSetting(map.get(`user_models.limit.${plan}`), limits[plan])
  }
  const maxBytes = { ...defaultUserModelMaxBytes }
  for (const kind of USER_MODEL_KINDS) {
    maxBytes[kind] = parseIntSetting(map.get(`user_models.max_bytes.${kind}`), maxBytes[kind])
  }
  return { limits, maxBytes }
}

// 12 文字の英小文字＋数字（LoRA のファイル名 user_<id> に使うので記号と大文字を避ける）
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"
export const newUserModelId = () => {
  let id = ""
  while (id.length < 12) {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    for (const b of bytes) {
      if (b < 252 && id.length < 12) id += ID_ALPHABET[b % 36]
    }
  }
  return id
}

export const isUserModelId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-z]{12}$/.test(value)

export const userModelR2Key = (sha256: string) => `models/${sha256}.safetensors`

export const userModelPartCount = (sizeBytes: number) => Math.max(1, Math.ceil(sizeBytes / USER_MODEL_PART_SIZE))

export const userModelPartLength = (sizeBytes: number, partNumber: number) => {
  const count = userModelPartCount(sizeBytes)
  return partNumber < count ? USER_MODEL_PART_SIZE : sizeBytes - USER_MODEL_PART_SIZE * (count - 1)
}

type UserModelRow = {
  id: string
  user_id: string
  kind: UserModelKind
  name: string
  description: string
  base_model: string
  trigger_words: string
  recommended_weight: number | string
  rating: string
  tags: string
  thumbnail_url: string | null
  sample_image_urls: string
  original_filename: string | null
  sha256: string
  size_bytes: number | string
  r2_key: string
  upload_id: string | null
  status: UserModelStatus
  disabled_reason: string | null
  verified_at: number | string | null
  use_count: number | string
  last_used_at: number | string | null
  created_at: number | string
  updated_at: number | string
  // URL から取り込んだモデル（user-model-imports.ts）。アップロードでは NULL
  source_url?: string | null
  source_creator?: string | null
  source_license?: string | null
  source_base_model?: string | null
  import_status?: string | null
  import_parts_done?: number | string | null
  import_parts_total?: number | string | null
  import_error?: string | null
}

const parseJsonArray = (value: string | null | undefined): string[] => {
  try {
    const parsed = JSON.parse(value ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []
  } catch {
    return []
  }
}

const toNumberOrNull = (value: number | string | null | undefined) => (value === null || value === undefined ? null : Number(value))

export type UserModelSourceLicense = {
  allowCommercialUse: string[]
  allowDerivatives: boolean | null
  allowNoCredit: boolean | null
  allowDifferentLicense: boolean | null
}

// 他サービス（画像生成サービス）での利用が作者のライセンスで許可されているか。Civitai の allowCommercialUse の "Rent" / "Sell"
export const sourceLicenseAllowsOtherServices = (license: UserModelSourceLicense | null) =>
  license ? license.allowCommercialUse.some((v) => v === "Rent" || v === "Sell") : null

const parseSourceLicense = (value: string | null | undefined): UserModelSourceLicense | null => {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== "object") return null
    const bool = (v: unknown) => (typeof v === "boolean" ? v : null)
    return {
      allowCommercialUse: Array.isArray(parsed.allowCommercialUse)
        ? parsed.allowCommercialUse.filter((v: unknown) => typeof v === "string")
        : [],
      allowDerivatives: bool(parsed.allowDerivatives),
      allowNoCredit: bool(parsed.allowNoCredit),
      allowDifferentLicense: bool(parsed.allowDifferentLicense),
    }
  } catch {
    return null
  }
}

export const toUserModel = (row: UserModelRow) => {
  const recommendedWeight = Number(row.recommended_weight)
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    baseModel: row.base_model,
    triggerWords: row.trigger_words,
    recommendedWeight,
    rating: row.rating,
    tags: parseJsonArray(row.tags),
    thumbnailUrl: row.thumbnail_url,
    sampleImageUrls: parseJsonArray(row.sample_image_urls),
    originalFilename: row.original_filename,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    disabledReason: row.disabled_reason,
    verifiedAt: toNumberOrNull(row.verified_at),
    useCount: Number(row.use_count),
    lastUsedAt: toNumberOrNull(row.last_used_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    // URL から取り込んだときの出典（アップロードしたモデルは null）
    sourceUrl: row.source_url ?? null,
    sourceCreator: row.source_creator ?? null,
    sourceLicense: parseSourceLicense(row.source_license),
    sourceLicenseAllowsOtherServices: sourceLicenseAllowsOtherServices(parseSourceLicense(row.source_license)),
    sourceBaseModel: row.source_base_model ?? null,
    importStatus: row.import_status ?? null,
    // 生成リクエストでの書き方（CONTRACT.md）
    fileName: `user_${row.id}.safetensors`,
    generationModel: row.kind === "CHECKPOINT" ? `user/${row.id}.safetensors` : null,
    loraName: row.kind === "LORA" ? `user_${row.id}` : null,
    promptSyntax: row.kind === "LORA" ? `<lora:user_${row.id}:${recommendedWeight}>` : null,
  }
}

export type UserModel = ReturnType<typeof toUserModel>

// ---- 入力の検証 ----

const isHttpsUrl = (value: string) => {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

export const bad = (code: string, message: string) => new UserModelError(400, code, message)

export const optionalString = (value: unknown, field: string, max: number) => {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw bad("INVALID_INPUT", `${field} は文字列で指定してください`)
  if (value.length > max) throw bad("INVALID_INPUT", `${field} は ${max} 文字以内にしてください`)
  return value
}

export const oneOf = <T extends string>(value: unknown, values: readonly T[], field: string): T | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw bad("INVALID_INPUT", `${field} は ${values.join(" / ")} のいずれかです`)
  }
  return value as T
}

const parseTags = (value: unknown) => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 20 || value.some((v) => typeof v !== "string" || v.length > 50)) {
    throw bad("INVALID_INPUT", "tags は 50 文字以内の文字列を 20 個までです")
  }
  return [...new Set(value.map((v: string) => v.trim()).filter(Boolean))]
}

const parseUrls = (value: unknown) => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 20 || value.some((v) => typeof v !== "string" || v.length > 2000 || !isHttpsUrl(v))) {
    throw bad("INVALID_INPUT", "sampleImageUrls は https の URL を 20 個までです")
  }
  return value as string[]
}

const parseThumbnail = (value: unknown) => {
  if (value === undefined || value === null) return value as undefined | null
  if (typeof value !== "string" || value.length > 2000 || !isHttpsUrl(value)) {
    throw bad("INVALID_INPUT", "thumbnailUrl は https の URL です")
  }
  return value
}

const parseWeight = (value: unknown) => {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value < -5 || value > 5) {
    throw bad("INVALID_INPUT", "recommendedWeight は -5〜5 の数値です")
  }
  return Math.round(value * 100) / 100
}

export const parseEditable = (input: Record<string, unknown>) => {
  const name = optionalString(input.name, "name", 100)?.trim()
  if (name !== undefined && name.length === 0) throw bad("INVALID_INPUT", "name を入力してください")
  return {
    name,
    description: optionalString(input.description, "description", 5000),
    baseModel: oneOf(input.baseModel, USER_MODEL_BASE_MODELS, "baseModel"),
    triggerWords: optionalString(input.triggerWords, "triggerWords", 1000),
    recommendedWeight: parseWeight(input.recommendedWeight),
    rating: oneOf(input.rating, USER_MODEL_RATINGS, "rating"),
    tags: parseTags(input.tags),
    thumbnailUrl: parseThumbnail(input.thumbnailUrl),
    sampleImageUrls: parseUrls(input.sampleImageUrls),
  }
}

export const requireUserId = (value: unknown) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw bad("INVALID_INPUT", "userId が必要です")
  }
  return value
}

// ---- safetensors の検証 ----

export class SafetensorsError extends UserModelError {
  constructor(message: string) {
    super(400, "INVALID_SAFETENSORS", message)
  }
}

const isLoraKey = (key: string) => /lora|hada_|lokr_|\.oft_|^oft_/i.test(key)
const isFullModelKey = (key: string) =>
  key.startsWith("model.diffusion_model.") || key.startsWith("first_stage_model.") || key.startsWith("conditioner.")

// 先頭 8 バイト（ヘッダー長, u64 LE）＋ヘッダー JSON を検証する。ヘッダーの data_offsets から求めたサイズが totalSize と一致すること。
// strictKind=false のときは種類違いを KIND_MISMATCH にせず warnings に入れるだけ（Civitai から取り込む SDXL 以外の系統など、
// キーの名前から種類を判定できないことがあるため）
export type SafetensorsCheckOptions = { strictKind?: boolean; onWarning?: (message: string) => void }

export const validateSafetensorsHeader = (
  header: Uint8Array,
  totalSize: number,
  kind: UserModelKind,
  options: SafetensorsCheckOptions = {},
) => {
  const strictKind = options.strictKind ?? true
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header))
  } catch {
    throw new SafetensorsError("safetensors のヘッダーを読めません")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SafetensorsError("safetensors のヘッダーが不正です")
  }
  let dataEnd = 0
  const keys: string[] = []
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === "__metadata__") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new SafetensorsError("safetensors の __metadata__ が不正です")
      }
      continue
    }
    const tensor = value as { dtype?: unknown; shape?: unknown; data_offsets?: unknown }
    const offsets = tensor?.data_offsets
    if (
      typeof tensor?.dtype !== "string" ||
      !Array.isArray(tensor.shape) ||
      !Array.isArray(offsets) ||
      offsets.length !== 2 ||
      !offsets.every((n) => Number.isSafeInteger(n) && n >= 0) ||
      offsets[0] > offsets[1]
    ) {
      throw new SafetensorsError(`safetensors のテンソル情報が不正です: ${key.slice(0, 100)}`)
    }
    dataEnd = Math.max(dataEnd, offsets[1])
    keys.push(key)
  }
  if (keys.length === 0) {
    throw new SafetensorsError("safetensors にテンソルがありません")
  }
  if (8 + header.length + dataEnd !== totalSize) {
    throw new SafetensorsError("ファイルサイズが safetensors のヘッダーと一致しません（ファイルが壊れているか途中までです）")
  }
  const loraKeys = keys.filter(isLoraKey).length
  const fullKeys = keys.filter(isFullModelKey).length
  const mismatch =
    kind === "LORA" && loraKeys === 0 && fullKeys > 0
      ? "LoRA ではなくチェックポイントのファイルのようです"
      : kind === "CHECKPOINT" && fullKeys === 0 && loraKeys > 0
        ? "チェックポイントではなく LoRA のファイルのようです"
        : null
  if (mismatch) {
    if (strictKind) throw new UserModelError(400, "KIND_MISMATCH", mismatch)
    options.onWarning?.(mismatch)
  }
  return { tensorCount: keys.length }
}

// 流れてくるバイト列をそのまま通しながら safetensors のヘッダーを検証する TransformStream。
// 不正なら stream を error にする（R2 の uploadPart も失敗する）。onError で原因を受け取る。
export const createSafetensorsValidator = (
  totalSize: number,
  kind: UserModelKind,
  onError: (e: UserModelError) => void,
  options: SafetensorsCheckOptions = {},
) => {
  let buffer = new Uint8Array(0)
  let headerLength: number | null = null
  let done = false
  const fail = (controller: TransformStreamDefaultController<Uint8Array>, e: unknown) => {
    const error = e instanceof UserModelError ? e : new SafetensorsError("safetensors の検証に失敗しました")
    onError(error)
    controller.error(error)
  }
  const inspect = () => {
    if (headerLength === null && buffer.length >= 8) {
      const length = new DataView(buffer.buffer, buffer.byteOffset, 8).getBigUint64(0, true)
      if (length === 0n || length > BigInt(Math.min(MAX_SAFETENSORS_HEADER_BYTES, totalSize - 8, USER_MODEL_PART_SIZE - 8))) {
        throw new SafetensorsError("safetensors 形式のファイルではありません")
      }
      headerLength = Number(length)
    }
    if (headerLength !== null && buffer.length > 8 && buffer[8] !== 0x7b) {
      throw new SafetensorsError("safetensors 形式のファイルではありません")
    }
    if (headerLength !== null && buffer.length >= 8 + headerLength) {
      validateSafetensorsHeader(buffer.subarray(8, 8 + headerLength), totalSize, kind, options)
      done = true
      buffer = new Uint8Array(0)
    }
  }
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let offset = 0
      while (!done && offset < chunk.length) {
        // まず先頭 8 バイト、次にヘッダー本体だけを溜める
        const need = headerLength === null ? 8 : 8 + headerLength
        const take = chunk.subarray(offset, offset + (need - buffer.length))
        const merged = new Uint8Array(buffer.length + take.length)
        merged.set(buffer)
        merged.set(take, buffer.length)
        buffer = merged
        offset += take.length
        try {
          inspect()
        } catch (e) {
          fail(controller, e)
          return
        }
      }
      controller.enqueue(chunk)
    },
    flush(controller) {
      if (!done) {
        fail(controller, new SafetensorsError("safetensors のヘッダーが最初のパートに収まっていません"))
      }
    },
  })
}

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
      AND ($1::text IS NULL OR kind = $1)
      AND ($2::text IS NULL OR base_model = $2)
      AND ($3::text[] IS NULL OR rating = ANY($3::text[]))
      AND ($4::text IS NULL OR name ILIKE $4 OR trigger_words ILIKE $4 OR description ILIKE $4 OR tags ILIKE $4)
      AND ($5::text IS NULL OR user_id = $5)
      AND ($6::text IS NULL OR tags::jsonb @> jsonb_build_array($6::jsonb))`
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
          source_url, source_creator, source_license, source_base_model, import_status
        )
        SELECT $1, $2, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $3,
               CASE WHEN EXISTS (SELECT 1 FROM existing) THEN (SELECT size_bytes FROM existing) ELSE $15 END, $16,
               CASE WHEN EXISTS (SELECT 1 FROM existing) THEN 'READY' ELSE 'UPLOADING' END, $17, $17,
               $20, $21, $22, $23,
               CASE WHEN $20::text IS NULL THEN NULL WHEN EXISTS (SELECT 1 FROM existing) THEN 'DONE' ELSE 'QUEUED' END
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

// ---- 編集・削除 ----

export const updateUserModel = async (db: Db, id: string, input: Record<string, unknown>, now: number) => {
  const userId = requireUserId(input.userId)
  const row = await requireRow(db, id, { userId })
  const e = parseEditable(input)
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
        updated_at = $12
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
      e.thumbnailUrl !== undefined,
      e.thumbnailUrl ?? null,
      e.sampleImageUrls ? JSON.stringify(e.sampleImageUrls) : null,
      now,
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
