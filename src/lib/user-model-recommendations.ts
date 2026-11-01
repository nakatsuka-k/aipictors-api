// チェックポイントのおすすめ設定を自動で作る
//
// - モデルファイルの sha256 で Civitai を引く（アップロードしたモデルも見つかる）。送るのはハッシュだけ
// - 見つかったら作例の生成情報を集計する。作者の作例を優先する（みんなの投稿には高速化 LoRA など別の設定が多く混ざり、
//   作者の説明とずれる）。足りなければみんなの投稿も使い、それでも少なければベースモデルの定番で補う
// - 登録者が入れた設定は変えない。空のモデルだけに入れる（cron で少しずつ）
// - 作例には成人向けのプロンプトも混ざるので、品質タグは決まった語だけ通し、ネガティブからも性的・年齢の語を外す
import {
  USER_MODEL_RECOMMENDED_SAMPLERS,
  USER_MODEL_RECOMMENDED_SCHEDULERS,
  type UserModelRecommendedSettings,
} from "./user-models"

type Db = {
  query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]>
  execute: (sql: string, params?: unknown[]) => Promise<unknown>
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type CivitaiImageMeta = Record<string, unknown>

const CIVITAI_API = "https://civitai.com/api/v1"
const USER_AGENT = "aipictors-user-model-import/1.0 (+https://www.aipictors.com)"

/** これより作例の生成情報が少なければ、集計しない（たまたまの設定を勧めないため） */
const MIN_SAMPLES = 3
/** 作例のこの割合以上で使われているタグだけ勧める */
const TAG_MIN_RATIO = 0.4
const MAX_QUALITY_TAGS = 10
const MAX_NEGATIVE_TAGS = 24
const MAX_STEPS = 30
const MIN_STEPS = 4
const MAX_CFG = 15

const QUALITY_TAGS = new Set([
  "masterpiece",
  "best quality",
  "amazing quality",
  "great quality",
  "high quality",
  "good quality",
  "very aesthetic",
  "aesthetic",
  "absurdres",
  "highres",
  "high resolution",
  "ultra-detailed",
  "ultra detailed",
  "highly detailed",
  "extremely detailed",
  "very awa",
  "newest",
  "score_9",
  "score_8_up",
  "score_7_up",
  "score_6_up",
  "score_8",
  "score_7",
  "8k",
  "4k",
])

const EXCLUDED_NEGATIVE =
  /\b(sex|nude|nudity|naked|nsfw|sfw|loli|shota|child|children|kid|toddler|underage|teen|penis|pussy|vagina|nipples?|breasts?|cum|rape|anal|oral|genitals?)\b/

const SAMPLER_ALIASES: Record<string, string> = {
  euler_ancestral: "Euler a",
  euler_a: "Euler a",
  euler: "Euler",
  heun: "Heun",
  lms: "LMS",
  dpm_2: "DPM2",
  dpm_2_ancestral: "DPM2 a",
  dpmpp_2s_ancestral: "DPM++ 2S a",
  dpmpp_sde: "DPM++ SDE",
  dpmpp_2m: "DPM++ 2M",
  dpmpp_2m_sde: "DPM++ 2M SDE",
  er_sde: "ER SDE",
  ddim: "DDIM",
}

const SCHEDULER_SUFFIXES: [RegExp, string][] = [
  [/[ _]karras$/i, "Karras"],
  [/[ _]exponential$/i, "Exponential"],
  [/[ _]sgm[ _]uniform$/i, "SGM Uniform"],
  [/[ _]simple$/i, "Simple"],
  [/[ _]normal$/i, "Normal"],
  [/[ _]beta$/i, "Beta"],
]

/** "DPM++ 2M Karras" や "er_sde_beta" を、サンプラーとスケジューラーに分ける */
export const normalizeSampler = (value: unknown) => {
  if (typeof value !== "string" || value.trim() === "") {
    return { sampler: null, scheduler: null }
  }
  let name = value.trim()
  let scheduler: string | null = null
  for (const [suffix, label] of SCHEDULER_SUFFIXES) {
    if (suffix.test(name)) {
      scheduler = label
      name = name.replace(suffix, "")
      break
    }
  }
  const allowed = (USER_MODEL_RECOMMENDED_SAMPLERS as readonly string[]).find(
    (sampler) => sampler.toLowerCase() === name.toLowerCase(),
  )
  const sampler = allowed ?? SAMPLER_ALIASES[name.toLowerCase()] ?? null
  return { sampler, scheduler }
}

export const normalizeScheduler = (value: unknown) => {
  if (typeof value !== "string") return null
  const name = value.trim().replace(/_/g, " ").toLowerCase()
  return (
    (USER_MODEL_RECOMMENDED_SCHEDULERS as readonly string[]).find(
      (scheduler) => scheduler.toLowerCase() === name,
    ) ?? null
  )
}

const toNumber = (value: unknown) => {
  const number = typeof value === "string" ? Number(value) : value
  return typeof number === "number" && Number.isFinite(number) ? number : null
}

/** プロンプトをタグに分ける（重み・LoRA・埋め込みは外す） */
export const splitPromptTags = (prompt: unknown): string[] => {
  if (typeof prompt !== "string") return []
  const tags = prompt
    .replace(/<[^>]*>/g, ",")
    .replace(/\bBREAK\b/g, ",")
    .split(/[,\n]/)
    .map((tag) =>
      tag
        .replace(/:[\d.]+\s*\)?/g, "")
        .replace(/[()[\]{}]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase(),
    )
    .filter((tag) => tag !== "" && tag.length <= 40 && !tag.startsWith("embedding:"))
  return [...new Set(tags)]
}

const mode = <T>(values: T[]): T | null => {
  const counts = new Map<T, number>()
  let best: T | null = null
  let bestCount = 0
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1
    counts.set(value, count)
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

const median = (values: number[]) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? null
}

/** 多くの作例で使われているタグを、多い順に */
const commonTags = (
  prompts: string[][],
  isAllowed: (tag: string) => boolean,
  limit: number,
) => {
  const counts = new Map<string, number>()
  for (const tags of prompts) {
    for (const tag of tags) {
      if (isAllowed(tag)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  const threshold = Math.max(2, prompts.length * TAG_MIN_RATIO)
  return [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag)
}

/** score_9, score_8_up, … は数の大きい順に並べるのが決まりなので先頭にまとめる */
const orderQualityTags = (tags: string[]) => [
  ...tags.filter((tag) => tag.startsWith("score_")).sort((a, b) => b.localeCompare(a)),
  ...tags.filter((tag) => !tag.startsWith("score_")),
]

const ILLUSTRIOUS_DEFAULTS: Partial<UserModelRecommendedSettings> = {
  sampler: "Euler a",
  cfgScale: 5,
  steps: 28,
  clipSkip: 2,
  qualityPrompt: "masterpiece, best quality, amazing quality, very aesthetic, absurdres, newest",
  negativePrompt: "lowres, worst quality, bad quality, bad anatomy, bad hands, jpeg artifacts, signature, watermark, text, blurry",
}

/** ベースモデルの定番（作例から作れないときに使う） */
const BASE_MODEL_DEFAULTS: Record<string, Partial<UserModelRecommendedSettings>> = {
  ILLUSTRIOUS: ILLUSTRIOUS_DEFAULTS,
  NOOBAI: ILLUSTRIOUS_DEFAULTS,
  PONY: {
    sampler: "Euler a",
    cfgScale: 7,
    steps: 25,
    clipSkip: 2,
    qualityPrompt: "score_9, score_8_up, score_7_up",
    negativePrompt: "score_4, score_5, score_6, lowres, bad anatomy, bad hands, jpeg artifacts, signature, watermark, text",
  },
  SDXL: {
    sampler: "DPM++ 2M",
    scheduler: "Karras",
    cfgScale: 6,
    steps: 28,
    qualityPrompt: "masterpiece, best quality, highly detailed",
    negativePrompt: "lowres, worst quality, low quality, bad anatomy, bad hands, jpeg artifacts, signature, watermark, text, blurry",
  },
  "SD1.5": {
    sampler: "DPM++ 2M",
    scheduler: "Karras",
    cfgScale: 7,
    steps: 25,
    qualityPrompt: "masterpiece, best quality",
    negativePrompt: "lowres, worst quality, low quality, bad anatomy, bad hands, jpeg artifacts, signature, watermark, text",
  },
}

const EMPTY: UserModelRecommendedSettings = {
  sampler: null,
  scheduler: null,
  cfgScale: null,
  steps: null,
  clipSkip: null,
  qualityPrompt: null,
  negativePrompt: null,
}

/**
 * 作例の生成情報からおすすめ設定を作る。作例が足りなければベースモデルの定番、それもなければ null
 */
export const deriveRecommendedSettings = (props: {
  metas: CivitaiImageMeta[]
  baseModel: string
}): UserModelRecommendedSettings | null => {
  const defaults = BASE_MODEL_DEFAULTS[props.baseModel] ?? null

  const samples = props.metas
    .map((meta) => {
      const { sampler, scheduler } = normalizeSampler(meta.sampler)
      return {
        sampler,
        scheduler:
          scheduler ??
          normalizeScheduler(meta["Schedule type"]) ??
          normalizeScheduler(meta.scheduler),
        cfg: toNumber(meta.cfgScale),
        steps: toNumber(meta.steps),
        clipSkip: toNumber(meta.clipSkip) ?? toNumber(meta["Clip skip"]),
        prompt: splitPromptTags(meta.prompt),
        negative: splitPromptTags(meta.negativePrompt),
      }
    })
    .filter((sample) => sample.sampler !== null || sample.cfg !== null || sample.prompt.length > 0)

  if (samples.length < MIN_SAMPLES) {
    return defaults ? { ...EMPTY, ...defaults, source: "base-model" } : null
  }

  const sampler = mode(samples.map((s) => s.sampler).filter((v) => v !== null))
  // Schedule type は選んだサンプラーの作例だけで見る
  const scheduler = mode(
    samples
      .filter((s) => s.sampler === sampler)
      .map((s) => s.scheduler)
      .filter((v) => v !== null),
  )

  const roundedCfg = (value: number | null) =>
    value === null ? null : Math.min(MAX_CFG, Math.max(1, Math.round(value)))
  const cfgScale = mode(samples.map((s) => roundedCfg(s.cfg)).filter((v) => v !== null))
  // 同じモデルでも lightning 向けの作例（CFG 1・4 steps）などが混ざるので、Steps は同じ CFG の作例で見る
  const stepsMedian = median(
    samples
      .filter((s) => roundedCfg(s.cfg) === cfgScale)
      .map((s) => s.steps)
      .filter((v) => v !== null),
  )
  const steps =
    stepsMedian === null
      ? null
      : Math.min(MAX_STEPS, Math.max(MIN_STEPS, Math.round(stepsMedian)))

  const clipSkipValues = samples.map((s) => s.clipSkip).filter((v) => v !== null)
  const clipSkip =
    clipSkipValues.length >= MIN_SAMPLES ? mode(clipSkipValues.map(Math.round)) : null

  const quality = orderQualityTags(
    commonTags(
      samples.map((s) => s.prompt),
      (tag) => QUALITY_TAGS.has(tag),
      MAX_QUALITY_TAGS,
    ),
  )
  const negative = commonTags(
    samples.map((s) => s.negative),
    (tag) => !EXCLUDED_NEGATIVE.test(tag),
    MAX_NEGATIVE_TAGS,
  )

  // 作例のタグが少ないときは定番で補う（作例に多いものを先に）
  const withDefaults = (tags: string[], defaultText: string | null | undefined, minimum: number) =>
    tags.length >= minimum || !defaultText
      ? tags
      : [...new Set([...tags, ...splitPromptTags(defaultText)])]
  const qualityTags = withDefaults(quality, defaults?.qualityPrompt, 2)
  const negativeTags = withDefaults(negative, defaults?.negativePrompt, 5)

  return {
    sampler: sampler ?? defaults?.sampler ?? null,
    scheduler: scheduler ?? (sampler ? null : (defaults?.scheduler ?? null)),
    cfgScale: cfgScale ?? defaults?.cfgScale ?? null,
    steps: steps ?? defaults?.steps ?? null,
    clipSkip: clipSkip ?? defaults?.clipSkip ?? null,
    qualityPrompt: qualityTags.length > 0 ? qualityTags.join(", ") : null,
    negativePrompt: negativeTags.length > 0 ? negativeTags.join(", ") : null,
    source: "civitai",
    sampleCount: samples.length,
  }
}

class TemporaryError extends Error {}

const fetchJson = async (fetchImpl: FetchLike, path: string) => {
  const response = await fetchImpl(`${CIVITAI_API}${path}`, {
    headers: { "user-agent": USER_AGENT },
  })
  if (response.status === 404) return null
  // 混雑や一時的な失敗は、次の回にやり直す
  if (!response.ok) throw new TemporaryError(`civitai ${response.status}`)
  return (await response.json()) as any
}

/** sha256 から、Civitai の作例の生成情報を集める（作者の作例が足りていればそれだけ）。Civitai に無ければ [] */
export const fetchCivitaiMetasBySha256 = async (
  fetchImpl: FetchLike,
  sha256: string,
): Promise<CivitaiImageMeta[]> => {
  const version = await fetchJson(fetchImpl, `/model-versions/by-hash/${encodeURIComponent(sha256)}`)
  if (!version?.id) return []
  const fromVersion: CivitaiImageMeta[] = (version.images ?? [])
    .map((image: any) => image?.meta)
    .filter(Boolean)
  if (fromVersion.length >= MIN_SAMPLES) return fromVersion
  const images = await fetchJson(
    fetchImpl,
    `/images?modelVersionId=${version.id}&limit=100&sort=Most%20Reactions&nsfw=X&withMeta=true`,
  )
  const fromImages: CivitaiImageMeta[] = (images?.items ?? [])
    .map((image: any) => image?.meta)
    .filter(Boolean)
  // 同じ作例が両方に出るので 1 つにする
  const seen = new Set<string>()
  return [...fromVersion, ...fromImages].filter((meta) => {
    const key = `${meta.seed}|${meta.prompt}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 自動で作る方法を変えたら今の時刻（UNIX 秒）に上げる。これより前に自動で入れたものを作り直す */
const AUTO_RECOMMENDATION_UPDATED_AT = 1793530091

/**
 * おすすめ設定のないチェックポイントに、少しずつ自動で入れる（cron）
 * 登録者が消したものには入れ直さない（recommended_settings_auto_at を見る）。
 * 登録者が変えたものは source が消えるので作り直さない
 */
export const fillRecommendedSettings = async (props: {
  db: Db
  fetch: FetchLike
  limit: number
  now: number
}) => {
  const rows = await props.db.query<{ id: string; sha256: string; base_model: string }>(
    `SELECT id, sha256, base_model FROM user_models
      WHERE status = 'READY' AND kind = 'CHECKPOINT'
        AND (
          (recommended_settings IS NULL AND recommended_settings_auto_at IS NULL)
          OR (recommended_settings LIKE '%"source":%' AND recommended_settings_auto_at < $2)
        )
      ORDER BY created_at DESC
      LIMIT $1`,
    [props.limit, AUTO_RECOMMENDATION_UPDATED_AT],
  )
  let filled = 0
  let failed = 0
  for (const row of rows) {
    try {
      const metas = await fetchCivitaiMetasBySha256(props.fetch, row.sha256)
      const settings = deriveRecommendedSettings({ metas, baseModel: row.base_model })
      await props.db.execute(
        `UPDATE user_models
            SET recommended_settings = $2,
                recommended_settings_auto_at = $3
          WHERE id = $1`,
        [row.id, settings ? JSON.stringify(settings) : null, props.now],
      )
      if (settings) filled++
    } catch (error) {
      failed++
      console.log(
        JSON.stringify({
          event: "user_models.recommend.failed",
          id: row.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      if (error instanceof TemporaryError) break
    }
  }
  return { checked: rows.length, filled, failed }
}
