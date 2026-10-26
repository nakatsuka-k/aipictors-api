// URL からモデルを取り込む（今は Civitai のみ）
//
// - preview: Civitai の API からモデル・バージョンの情報を読み、登録内容の下書き（名前・説明・トリガーワード・サムネイル等）を返す。副作用なし
// - start: 上限・サイズを確認して user_models に UPLOADING（import_status=QUEUED）の行を入れ、Cloudflare Workflows で転送を始める。
//   同じ sha256 の READY があれば転送せずに即 READY（重複排除）
// - 転送（Workflow の各ステップ）: Civitai の download URL を署名付き URL に解決し、50MB ずつ Range で取得して R2 multipart の uploadPart へ流す。
//   1 パート = 1 ステップなので、途中で失敗してもそのパートから再開できる。最初のパートで safetensors のヘッダーを検証する
// - sha256 は Civitai の申告値（hashes.SHA256）。全体のハッシュは計算しない（GPU 側がダウンロード後に検証し、不一致なら無効化する）
// - ライセンスや未対応の系統（Flux など）では取り込みを止めない。出典・ライセンス・元の系統名を保存し、画面で注意書きを出す
import {
  USER_MODEL_PART_SIZE,
  UserModelError,
  abortQuietly,
  bad,
  cleanupStaleUploads,
  createSafetensorsValidator,
  getRow,
  getUserModelLimit,
  getUserModelSettings,
  newUserModelId,
  oneOf,
  optionalString,
  requireRow,
  requireUserId,
  reserveUserModelRow,
  sourceLicenseAllowsOtherServices,
  toUserModel,
  userModelPartCount,
  userModelPartLength,
  USER_MODEL_RATINGS,
  type UserModelDeps,
  type UserModelKind,
  type UserModelSourceLicense,
} from "./user-models"

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type ImportSourceDeps = {
  fetch: FetchLike
  // 任意。Civitai のログインが必要なモデル（多くの LoRA）のダウンロードに使う
  civitaiToken?: string | null
}

export type UserModelImportDeps = UserModelDeps & ImportSourceDeps

export type UserModelImportParams = { modelId: string; downloadUrl: string }

export type StartImportWorkflow = (params: UserModelImportParams) => Promise<void>

const CIVITAI_HOSTS = new Set(["civitai.com", "www.civitai.com", "civitai.green", "www.civitai.green"])
const CIVITAI_API = "https://civitai.com/api/v1"
const USER_AGENT = "aipictors-user-model-import/1.0 (+https://www.aipictors.com)"

export const LOGIN_REQUIRED_MESSAGE = "このモデルは Civitai のログインが必要なため、今は取り込めません"
const GENERIC_FAILURE_MESSAGE = "Civitai からのダウンロードに失敗しました。時間をおいてもう一度お試しください"

// 取り込みをやり直しても通らない失敗（Workflow では再試行しない）
export class ImportFatalError extends UserModelError {}

const fatal = (code: string, message: string) => new ImportFatalError(400, code, message)

// ---- URL ----

export type CivitaiRef = { modelId: number | null; versionId: number | null }

// civitai.com/models/<id>[/slug][?modelVersionId=<v>] / civitai.com/api/download/models/<v>
export const parseCivitaiUrl = (input: unknown): CivitaiRef => {
  const raw = typeof input === "string" ? input.trim() : ""
  if (!raw) throw bad("INVALID_INPUT", "URL を入力してください")
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw bad("INVALID_URL", "URL の形式が正しくありません")
  }
  if (!CIVITAI_HOSTS.has(url.hostname.toLowerCase())) {
    throw bad("UNSUPPORTED_URL", "今は Civitai のモデルページの URL だけ取り込めます")
  }
  const toId = (value: string | null | undefined) => {
    if (!value || !/^\d{1,12}$/.test(value)) return null
    return Number(value)
  }
  const download = /^\/api\/download\/models\/(\d+)\/?$/.exec(url.pathname)
  if (download) return { modelId: null, versionId: toId(download[1]) }
  const page = /^\/models\/(\d+)(?:\/[^/]*)?\/?$/.exec(url.pathname)
  if (page) {
    return { modelId: toId(page[1]), versionId: toId(url.searchParams.get("modelVersionId")) }
  }
  throw bad("UNSUPPORTED_URL", "Civitai のモデルページの URL（civitai.com/models/…）を貼り付けてください")
}

// ---- Civitai API ----

type CivitaiFile = {
  id?: number
  name?: string
  sizeKB?: number
  type?: string
  primary?: boolean
  metadata?: { format?: string | null } | null
  hashes?: Record<string, string> | null
  downloadUrl?: string
}

type CivitaiImage = { url?: string; nsfwLevel?: number; type?: string; nsfw?: unknown }

type CivitaiVersion = {
  id: number
  modelId?: number
  name?: string
  baseModel?: string
  trainedWords?: string[]
  files?: CivitaiFile[]
  images?: CivitaiImage[]
  downloadUrl?: string
}

type CivitaiModel = {
  id: number
  name?: string
  description?: string | null
  type?: string
  nsfw?: boolean
  tags?: Array<string | { name?: string }>
  creator?: { username?: string | null } | null
  allowNoCredit?: boolean
  allowCommercialUse?: string | string[]
  allowDerivatives?: boolean
  allowDifferentLicense?: boolean
  modelVersions?: CivitaiVersion[]
}

const apiHeaders = (deps: ImportSourceDeps) => {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT }
  if (deps.civitaiToken) headers.authorization = `Bearer ${deps.civitaiToken}`
  return headers
}

const fetchCivitaiJson = async <T>(deps: ImportSourceDeps, path: string): Promise<T> => {
  let res: Response
  try {
    res = await deps.fetch(`${CIVITAI_API}${path}`, { headers: apiHeaders(deps) })
  } catch {
    throw new UserModelError(502, "SOURCE_ERROR", "Civitai に接続できませんでした。時間をおいてもう一度お試しください")
  }
  if (res.status === 404) {
    throw new UserModelError(404, "SOURCE_NOT_FOUND", "Civitai でモデルが見つかりません（削除されたか、非公開の可能性があります）")
  }
  if (!res.ok) {
    throw new UserModelError(502, "SOURCE_ERROR", `Civitai からモデルの情報を取得できませんでした（${res.status}）`)
  }
  return (await res.json()) as T
}

export const fetchCivitaiModel = async (deps: ImportSourceDeps, ref: CivitaiRef) => {
  let modelId = ref.modelId
  if (modelId === null) {
    const version = await fetchCivitaiJson<CivitaiVersion>(deps, `/model-versions/${ref.versionId}`)
    if (!version?.modelId) throw new UserModelError(404, "SOURCE_NOT_FOUND", "Civitai でモデルが見つかりません")
    modelId = version.modelId
  }
  const model = await fetchCivitaiJson<CivitaiModel>(deps, `/models/${modelId}`)
  const versions = model.modelVersions ?? []
  const version = ref.versionId === null ? versions[0] : versions.find((v) => v.id === ref.versionId)
  if (!version) {
    throw new UserModelError(404, "SOURCE_NOT_FOUND", "指定されたバージョンが Civitai で見つかりません")
  }
  return { model, version }
}

// ---- 変換 ----

export const mapCivitaiType = (type: string | undefined): UserModelKind => {
  if (type === "Checkpoint") return "CHECKPOINT"
  if (type === "LORA" || type === "LoCon" || type === "DoRA") return "LORA"
  throw bad(
    "UNSUPPORTED_TYPE",
    `この種類のモデル（${type ?? "不明"}）は取り込めません。LoRA かチェックポイントのみ対応しています`,
  )
}

// Civitai の baseModel → Aipictors の baseModel。対応していない系統（Anima, Flux, SD3 …）は OTHER（元の名前は source_base_model に残す）
export const mapCivitaiBaseModel = (raw: string | undefined | null) => {
  const value = (raw ?? "").trim()
  if (/^SD 1\.5/i.test(value)) return "SD1.5" as const
  if (/^SDXL (1\.0|Turbo|Lightning|Hyper)/i.test(value)) return "SDXL" as const
  if (/^Pony$/i.test(value)) return "PONY" as const
  if (/^Illustrious$/i.test(value)) return "ILLUSTRIOUS" as const
  if (/^NoobAI$/i.test(value)) return "NOOBAI" as const
  return "OTHER" as const
}

// allowCommercialUse は新しい API では配列、古い API では "None" | "Image" | "Rent" | "Sell"（上位が下位を含む）
export const normalizeCivitaiLicense = (model: CivitaiModel): UserModelSourceLicense => {
  const raw = model.allowCommercialUse
  let allowCommercialUse: string[]
  if (Array.isArray(raw)) {
    allowCommercialUse = raw.filter((v) => typeof v === "string")
  } else {
    const ladder = ["Image", "RentCivit", "Rent", "Sell"]
    const index = typeof raw === "string" ? ladder.indexOf(raw) : -1
    allowCommercialUse = index < 0 ? [] : ladder.slice(0, index + 1)
  }
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null)
  return {
    allowCommercialUse,
    allowDerivatives: bool(model.allowDerivatives),
    allowNoCredit: bool(model.allowNoCredit),
    allowDifferentLicense: bool(model.allowDifferentLicense),
  }
}

const decodeEntities = (value: string) =>
  value
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")

export const htmlToText = (html: string | null | undefined) =>
  decodeEntities(
    (html ?? "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|ul|ol|blockquote)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "・")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

const DESCRIPTION_BODY_MAX = 1000

export const buildImportDescription = (html: string | null | undefined, sourceUrl: string, creator: string | null) => {
  let body = htmlToText(html)
  if (body.length > DESCRIPTION_BODY_MAX) body = `${body.slice(0, DESCRIPTION_BODY_MAX).trimEnd()}…`
  const credit = `元のモデル: ${sourceUrl}${creator ? `\n作者: ${creator}` : ""}`
  return body ? `${body}\n\n${credit}` : credit
}

// image.civitai.com の URL は /width=<n>/ や /original=true/ の部分で大きさを指定できる
export const civitaiImageUrl = (url: string, width: number) => {
  if (!/^https:\/\/image\.civitai\.com\//.test(url)) return url
  const replaced = url.replace(/\/(?:width=\d+|original=true)(?:,[^/]*)?\//, `/width=${width}/`)
  if (replaced !== url) return replaced
  // 大きさの指定が無い URL（…/<uuid>/<file>）にはファイル名の前に入れる
  const index = url.lastIndexOf("/")
  return `${url.slice(0, index)}/width=${width}${url.slice(index)}`
}

const pickSafeImages = (images: CivitaiImage[] | undefined) =>
  (images ?? []).filter(
    (image) =>
      typeof image.url === "string" &&
      image.url.startsWith("https://") &&
      (image.type ?? "image") === "image" &&
      typeof image.nsfwLevel === "number" &&
      image.nsfwLevel <= 1,
  )

const pickFile = (files: CivitaiFile[] | undefined) => {
  const candidates = (files ?? []).filter(
    (f) =>
      (f.type ?? "Model") === "Model" &&
      (f.metadata?.format === "SafeTensor" || /\.safetensors$/i.test(f.name ?? "")) &&
      typeof f.downloadUrl === "string",
  )
  return candidates.find((f) => f.primary) ?? candidates[0] ?? null
}

const isCivitaiDownloadUrl = (value: string) => {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && CIVITAI_HOSTS.has(url.hostname) && url.pathname.startsWith("/api/download/models/")
  } catch {
    return false
  }
}

export type ImportPlan = ReturnType<typeof buildImportPlan>

// Civitai のモデル・バージョンから登録内容を作る（preview と start で共通）
export const buildImportPlan = (model: CivitaiModel, version: CivitaiVersion) => {
  const kind = mapCivitaiType(model.type)
  const file = pickFile(version.files)
  if (!file) {
    throw bad("UNSUPPORTED_FORMAT", "このバージョンには .safetensors 形式のファイルがないため取り込めません")
  }
  const sha256 = String(file.hashes?.SHA256 ?? file.hashes?.sha256 ?? "").toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw bad("SOURCE_NO_HASH", "Civitai にファイルのハッシュ（SHA256）が無いため取り込めません")
  }
  const downloadUrl = String(file.downloadUrl)
  if (!isCivitaiDownloadUrl(downloadUrl)) {
    throw bad("UNSUPPORTED_URL", "このファイルのダウンロード先には対応していません")
  }
  const sizeBytes = Math.round(Number(file.sizeKB ?? 0) * 1024)
  const sourceUrl = `https://civitai.com/models/${model.id}?modelVersionId=${version.id}`
  const creator = model.creator?.username?.trim() || null
  const sourceBaseModel = version.baseModel?.trim() || null
  const baseModel = mapCivitaiBaseModel(sourceBaseModel)
  const license = normalizeCivitaiLicense(model)
  const modelName = (model.name ?? "").trim()
  const versionName = (version.name ?? "").trim()
  const name =
    (versionName && !modelName.toLowerCase().includes(versionName.toLowerCase())
      ? `${modelName} ${versionName}`
      : modelName || versionName || `Civitai ${model.id}`
    ).slice(0, 100)
  const tags = [
    ...new Set(
      (model.tags ?? [])
        .map((t) => (typeof t === "string" ? t : (t?.name ?? "")).trim())
        .filter((t) => t.length > 0 && t.length <= 50),
    ),
  ].slice(0, 20)
  const triggerWords = (version.trainedWords ?? [])
    .map((w) => String(w).trim())
    .filter(Boolean)
    .join(", ")
    .slice(0, 1000)
  const images = pickSafeImages(version.images)
  return {
    source: "civitai" as const,
    sourceUrl,
    civitaiModelId: model.id,
    civitaiVersionId: version.id,
    kind,
    name,
    versionName: versionName || null,
    description: buildImportDescription(model.description, sourceUrl, creator),
    creator,
    creatorUrl: creator ? `https://civitai.com/user/${encodeURIComponent(creator)}` : null,
    baseModel,
    sourceBaseModel,
    baseModelSupported: baseModel !== "OTHER",
    triggerWords,
    tags,
    rating: model.nsfw ? ("R18" as const) : ("G" as const),
    nsfw: Boolean(model.nsfw),
    thumbnailUrl: images[0]?.url ? civitaiImageUrl(images[0].url, 450) : null,
    sampleImageUrls: images.slice(0, 8).map((image) => civitaiImageUrl(image.url!, 1024)),
    filename: (file.name ?? `civitai-${version.id}.safetensors`).slice(0, 255),
    sizeBytes,
    sha256,
    downloadUrl,
    license,
    licenseAllowsOtherServices: sourceLicenseAllowsOtherServices(license),
  }
}

// ---- ダウンロード URL の解決 ----

// Civitai の download URL は 307 で署名付き URL（R2 / S3）に飛ぶ。Location を取り出す（ログインが必要なら 401）
export const resolveCivitaiDownload = async (deps: ImportSourceDeps, downloadUrl: string) => {
  const headers: Record<string, string> = { "user-agent": USER_AGENT }
  if (deps.civitaiToken) headers.authorization = `Bearer ${deps.civitaiToken}`
  let res: Response
  try {
    res = await deps.fetch(downloadUrl, { method: "GET", headers, redirect: "manual" })
  } catch {
    throw new UserModelError(502, "SOURCE_ERROR", "Civitai に接続できませんでした")
  }
  const location = res.headers.get("location")
  if (res.status >= 300 && res.status < 400 && location) {
    await res.body?.cancel()
    const target = new URL(location, downloadUrl).toString()
    if (!target.startsWith("https://")) throw fatal("SOURCE_ERROR", "ダウンロード先が https ではありません")
    return target
  }
  await res.body?.cancel()
  if (res.status === 401 || res.status === 403) throw fatal("LOGIN_REQUIRED", LOGIN_REQUIRED_MESSAGE)
  if (res.status === 404) throw fatal("SOURCE_NOT_FOUND", "Civitai でファイルが見つかりません")
  throw new UserModelError(502, "SOURCE_ERROR", `Civitai のダウンロード URL を取得できませんでした（${res.status}）`)
}

// ---- preview / start / status ----

const loadPlan = async (deps: ImportSourceDeps, url: unknown) => {
  const ref = parseCivitaiUrl(url)
  const { model, version } = await fetchCivitaiModel(deps, ref)
  return buildImportPlan(model, version)
}

const tooLargeMessage = (kind: UserModelKind, maxBytes: number) =>
  `${kind === "LORA" ? "LoRA" : "チェックポイント"} は ${Math.floor(maxBytes / 1024 / 1024)}MB までです`

export const previewUserModelImport = async (deps: Pick<UserModelImportDeps, "db" | "fetch" | "civitaiToken">, input: Record<string, unknown>) => {
  const plan = await loadPlan(deps, input.url)
  const { maxBytes } = await getUserModelSettings(deps.db)
  const existing = await deps.db.queryOne<{ id: string }>(
    "SELECT id FROM user_models WHERE sha256 = $1 AND status = 'READY' LIMIT 1",
    [plan.sha256],
  )
  const { downloadUrl: _downloadUrl, ...rest } = plan
  return {
    ...rest,
    maxBytes: maxBytes[plan.kind],
    tooLarge: plan.sizeBytes > maxBytes[plan.kind],
    // 同じファイルがすでにあれば転送せずにすぐ使える
    alreadyStored: Boolean(existing),
  }
}

export const startUserModelImport = async (
  deps: UserModelImportDeps & { startWorkflow: StartImportWorkflow | null },
  input: Record<string, unknown>,
) => {
  const userId = requireUserId(input.userId)
  const name = optionalString(input.name, "name", 100)?.trim()
  const rating = oneOf(input.rating, USER_MODEL_RATINGS, "rating")
  const plan = await loadPlan(deps, input.url)
  const { maxBytes } = await getUserModelSettings(deps.db)
  if (plan.sizeBytes > maxBytes[plan.kind]) throw new UserModelError(400, "TOO_LARGE", tooLargeMessage(plan.kind, maxBytes[plan.kind]))
  const { planType, limit } = await getUserModelLimit(deps.db, userId, input.planType, deps.now)
  await cleanupStaleUploads(deps, userId)

  const existing = await deps.db.queryOne<{ id: string }>(
    "SELECT id FROM user_models WHERE sha256 = $1 AND status = 'READY' LIMIT 1",
    [plan.sha256],
  )
  if (!existing) {
    if (!deps.startWorkflow) {
      throw new UserModelError(503, "IMPORT_UNAVAILABLE", "URL からの取り込みは準備中です。しばらくしてからお試しください")
    }
    // ログインが必要なモデルは行を作る前に分かるので、ここで止める
    await resolveCivitaiDownload(deps, plan.downloadUrl)
  }

  const id = newUserModelId()
  const inserted = await reserveUserModelRow(deps, {
    id,
    userId,
    kind: plan.kind,
    sha256: plan.sha256,
    sizeBytes: plan.sizeBytes,
    filename: plan.filename,
    limit,
    planType,
    existingSizeMustMatch: false,
    fields: {
      name: name || plan.name,
      description: plan.description,
      baseModel: plan.baseModel,
      triggerWords: plan.triggerWords,
      recommendedWeight: undefined,
      rating: rating ?? plan.rating,
      tags: plan.tags,
      thumbnailUrl: plan.thumbnailUrl,
      sampleImageUrls: plan.sampleImageUrls,
    },
    source: { url: plan.sourceUrl, creator: plan.creator, license: plan.license, baseModel: plan.sourceBaseModel },
  })
  if (inserted === "UPLOADING") {
    try {
      await deps.startWorkflow!({ modelId: id, downloadUrl: plan.downloadUrl })
    } catch (e) {
      await failUserModelImport(deps, { modelId: id, error: `workflow start failed: ${String(e)}` })
      throw new UserModelError(503, "IMPORT_UNAVAILABLE", "取り込みを開始できませんでした。しばらくしてからお試しください")
    }
  }
  const row = (await getRow(deps.db, id))!
  return { modelId: id, deduplicated: inserted === "READY", ...importStatusOf(row), model: toUserModel(row) }
}

type ImportRow = NonNullable<Awaited<ReturnType<typeof getRow>>>

export type UserModelImportState = "QUEUED" | "TRANSFERRING" | "READY" | "FAILED"

const importStatusOf = (row: ImportRow) => {
  const partsTotal = row.import_parts_total === null || row.import_parts_total === undefined ? null : Number(row.import_parts_total)
  const partsDone = Number(row.import_parts_done ?? 0)
  let status: UserModelImportState
  if (row.status === "READY") status = "READY"
  else if (row.status === "UPLOADING") status = row.import_status === "RUNNING" ? "TRANSFERRING" : "QUEUED"
  else status = "FAILED"
  return {
    status,
    modelStatus: row.status,
    partsDone,
    partsTotal,
    sizeBytes: Number(row.size_bytes),
    error: status === "FAILED" ? (row.import_error ?? "取り込みに失敗しました") : null,
  }
}

export const getUserModelImportStatus = async (db: UserModelDeps["db"], id: string, userId: unknown) => {
  const uid = requireUserId(userId)
  const row = await getRow(db, /^[0-9a-z]{12}$/.test(id) ? id : "")
  if (!row || row.user_id !== uid || (!row.import_status && !row.source_url)) {
    throw new UserModelError(404, "NOT_FOUND", "取り込みが見つかりません")
  }
  const state = importStatusOf(row)
  return { modelId: row.id, ...state, model: state.status === "READY" ? toUserModel(row) : null }
}

// 作者が取り込みを中止する。Workflow の次のステップが行の状態を見て止まる
export const cancelUserModelImport = async (deps: UserModelDeps, id: string, userId: unknown) => {
  const uid = requireUserId(userId)
  const row = await requireRow(deps.db, id, { userId: uid, statuses: ["UPLOADING"] })
  if (!row.import_status) throw new UserModelError(409, "INVALID_STATUS", "URL からの取り込みではありません")
  await failUserModelImport(deps, { modelId: row.id, error: "cancelled", message: "取り込みを中止しました" })
  return { modelId: row.id, status: "DELETED" as const }
}

// ---- Workflow のステップ ----

const userMessageOf = (error: string) => {
  // Workflow を通ると "NonRetryableError: …" などが前に付くことがある。日本語のメッセージならそれを見せる
  const m = /[ぁ-んァ-ヶ一-龠][\s\S]*$/.exec(error)
  if (!m) return GENERIC_FAILURE_MESSAGE
  const start = error.lastIndexOf(":", m.index) + 1
  return error.slice(start > 0 ? start : m.index).trim() || GENERIC_FAILURE_MESSAGE
}

// 失敗した取り込みは DELETED にして上限の枠を空ける（理由は disabled_reason / import_error に残す）
export const failUserModelImport = async (
  deps: UserModelDeps,
  input: { modelId: string; error: string; message?: string },
) => {
  const row = await getRow(deps.db, input.modelId)
  if (!row || row.status !== "UPLOADING") return { modelId: input.modelId, failed: false }
  await abortQuietly(deps.bucket, row.r2_key, row.upload_id)
  const message = input.message ?? userMessageOf(input.error)
  await deps.db.execute(
    `UPDATE user_models SET status = 'DELETED', upload_id = NULL, import_status = 'FAILED', import_error = $2,
        disabled_reason = $3, updated_at = $4
      WHERE id = $1 AND status = 'UPLOADING'`,
    [row.id, message, `import_failed: ${input.error}`.slice(0, 1000), deps.now],
  )
  console.warn(JSON.stringify({ event: "user_models.import_failed", id: row.id, error: input.error }))
  return { modelId: row.id, failed: true }
}

const requireImportingRow = async (deps: UserModelDeps, modelId: string, uploadId?: string) => {
  const row = await getRow(deps.db, modelId)
  if (!row || row.status !== "UPLOADING" || (uploadId !== undefined && row.upload_id !== uploadId)) {
    throw fatal("IMPORT_CANCELLED", "取り込みは中止されました")
  }
  return row
}

const parseContentRangeTotal = (value: string | null) => {
  const m = /\/(\d+)\s*$/.exec(value ?? "")
  return m ? Number(m[1]) : null
}

const fetchRange = (deps: ImportSourceDeps, url: string, start: number, end: number) =>
  deps.fetch(url, { headers: { range: `bytes=${start}-${end}`, "user-agent": USER_AGENT } })

const isExpired = (status: number) => status === 400 || status === 401 || status === 403 || status === 410

export type ImportStartResult =
  | { skip: true }
  | { skip: false; uploadId: string; sizeBytes: number; partCount: number; signedUrl: string; strictKind: boolean }

// ステップ 1: 署名付き URL を得て実際のサイズを確認し、R2 の multipart を始める
export const importStepStart = async (deps: UserModelImportDeps, params: UserModelImportParams): Promise<ImportStartResult> => {
  const row = await getRow(deps.db, params.modelId)
  if (!row || row.status !== "UPLOADING") return { skip: true }
  const signedUrl = await resolveCivitaiDownload(deps, params.downloadUrl)
  const probe = await fetchRange(deps, signedUrl, 0, 0)
  await probe.body?.cancel()
  if (probe.status === 200) throw fatal("SOURCE_ERROR", "ダウンロード先が分割取得に対応していないため取り込めません")
  if (probe.status !== 206) {
    throw new UserModelError(502, "SOURCE_ERROR", `Civitai からの取得に失敗しました（${probe.status}）`)
  }
  const sizeBytes = parseContentRangeTotal(probe.headers.get("content-range"))
  if (!sizeBytes || sizeBytes <= 16) throw fatal("SOURCE_ERROR", "ファイルのサイズを確認できませんでした")
  const { maxBytes } = await getUserModelSettings(deps.db)
  if (sizeBytes > maxBytes[row.kind]) throw fatal("TOO_LARGE", tooLargeMessage(row.kind, maxBytes[row.kind]))
  let uploadId = row.upload_id
  if (!uploadId) {
    const upload = await deps.bucket.createMultipartUpload(row.r2_key, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { sha256: row.sha256, kind: row.kind, source: row.source_url ?? "" },
    })
    uploadId = upload.uploadId
  }
  const partCount = userModelPartCount(sizeBytes)
  const updated = await deps.db.queryOne<{ id: string }>(
    `UPDATE user_models SET upload_id = $2, size_bytes = $3, import_status = 'RUNNING', import_parts_total = $4,
        import_parts_done = 0, updated_at = $5
      WHERE id = $1 AND status = 'UPLOADING' RETURNING id`,
    [row.id, uploadId, sizeBytes, partCount, deps.now],
  )
  if (!updated) {
    await abortQuietly(deps.bucket, row.r2_key, uploadId)
    return { skip: true }
  }
  // 系統が OTHER のときはキー名での種類判定が当てにならないので、種類違いは警告だけにする
  return { skip: false, uploadId, sizeBytes, partCount, signedUrl, strictKind: row.base_model !== "OTHER" }
}

export type ImportPartInput = UserModelImportParams & {
  uploadId: string
  sizeBytes: number
  partNumber: number
  signedUrl: string
  strictKind: boolean
}

// ステップ 2〜: 50MB を Range で取得して uploadPart。署名付き URL が切れていたら解決し直す（次のパート用に返す）
export const importStepPart = async (deps: UserModelImportDeps, input: ImportPartInput) => {
  const row = await requireImportingRow(deps, input.modelId, input.uploadId)
  const start = (input.partNumber - 1) * USER_MODEL_PART_SIZE
  const length = userModelPartLength(input.sizeBytes, input.partNumber)
  let signedUrl = input.signedUrl
  let res = await fetchRange(deps, signedUrl, start, start + length - 1)
  if (isExpired(res.status)) {
    await res.body?.cancel()
    signedUrl = await resolveCivitaiDownload(deps, input.downloadUrl)
    res = await fetchRange(deps, signedUrl, start, start + length - 1)
  }
  if (res.status !== 206 || !res.body) {
    await res.body?.cancel()
    throw new UserModelError(502, "SOURCE_ERROR", `Civitai からの取得に失敗しました（${res.status}）`)
  }
  const total = parseContentRangeTotal(res.headers.get("content-range"))
  if (total !== null && total !== input.sizeBytes) {
    await res.body.cancel()
    throw fatal("SOURCE_CHANGED", "取り込み中に Civitai のファイルが変わりました。もう一度お試しください")
  }
  let stream: ReadableStream<Uint8Array> = res.body
  let validationError: UserModelError | null = null
  const warnings: string[] = []
  if (input.partNumber === 1) {
    stream = stream.pipeThrough(
      createSafetensorsValidator(
        input.sizeBytes,
        row.kind,
        (e) => {
          validationError = e
        },
        { strictKind: input.strictKind, onWarning: (m) => warnings.push(m) },
      ),
    )
  }
  // R2 は長さの分かる stream しか受け付けない
  if (typeof FixedLengthStream !== "undefined") {
    stream = stream.pipeThrough(new FixedLengthStream(length))
  }
  let part: { partNumber: number; etag: string }
  try {
    part = await deps.bucket.resumeMultipartUpload(row.r2_key, input.uploadId).uploadPart(input.partNumber, stream)
  } catch (e) {
    if (validationError) {
      const v = validationError as UserModelError
      throw new ImportFatalError(400, v.code, v.message)
    }
    throw e
  }
  if (warnings.length > 0) {
    console.warn(JSON.stringify({ event: "user_models.import_warning", id: row.id, warnings }))
  }
  await deps.db.execute(
    `UPDATE user_models SET import_parts_done = GREATEST(import_parts_done, $2), updated_at = $3
      WHERE id = $1 AND status = 'UPLOADING'`,
    [row.id, input.partNumber, deps.now],
  )
  return { partNumber: part.partNumber, etag: part.etag, signedUrl }
}

// 最終ステップ: multipart を完了し、サイズを確認して READY に
export const importStepComplete = async (
  deps: UserModelDeps,
  input: { modelId: string; uploadId: string; sizeBytes: number; parts: Array<{ partNumber: number; etag: string }> },
) => {
  const row = await requireImportingRow(deps, input.modelId, input.uploadId)
  const parts = [...input.parts].sort((a, b) => a.partNumber - b.partNumber)
  const object = await deps.bucket.resumeMultipartUpload(row.r2_key, input.uploadId).complete(parts)
  if (object.size !== input.sizeBytes) {
    await deps.bucket.delete(row.r2_key)
    throw fatal("SIZE_MISMATCH", "取り込んだファイルのサイズが一致しません")
  }
  const updated = await deps.db.queryOne<ImportRow>(
    `UPDATE user_models SET status = 'READY', upload_id = NULL, import_status = 'DONE', import_parts_done = $2,
        import_error = NULL, updated_at = $3
      WHERE id = $1 AND status = 'UPLOADING' RETURNING *`,
    [row.id, parts.length, deps.now],
  )
  if (!updated) throw fatal("IMPORT_CANCELLED", "取り込みは中止されました")
  return { modelId: row.id, status: "READY" as const }
}

// ---- Workflow の流れ（cloudflare:workers に依存しない形。テストでは step.do をそのまま実行する偽物を渡す） ----

export type ImportStepRunner = {
  do<T>(name: string, config: Record<string, unknown>, callback: () => Promise<T>): Promise<T>
}

const PART_STEP_CONFIG = { retries: { limit: 6, delay: "20 seconds", backoff: "exponential" }, timeout: "15 minutes" }
const SMALL_STEP_CONFIG = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" }

export const runUserModelImport = async (
  params: UserModelImportParams,
  step: ImportStepRunner,
  getDeps: () => Promise<UserModelImportDeps>,
  // ImportFatalError を Workflow の NonRetryableError に変える
  wrapFatal: (e: ImportFatalError) => Error = (e) => e,
) => {
  const run = <T>(fn: (deps: UserModelImportDeps) => Promise<T>) => async () => {
    try {
      return await fn(await getDeps())
    } catch (e) {
      throw e instanceof ImportFatalError ? wrapFatal(e) : e
    }
  }
  try {
    const started = await step.do("start", SMALL_STEP_CONFIG, run((deps) => importStepStart(deps, params)))
    if (started.skip) return { modelId: params.modelId, status: "SKIPPED" }
    const parts: Array<{ partNumber: number; etag: string }> = []
    let signedUrl = started.signedUrl
    for (let partNumber = 1; partNumber <= started.partCount; partNumber++) {
      const part = await step.do(
        `part-${partNumber}`,
        PART_STEP_CONFIG,
        run((deps) =>
          importStepPart(deps, {
            ...params,
            uploadId: started.uploadId,
            sizeBytes: started.sizeBytes,
            partNumber,
            signedUrl,
            strictKind: started.strictKind,
          }),
        ),
      )
      parts.push({ partNumber: part.partNumber, etag: part.etag })
      signedUrl = part.signedUrl
    }
    return await step.do(
      "complete",
      SMALL_STEP_CONFIG,
      run((deps) => importStepComplete(deps, { modelId: params.modelId, uploadId: started.uploadId, sizeBytes: started.sizeBytes, parts })),
    )
  } catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    await step.do("fail", SMALL_STEP_CONFIG, async () => failUserModelImport(await getDeps(), { modelId: params.modelId, error }))
    return { modelId: params.modelId, status: "FAILED", error }
  }
}
