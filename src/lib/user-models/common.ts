// ユーザーモデルの型・定数・設定・ID
import type { CoinPlanType } from "../daily-coins"
export type Db = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
  queryOne<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | null>
  execute(text: string, params?: unknown[]): Promise<void>
  lockedQuery<T = Record<string, unknown>>(lockKeys: string[], text: string, params?: unknown[]): Promise<T[]>
  lockedQueryOne<T = Record<string, unknown>>(lockKeys: string[], text: string, params?: unknown[]): Promise<T | null>
  batch(statements: Array<{ text: string; params?: unknown[] }>): Promise<Array<{ rows: any[]; changes: number }>>
}

export type ModelBucket = Pick<R2Bucket, "createMultipartUpload" | "resumeMultipartUpload" | "get" | "delete">

export type UserModelDeps = {
  db: Db
  bucket: ModelBucket
  now: number
  /** ファイルのハッシュから元のモデル（出典・作者・ライセンス）と全年齢の作例を探す（アップロードで使う） */
  findBySha256?: (sha256: string) => Promise<{
    images: { thumbnailUrl: string; sampleImageUrls: string[] } | null
    source: { url: string; creator: string | null; license: UserModelSourceLicenseInput | null; baseModel: string | null } | null
  } | null>
}

type UserModelSourceLicenseInput = {
  allowCommercialUse: string[]
  allowDerivatives: boolean | null
  allowNoCredit: boolean | null
  allowDifferentLicense: boolean | null
}

export const USER_MODEL_KINDS = ["LORA", "CHECKPOINT"] as const

export const USER_MODEL_BASE_MODELS = ["SD1.5", "SDXL", "PONY", "ILLUSTRIOUS", "NOOBAI", "OTHER"] as const

export const USER_MODEL_RATINGS = ["G", "R15", "R18", "R18G"] as const

export type UserModelKind = (typeof USER_MODEL_KINDS)[number]

export type UserModelStatus = "UPLOADING" | "READY" | "DISABLED" | "DELETED"

export const USER_MODEL_PART_SIZE = 50 * 1024 * 1024

// 放置されたアップロード（ブラウザを閉じた等）はこの時間で破棄し、上限の枠を空ける
export const STALE_UPLOAD_SECONDS = 24 * 60 * 60

const GB = 1024 * 1024 * 1024

// 1 か月（JST の 1 日 00:00 から）に登録できる合計サイズ（バイト）。個数は数えない。
// 登録したモデルは作者が削除できないので、枠は毎月 1 日に戻る
export const defaultUserModelLimitBytes: Record<CoinPlanType, number> = {
  FREE: 10 * GB,
  LITE: 30 * GB,
  STANDARD: 60 * GB,
  PREMIUM: 150 * GB,
}

/** 枠の表示用（例: 10GB、2.35GB、0.4GB） */
export const formatGb = (bytes: number) => `${Number((bytes / GB).toFixed(2))}GB`

const JST_OFFSET_SECONDS = 9 * 60 * 60

/** その月（JST）の 1 日 00:00 と、次の月の 1 日 00:00（UNIX 秒） */
export const jstMonthRange = (nowSec: number) => {
  const jst = new Date((nowSec + JST_OFFSET_SECONDS) * 1000)
  const start = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1) / 1000 - JST_OFFSET_SECONDS
  const end = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 1) / 1000 - JST_OFFSET_SECONDS
  return { start, end }
}

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

// pricing_settings の user_models.limit_gb.<PLAN>（GB、小数可）/ user_models.max_bytes.<KIND> で上書きできる
export const getUserModelSettings = async (db: Db) => {
  const rows = await db.query<{ key: string; value: string }>(
    "SELECT key, value FROM pricing_settings WHERE key LIKE 'user_models.%'",
  )
  const map = new Map(rows.map((row) => [row.key, row.value]))
  const limitBytes = { ...defaultUserModelLimitBytes }
  for (const plan of Object.keys(limitBytes) as CoinPlanType[]) {
    const gb = Number.parseFloat(map.get(`user_models.limit_gb.${plan}`) ?? "")
    if (Number.isFinite(gb) && gb >= 0) limitBytes[plan] = Math.floor(gb * GB)
  }
  const maxBytes = { ...defaultUserModelMaxBytes }
  for (const kind of USER_MODEL_KINDS) {
    maxBytes[kind] = parseIntSetting(map.get(`user_models.max_bytes.${kind}`), maxBytes[kind])
  }
  return { limitBytes, maxBytes }
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
