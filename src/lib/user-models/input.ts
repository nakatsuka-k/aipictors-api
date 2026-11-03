// 入力の検証
import { USER_MODEL_BASE_MODELS, USER_MODEL_RATINGS, UserModelError } from "./common"
import { parseRecommendedSettings } from "./serialize"
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
    recommendedSettings: parseRecommendedSettings(input.recommendedSettings),
  }
}

export const requireUserId = (value: unknown) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw bad("INVALID_INPUT", "userId が必要です")
  }
  return value
}
