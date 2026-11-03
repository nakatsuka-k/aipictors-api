// DB の行から API の形へ（おすすめ設定・ライセンスの読み取りを含む）
import type { UserModelKind, UserModelStatus } from "./common"
import { bad, oneOf } from "./input"
export type UserModelRow = {
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
  recommended_settings?: string | null
}

export const parseJsonArray = (value: string | null | undefined): string[] => {
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

// ---- おすすめの生成設定 ----
// 生成サーバーが扱える値だけ受け付ける（aipictors-system lib/generation-sampler.ts と同じ一覧）
export const USER_MODEL_RECOMMENDED_SAMPLERS = [
  "Euler a",
  "Euler",
  "Heun",
  "LMS",
  "DPM2",
  "DPM2 a",
  "DPM++ 2S a",
  "DPM++ SDE",
  "DPM++ 2M",
  "DPM++ 2M SDE",
  "ER SDE",
  "DDIM",
] as const

export const USER_MODEL_RECOMMENDED_SCHEDULERS = ["Karras", "Exponential", "SGM Uniform", "Simple", "Normal", "Beta"] as const

export type UserModelRecommendedSettings = {
  sampler: string | null
  scheduler: string | null
  cfgScale: number | null
  steps: number | null
  clipSkip: number | null
  /** プロンプトの先頭に足す品質タグ */
  qualityPrompt: string | null
  negativePrompt: string | null
  /** 自動で入れたもの（登録者が入れたものにはない）。civitai=作例から / base-model=ベースモデルの定番 */
  source?: "civitai" | "base-model"
  /** source=civitai のとき、集計した作例の数 */
  sampleCount?: number
}

const USER_MODEL_RECOMMENDED_PROMPT_MAX = 2000

const promptOrNull = (value: unknown, field: string) => {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw bad("INVALID_INPUT", `${field} は文字列です`)
  const text = value.trim()
  if (text.length > USER_MODEL_RECOMMENDED_PROMPT_MAX) {
    throw bad("INVALID_INPUT", `${field} は ${USER_MODEL_RECOMMENDED_PROMPT_MAX} 文字までです`)
  }
  return text === "" ? null : text
}

const intInRange = (value: unknown, min: number, max: number, field: string) => {
  if (value === undefined || value === null) return null
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw bad("INVALID_INPUT", `${field} は ${min}〜${max} の整数です`)
  }
  return value
}

// null で消す。undefined は変更なし。全部空なら null（未設定）
export const parseRecommendedSettings = (value: unknown): UserModelRecommendedSettings | null | undefined => {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) throw bad("INVALID_INPUT", "recommendedSettings はオブジェクトです")
  const v = value as Record<string, unknown>
  const pick = <T extends string>(x: unknown, values: readonly T[], field: string) =>
    x === undefined || x === null || x === "" ? null : (oneOf(x, values, field) ?? null)
  const settings: UserModelRecommendedSettings = {
    sampler: pick(v.sampler, USER_MODEL_RECOMMENDED_SAMPLERS, "recommendedSettings.sampler"),
    scheduler: pick(v.scheduler, USER_MODEL_RECOMMENDED_SCHEDULERS, "recommendedSettings.scheduler"),
    cfgScale: intInRange(v.cfgScale, 1, 30, "recommendedSettings.cfgScale"),
    steps: intInRange(v.steps, 1, 50, "recommendedSettings.steps"),
    clipSkip: intInRange(v.clipSkip, 1, 12, "recommendedSettings.clipSkip"),
    qualityPrompt: promptOrNull(v.qualityPrompt, "recommendedSettings.qualityPrompt"),
    negativePrompt: promptOrNull(v.negativePrompt, "recommendedSettings.negativePrompt"),
  }
  return Object.values(settings).every((x) => x === null) ? null : settings
}

export const readRecommendedSettings = (value: string | null | undefined): UserModelRecommendedSettings | null => {
  if (!value) return null
  try {
    const raw = JSON.parse(value)
    const settings = parseRecommendedSettings(raw)
    if (!settings) return null
    // 自動で入れた印は登録者の入力からは受け取らない（保存時にサーバーが決める）
    if (raw.source === "civitai" || raw.source === "base-model") settings.source = raw.source
    if (typeof raw.sampleCount === "number") settings.sampleCount = raw.sampleCount
    return settings
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
    // 登録者が勧める生成設定（未設定は null）
    recommendedSettings: readRecommendedSettings(row.recommended_settings),
    // 生成リクエストでの書き方（CONTRACT.md）
    fileName: `user_${row.id}.safetensors`,
    generationModel: row.kind === "CHECKPOINT" ? `user/${row.id}.safetensors` : null,
    loraName: row.kind === "LORA" ? `user_${row.id}` : null,
    promptSyntax: row.kind === "LORA" ? `<lora:user_${row.id}:${recommendedWeight}>` : null,
  }
}

export type UserModel = ReturnType<typeof toUserModel>
