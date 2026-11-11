// 週替わりのピックアップモデル（みんなのモデルの看板）
//
// - 週は月曜 00:00 JST 始まり。毎週月曜 00:00 JST の cron が直近 7 日の生成から自動で選ぶ（runWeeklyPickup）
// - 選び方: 使った人の数を一番重く、生成回数・新しさ・LoRA（自作が多い）・自分でアップロードしたモデル・作例の数を足す。
//   R18 / R18G、サムネイルなし、取り込み元のライセンスが他サービスでの利用を許していないもの、直近 8 週に選んだモデル、
//   直近 4 週に選んだ登録者のモデルは選ばない
// - 運営は管理画面から差し替えられる（source = ADMIN。その週は cron で上書きしない）
// - 選んだら: aipictors-system の D1 に「その週のお題（ユーザー企画の枠、主催は公式）」を作り、登録者にお知らせを送り、
//   X 投稿の下書き（文面と添付する画像の URL）を作る。X への投稿はしない
import { getUserModel, toUserModel, type UserModelRow } from "./user-models"
import type { Db } from "./user-models/common"
import { sourceLicenseAllowsOtherServices } from "./user-models/serialize"

export const SITE_URL = "https://www.aipictors.com"
/** 公式アカウント（お題の主催者） */
export const OFFICIAL_USER_ID = 1
const DAY = 86400
const JST = 9 * 3600
const RECENT_MODEL_WEEKS = 8
const RECENT_OWNER_WEEKS = 4

/** その時刻を含む週の月曜（JST）を YYYY-MM-DD で */
export const jstWeekStart = (nowSec: number) => {
  const jst = new Date((nowSec + JST) * 1000)
  const dow = (jst.getUTCDay() + 6) % 7 // 月曜 = 0
  const monday = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() - dow))
  return monday.toISOString().slice(0, 10)
}

const addDays = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const isWeekStart = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).getUTCDay() === 1

export type ModelUsage = { generations: number; users: number }

/**
 * 生成結果の表から、その時刻以降の最初の行の id を二分探索で求める（created_at に索引がないため id で絞る）
 */
export const findGenlogStartId = async (genlog: Db, sinceText: string) => {
  const bounds = await genlog.queryOne<{ lo: number | null; hi: number | null }>(
    "SELECT MIN(id) AS lo, MAX(id) AS hi FROM image_generation_results",
  )
  let lo = Number(bounds?.lo ?? 0)
  let hi = Number(bounds?.hi ?? 0)
  if (hi <= 0) return 0
  for (let i = 0; i < 40 && lo < hi; i++) {
    const mid = Math.floor((lo + hi) / 2)
    // 比較は SQL で（クライアントは created_at を Date に直して返すため）
    const row = await genlog.queryOne<{ after: number }>(
      "SELECT created_at >= $2 AS after FROM image_generation_results WHERE id >= $1 ORDER BY id LIMIT 1",
      [mid, sinceText],
    )
    if (!row || Number(row.after) === 1) hi = mid
    else lo = mid + 1
  }
  return lo
}

const USER_LORA_PATTERN = /<lora:user_([a-z0-9]{12}):/g
const USER_CHECKPOINT_PATTERN = /^user\/([a-z0-9]{12})\.safetensors/

/** 直近の生成でのみんなのモデルの利用（チェックポイントは model_name、LoRA はプロンプトの <lora:user_ID:w>） */
export const collectModelUsage = async (genlog: Db, sinceSec: number) => {
  const sinceText = new Date(sinceSec * 1000).toISOString().replace("T", " ").replace("Z", "")
  const startId = await findGenlogStartId(genlog, sinceText)
  const [checkpoints, loraRows] = await Promise.all([
    genlog.query<{ model_name: string; n: number; u: number }>(
      `SELECT model_name, COUNT(*) AS n, COUNT(DISTINCT user_id) AS u FROM image_generation_results
        WHERE id >= $1 AND model_name LIKE 'user/%' GROUP BY model_name`,
      [startId],
    ),
    genlog.query<{ user_id: number; prompts: string }>(
      `SELECT user_id, prompts FROM image_generation_results WHERE id >= $1 AND prompts LIKE '%<lora:user\\_%' ESCAPE '\\'`,
      [startId],
    ),
  ])
  const usage = new Map<string, ModelUsage>()
  for (const row of checkpoints) {
    const id = USER_CHECKPOINT_PATTERN.exec(row.model_name)?.[1]
    if (!id) continue
    const prev = usage.get(id) ?? { generations: 0, users: 0 }
    usage.set(id, { generations: prev.generations + Number(row.n), users: prev.users + Number(row.u) })
  }
  const loraUsers = new Map<string, Set<number>>()
  const loraCounts = new Map<string, number>()
  for (const row of loraRows) {
    for (const id of new Set([...String(row.prompts).matchAll(USER_LORA_PATTERN)].map((m) => m[1]))) {
      loraCounts.set(id, (loraCounts.get(id) ?? 0) + 1)
      const users = loraUsers.get(id) ?? new Set<number>()
      users.add(Number(row.user_id))
      loraUsers.set(id, users)
    }
  }
  for (const [id, count] of loraCounts) {
    usage.set(id, { generations: count, users: loraUsers.get(id)?.size ?? 0 })
  }
  return usage
}

export type PickupCandidate = {
  modelId: string
  name: string
  userId: string
  score: number
  stats: ModelUsage & { kind: string; uploaded: boolean; ageDays: number; samples: number; useCount: number }
  excludedReason: string | null
}

type RecentPick = { week_start: string; model_id: string; user_id: string | null }

/** 候補に点を付けて並べる（選べないものは excludedReason を入れて後ろへ） */
export const rankPickupCandidates = (props: {
  rows: UserModelRow[]
  usage: Map<string, ModelUsage>
  recentPicks: RecentPick[]
  weekStart: string
  nowSec: number
}): PickupCandidate[] => {
  const modelCutoff = addDays(props.weekStart, -7 * RECENT_MODEL_WEEKS)
  const ownerCutoff = addDays(props.weekStart, -7 * RECENT_OWNER_WEEKS)
  const recentModels = new Set(props.recentPicks.filter((p) => p.week_start >= modelCutoff && p.week_start < props.weekStart).map((p) => p.model_id))
  const recentOwners = new Set(
    props.recentPicks.filter((p) => p.week_start >= ownerCutoff && p.week_start < props.weekStart && p.user_id).map((p) => p.user_id as string),
  )
  const candidates = props.rows
    .filter((row) => row.status === "READY")
    .map((row): PickupCandidate => {
      const model = toUserModel(row)
      const usage = props.usage.get(row.id) ?? { generations: 0, users: 0 }
      const ageDays = Math.max(0, (props.nowSec - Number(row.created_at)) / DAY)
      const uploaded = !model.sourceUrl
      const samples = model.sampleImageUrls.length
      const score =
        usage.users * 10 +
        Math.sqrt(usage.generations) * 3 +
        (model.kind === "LORA" ? 6 : 0) +
        (uploaded ? 8 : 0) +
        (ageDays <= 30 ? 10 : ageDays <= 60 ? 4 : 0) +
        Math.min(samples, 4) +
        Math.log10(1 + model.useCount)
      let excludedReason: string | null = null
      if (model.rating === "R18" || model.rating === "R18G") excludedReason = "R18"
      else if (!model.thumbnailUrl) excludedReason = "サムネイルなし"
      else if (model.sourceLicenseAllowsOtherServices === false) excludedReason = "ライセンス（他サービス不可）"
      else if (recentModels.has(row.id)) excludedReason = `直近${RECENT_MODEL_WEEKS}週に選んだ`
      else if (recentOwners.has(row.user_id)) excludedReason = `登録者を直近${RECENT_OWNER_WEEKS}週に選んだ`
      else if (usage.users < 2 && model.useCount < 10) excludedReason = "利用が少ない"
      return {
        modelId: row.id,
        name: row.name,
        userId: row.user_id,
        score: Math.round(score * 10) / 10,
        stats: { ...usage, kind: model.kind, uploaded, ageDays: Math.floor(ageDays), samples, useCount: model.useCount },
        excludedReason,
      }
    })
  return candidates.sort((a, b) => {
    if ((a.excludedReason === null) !== (b.excludedReason === null)) return a.excludedReason === null ? -1 : 1
    return b.score - a.score || a.modelId.localeCompare(b.modelId)
  })
}

export const pickupEventSlug = (weekStart: string) => `model-pickup-${weekStart.replace(/-/g, "")}`
export const pickupEventTag = (weekStart: string) => `ピックアップモデル_${weekStart.slice(2).replace(/-/g, "")}`

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** X 投稿の下書き（投稿はしない。管理画面でコピーして使う） */
export const buildPickupXDraft = (props: {
  model: ReturnType<typeof toUserModel>
  weekStart: string
  authorName: string | null
}) => {
  const { model } = props
  const end = addDays(props.weekStart, 6)
  const md = (ymd: string) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`
  const credit = [
    props.authorName ? `登録: ${props.authorName} さん` : null,
    model.sourceCreator ? `制作: ${model.sourceCreator}` : null,
  ]
    .filter(Boolean)
    .join(" / ")
  const kind = model.kind === "LORA" ? "LoRA" : "モデル"
  const text = [
    `🎨 今週のピックアップモデル（${md(props.weekStart)}〜${md(end)}）`,
    "",
    `「${truncate(model.name, 60)}」（${kind}）`,
    credit,
    "",
    "Aipictors ではユーザーが登録したモデルでそのまま生成して、その場で投稿できます。",
    `このモデルで作った作品に #${pickupEventTag(props.weekStart)} を付けて投稿すると、今週のランキングに参加できます✨`,
    "",
    `${SITE_URL}/models/u/${model.id}`,
    "",
    "#Aipictors #AIイラスト #みんなのモデル",
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n")
  // 添付する画像: サムネイルと作例（最大 4 枚。全年齢のモデルだけ選んでいる）
  const images = [...new Set([model.thumbnailUrl, ...model.sampleImageUrls].filter((v): v is string => typeof v === "string" && v !== ""))].slice(0, 4)
  return { text, images }
}

/** aipictors-system の D1（core: お題の枠、activity: お知らせ）。無ければその部分だけ飛ばす */
export type SystemD1 = { core: D1Database | null; activity: D1Database | null }

/** 壁時計の JST を D1（aipictors-system）の形で（例 2026-11-16T00:00:00.000+00:00） */
const jstWall = (ymd: string, time: string) => `${ymd}T${time}.000+00:00`
const jstNowWall = (nowSec: number) => `${new Date((nowSec + JST) * 1000).toISOString().slice(0, 23)}+00:00`

/** その週のお題（ユーザー企画の枠。主催は公式、作品のいいね順ランキングあり）を作る・差し替える */
export const upsertPickupEvent = async (
  core: D1Database,
  props: { weekStart: string; model: ReturnType<typeof toUserModel>; authorName: string | null; nowSec: number },
) => {
  const { model, weekStart } = props
  const slug = pickupEventSlug(weekStart)
  const tag = pickupEventTag(weekStart)
  const credit = [props.authorName ? `登録: ${props.authorName} さん` : null, model.sourceCreator ? `制作: ${model.sourceCreator}` : null]
    .filter(Boolean)
    .join(" / ")
  const title = truncate(`今週のピックアップモデル「${model.name}」`, 80)
  const description = [
    `今週のピックアップは、みんなのモデル「${model.name}」です。${credit ? `（${credit}）` : ""}`,
    "このモデルで生成して、そのまま投稿してみましょう。いいねの数で今週のランキングを決めます。",
    `モデルのページ: ${SITE_URL}/models/u/${model.id}`,
  ].join("\n")
  const guide = [
    `1. モデルのページの「このモデルで生成」から生成します（${SITE_URL}/models/u/${model.id}）`,
    "2. 生成結果の「投稿」から投稿すると、このお題が自動で選ばれます",
    `3. ほかの方法で投稿するときは、タグ「${tag}」を付けてください`,
    "※ このモデルで作った作品だけ参加できます。全年齢・R15 の作品が対象です",
  ].join("\n")
  const now = jstNowWall(props.nowSec)
  await core.batch([
    core
      .prepare(
        `INSERT INTO user_events (user_id, slug, title, description, participation_guide, header_image_url, thumbnail_image_url,
           main_tag, ranking_enabled, ranking_type, visibility_type, ratings, is_sensitive, status, start_at, end_at, published_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, 1, 'LIKES', 'PUBLIC', 'G,R15', 0, 'UPCOMING', ?8, ?9, ?10, ?10, ?10)
         ON CONFLICT(slug) DO UPDATE SET title = excluded.title, description = excluded.description,
           participation_guide = excluded.participation_guide, header_image_url = excluded.header_image_url,
           thumbnail_image_url = excluded.thumbnail_image_url`,
      )
      .bind(
        OFFICIAL_USER_ID,
        slug,
        title,
        description,
        guide,
        model.thumbnailUrl,
        tag,
        jstWall(weekStart, "00:00:00"),
        jstWall(addDays(weekStart, 6), "23:59:59"),
        now,
      ),
    core
      .prepare(
        `INSERT OR IGNORE INTO user_event_tags (user_event_id, tag_name, is_primary)
         SELECT id, ?2, 1 FROM user_events WHERE slug = ?1`,
      )
      .bind(slug, tag),
    core
      .prepare(
        `INSERT OR IGNORE INTO user_event_tags (user_event_id, tag_name, is_primary)
         SELECT id, 'みんなのモデル', 0 FROM user_events WHERE slug = ?1`,
      )
      .bind(slug),
  ])
  return slug
}

/** 登録者へのお知らせ（通知の「お知らせ」タブ。workId 0・notifyType 0 の行） */
export const notifyPickupAuthor = async (activity: D1Database, props: { userId: string; model: ReturnType<typeof toUserModel>; nowSec: number }) => {
  const userId = Number.parseInt(props.userId, 10)
  if (!Number.isFinite(userId) || userId <= 0) return
  const message = `あなたが登録したモデル「${truncate(props.model.name, 60)}」が今週のピックアップモデルに選ばれました🎉 ホーム・生成画面・モデル一覧で紹介中です。/models/u/${props.model.id}`
  await activity
    .prepare(
      `INSERT INTO notifications (userId, workId, comment, stampId, ownerUserId, notifyInnerCount, notifyType, notifyTime, commentId)
       VALUES (?1, 0, ?2, -1, -1, 0, 0, ?3, -1)`,
    )
    .bind(userId, message, jstNowWall(props.nowSec))
    .run()
}

/** 登録者の表示名（aipictors-system の core から。無ければ null） */
const loadAuthorName = async (core: D1Database | null, userId: string) => {
  if (!core) return null
  const row = await core
    .prepare(
      `SELECT COALESCE(NULLIF(p.userName, ''), NULLIF(u.display_name, '')) AS name
         FROM wp_users u LEFT JOIN user_profiles p ON p.userId = u.ID WHERE u.ID = ?1 LIMIT 1`,
    )
    .bind(Number.parseInt(userId, 10))
    .first<{ name: string | null }>()
    .catch(() => null)
  return row?.name ?? null
}

type PickupRow = {
  week_start: string
  model_id: string
  source: string
  score: number | null
  stats: string
  event_slug: string | null
  x_draft: string | null
  notified_model_id: string | null
  decided_by: string | null
  created_at: number
  updated_at: number
}

const parseJson = (value: string | null) => {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const toPickup = (row: PickupRow) => ({
  weekStart: row.week_start,
  weekEnd: addDays(row.week_start, 6),
  modelId: row.model_id,
  source: row.source,
  score: row.score === null ? null : Number(row.score),
  stats: parseJson(row.stats) ?? {},
  eventSlug: row.event_slug,
  eventTag: pickupEventTag(row.week_start),
  xDraft: parseJson(row.x_draft),
  decidedBy: row.decided_by,
  updatedAt: Number(row.updated_at),
})

export type PickupDeps = { db: Db; genlog: Db; system: SystemD1; now: number }

/** 候補（点数つき）。管理画面と自動選定で使う */
export const listPickupCandidates = async (deps: PickupDeps, weekStart = jstWeekStart(deps.now)) => {
  const [rows, recentPicks, usage] = await Promise.all([
    deps.db.query<UserModelRow>("SELECT * FROM user_models WHERE status = 'READY'"),
    deps.db.query<RecentPick>(
      `SELECT p.week_start, p.model_id, m.user_id FROM user_model_pickups p LEFT JOIN user_models m ON m.id = p.model_id
        WHERE p.week_start >= $1 ORDER BY p.week_start DESC`,
      [addDays(weekStart, -7 * RECENT_MODEL_WEEKS)],
    ),
    collectModelUsage(deps.genlog, deps.now - 7 * DAY),
  ])
  return rankPickupCandidates({ rows, usage, recentPicks, weekStart, nowSec: deps.now })
}

/**
 * その週のピックアップを決める（作る・差し替える）。お題の枠・登録者へのお知らせ・X の下書きもここで
 * - お題の枠とお知らせは失敗しても選定は残す（次の呼び出しでやり直す）
 */
export const decidePickup = async (
  deps: PickupDeps,
  props: { weekStart: string; modelId: string; source: "AUTO" | "ADMIN"; decidedBy?: string | null; candidate?: PickupCandidate | null },
) => {
  if (!isWeekStart(props.weekStart)) throw new PickupError(400, "週の指定が正しくありません（月曜の日付）")
  const model = await getUserModel(deps.db, props.modelId).catch(() => null)
  if (!model || model.status !== "READY") throw new PickupError(404, "使えるモデルが見つかりません")
  const existing = await deps.db.queryOne<PickupRow>("SELECT * FROM user_model_pickups WHERE week_start = $1", [props.weekStart])
  const authorName = await loadAuthorName(deps.system.core, model.userId)
  const draft = buildPickupXDraft({ model, weekStart: props.weekStart, authorName })
  // 候補の数字が無い呼び出し（やり直し・同じモデルのまま）は前の数字を残す
  const sameModel = existing?.model_id === model.id
  const stats = props.candidate
    ? { ...props.candidate.stats, authorName }
    : { ...(sameModel ? (parseJson(existing?.stats ?? null) ?? {}) : {}), authorName }
  const score = props.candidate?.score ?? (sameModel ? (existing?.score ?? null) : null)
  await deps.db.execute(
    `INSERT INTO user_model_pickups (week_start, model_id, source, score, stats, x_draft, decided_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT(week_start) DO UPDATE SET model_id = excluded.model_id, source = excluded.source, score = excluded.score,
       stats = excluded.stats, x_draft = excluded.x_draft, decided_by = excluded.decided_by, updated_at = excluded.updated_at`,
    [
      props.weekStart,
      model.id,
      props.source,
      score,
      JSON.stringify(stats),
      JSON.stringify(draft),
      props.decidedBy ?? null,
      deps.now,
    ],
  )
  // 今週と来週の分だけお題の枠とお知らせを出す（過去の週を差し替えても出さない）
  const current = jstWeekStart(deps.now)
  if (props.weekStart >= current) {
    let eventSlug = existing?.event_slug ?? null
    if (deps.system.core) {
      try {
        eventSlug = await upsertPickupEvent(deps.system.core, { weekStart: props.weekStart, model, authorName, nowSec: deps.now })
      } catch (error) {
        console.log(JSON.stringify({ event: "user_models.pickup.event_failed", weekStart: props.weekStart, message: String((error as Error)?.message ?? error) }))
      }
    }
    let notified = existing?.notified_model_id ?? null
    if (deps.system.activity && notified !== model.id) {
      try {
        await notifyPickupAuthor(deps.system.activity, { userId: model.userId, model, nowSec: deps.now })
        notified = model.id
      } catch (error) {
        console.log(JSON.stringify({ event: "user_models.pickup.notify_failed", weekStart: props.weekStart, message: String((error as Error)?.message ?? error) }))
      }
    }
    await deps.db.execute("UPDATE user_model_pickups SET event_slug = $2, notified_model_id = $3 WHERE week_start = $1", [
      props.weekStart,
      eventSlug,
      notified,
    ])
  }
  return getPickup(deps.db, props.weekStart)
}

export class PickupError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export const getPickup = async (db: Db, weekStart: string) => {
  const row = await db.queryOne<PickupRow>("SELECT * FROM user_model_pickups WHERE week_start = $1", [weekStart])
  if (!row) return null
  const model = await getUserModel(db, row.model_id).catch(() => null)
  return { ...toPickup(row), model }
}

/** 公開用: 今週のピックアップ（モデルが使えなくなっていれば null）。X の下書きは返さない */
export const getCurrentPickup = async (db: Db, nowSec: number) => {
  const pickup = await getPickup(db, jstWeekStart(nowSec))
  if (!pickup || !pickup.model || pickup.model.status !== "READY") return null
  const { xDraft: _xDraft, decidedBy: _decidedBy, score: _score, ...rest } = pickup
  return { ...rest, authorName: typeof rest.stats?.authorName === "string" ? rest.stats.authorName : null, stats: undefined }
}

/** 管理用: 直近の週の一覧（新しい順） */
export const listPickups = async (db: Db, limit = 12) => {
  const rows = await db.query<PickupRow>("SELECT * FROM user_model_pickups ORDER BY week_start DESC LIMIT $1", [Math.min(Math.max(limit, 1), 52)])
  return Promise.all(
    rows.map(async (row) => ({ ...toPickup(row), model: await getUserModel(db, row.model_id).catch(() => null) })),
  )
}

/**
 * cron（毎日 00:00 JST）から呼ぶ。今週の分がまだ無いときだけ自動で選ぶ（運営の差し替えは上書きしない）。
 * 選んだモデルが使えなくなっていたら選び直す
 */
export const runWeeklyPickup = async (deps: PickupDeps) => {
  const weekStart = jstWeekStart(deps.now)
  const existing = await getPickup(deps.db, weekStart)
  if (existing?.model?.status === "READY") {
    // 枠やお知らせが失敗していたらやり直す
    const needsEvent = deps.system.core !== null && !existing.eventSlug
    const needsNotify = deps.system.activity !== null && existing.modelId !== (await notifiedModel(deps.db, weekStart))
    if (needsEvent || needsNotify) {
      await decidePickup(deps, { weekStart, modelId: existing.modelId, source: existing.source === "ADMIN" ? "ADMIN" : "AUTO", decidedBy: existing.decidedBy })
      return { weekStart, action: "repaired", modelId: existing.modelId }
    }
    return { weekStart, action: "kept", modelId: existing.modelId }
  }
  const candidates = await listPickupCandidates(deps, weekStart)
  const best = candidates.find((c) => c.excludedReason === null) ?? candidates.find((c) => c.excludedReason?.startsWith("利用") ?? false)
  if (!best) return { weekStart, action: "none", modelId: null }
  await decidePickup(deps, { weekStart, modelId: best.modelId, source: "AUTO", candidate: best })
  return { weekStart, action: "picked", modelId: best.modelId, score: best.score }
}

const notifiedModel = async (db: Db, weekStart: string) =>
  (await db.queryOne<{ notified_model_id: string | null }>("SELECT notified_model_id FROM user_model_pickups WHERE week_start = $1", [weekStart]))
    ?.notified_model_id ?? null
