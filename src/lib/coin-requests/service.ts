// @ts-nocheck
// 有料リクエストとプラン: プラン・受付設定・申し込み・操作（承諾/お断り/納品/修正/確定/キャンセル/メッセージ/通報）・運営の介入・期限の処理
import { getCreatorPayoutConfig } from "../creator-payouts/config"
import {
  ACTIVE_STATUSES,
  AUTO_COMPLETE_DAYS,
  DAY,
  MAX_BODY_LENGTH,
  MAX_DELIVERY_IMAGES,
  MAX_MESSAGE_LENGTH,
  MAX_REFERENCE_IMAGES,
  MAX_SAMPLE_IMAGES,
  MAX_TITLE_LENGTH,
  OPEN_STATUSES,
  OVERDUE_GRACE_DAYS,
  PLAN_CATEGORIES,
  REQUEST_MAX_COINS,
  REQUEST_MIN_COINS,
  REVISION_EXTEND_DAYS,
  calcSettlement,
  cleanImageUrls,
  getRequestConfig,
  parseJsonArray,
} from "./config"
import { createEscrowedRequest, refundRequest, settleRequest, transitionRequest } from "./escrow"
import { notifyRequestEvent, removeMessageNotification } from "./notify"
import { countShowcase, ensureShowcaseImages, listShowcase, runShowcaseJob } from "./showcase"

const clampInt = (value, min, max, fallback) => {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
const text = (value, max) => String(value ?? "").trim().slice(0, max)
/** true/false を 1/0 に。送られてこなかったときは null（保存では今の値のまま） */
const toOptionalFlag = (value) => (value === true ? 1 : value === false ? 0 : null)
const inList = (values) => values.map((v) => `'${v}'`).join(", ")

// ---- 表示用の形 ----

export const toPlan = (row, extra = {}) =>
  row && {
    id: String(row.id),
    userId: String(row.user_id),
    title: row.title,
    description: row.description,
    category: row.category,
    sampleImageUrls: parseJsonArray(row.sample_image_urls),
    priceCoins: Number(row.price_coins),
    deliveryDays: Number(row.delivery_days),
    imageCount: Number(row.image_count),
    revisionCount: Number(row.revision_count),
    maxActive: Number(row.max_active),
    isAccepting: Number(row.is_accepting) === 1,
    allowsR18: Number(row.allows_r18) === 1,
    premiumOnly: Number(row.premium_only ?? 0) === 1,
    status: row.status,
    orderCount: Number(row.order_count ?? 0),
    completedCount: Number(row.completed_count ?? 0),
    activeCount: row.active_count === undefined ? undefined : Number(row.active_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...extra,
  }

const toRequest = (row, viewerUserId) => {
  const role =
    String(row.requester_user_id) === String(viewerUserId) ? "REQUESTER" : String(row.creator_user_id) === String(viewerUserId) ? "CREATOR" : "ADMIN"
  return {
    id: String(row.id),
    planId: row.plan_id === null || row.plan_id === undefined ? null : String(row.plan_id),
    planTitle: row.plan_title ?? null,
    requesterUserId: String(row.requester_user_id),
    creatorUserId: String(row.creator_user_id),
    role,
    title: row.title,
    body: row.body,
    referenceImageUrls: parseJsonArray(row.reference_image_urls),
    isR18: Number(row.is_r18) === 1,
    priceCoins: Number(row.price_coins),
    deliveryDays: Number(row.delivery_days),
    revisionLeft: Number(row.revision_left),
    // 預かりの内訳は依頼者と運営にだけ見せる
    escrow:
      role === "CREATOR"
        ? null
        : { freeCoins: Number(row.free_spent), premiumCoins: Number(row.premium_spent), paidCoins: Number(row.paid_coins) },
    status: row.status,
    respondBy: Number(row.respond_by),
    dueAt: row.due_at ? Number(row.due_at) : null,
    autoCompleteAt: row.auto_complete_at ? Number(row.auto_complete_at) : null,
    acceptedAt: row.accepted_at ? Number(row.accepted_at) : null,
    deliveredAt: row.delivered_at ? Number(row.delivered_at) : null,
    deliveryMessage: row.delivery_message ?? null,
    deliveryImageUrls: parseJsonArray(row.delivery_image_urls),
    deliveredWorkId: row.delivered_work_id ?? null,
    completedAt: row.completed_at ? Number(row.completed_at) : null,
    closedReason: row.closed_reason ?? null,
    closedAt: row.closed_at ? Number(row.closed_at) : null,
    settlement:
      row.fee_coins === null || row.fee_coins === undefined
        ? null
        : {
            feeCoins: Number(row.fee_coins),
            earnedCoins: Number(row.earned_coins ?? 0),
            earnedYen: Math.floor(Number(row.earned_milliyen ?? 0) / 1000),
            freeCoins: Number(row.settle_free_coins ?? 0),
            premiumCoins: Number(row.settle_premium_coins ?? 0),
          },
    reportCount: role === "ADMIN" ? Number(row.report_count ?? 0) : undefined,
    // 実績: 依頼者の許可・クリエイターの非表示・透かし入りの画像（null = まだ作っていない）
    showcaseAllowed: Number(row.showcase_allowed ?? 0) === 1,
    showcaseHidden: Number(row.showcase_hidden ?? 0) === 1,
    showcaseImageUrls: row.showcase_image_urls === null || row.showcase_image_urls === undefined ? null : parseJsonArray(row.showcase_image_urls),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

// ---- 受付設定 ----

export const getRequestSettings = async ({ db, userId }) => {
  const row = await db.queryOne(`SELECT * FROM creator_request_settings WHERE user_id = $1`, [String(userId)])
  return {
    userId: String(userId),
    acceptsFreeRequests: Number(row?.accepts_free_requests ?? 0) === 1,
    minCoins: Number(row?.min_coins ?? 500),
    allowsR18: Number(row?.allows_r18 ?? 0) === 1,
    premiumOnly: Number(row?.premium_only ?? 0) === 1,
    maxActive: Number(row?.max_active ?? 3),
    note: row?.note ?? "",
  }
}

export const saveRequestSettings = async ({ db, now, userId, input }) => {
  await db.execute(
    // premiumOnly を送ってこない画面（古いアプリ）からの保存では、今の設定を変えない
    `INSERT INTO creator_request_settings(user_id, accepts_free_requests, min_coins, allows_r18, max_active, note, updated_at, premium_only)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 0))
     ON CONFLICT (user_id) DO UPDATE SET accepts_free_requests = EXCLUDED.accepts_free_requests, min_coins = EXCLUDED.min_coins,
       allows_r18 = EXCLUDED.allows_r18, max_active = EXCLUDED.max_active, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at,
       premium_only = COALESCE($8, creator_request_settings.premium_only)`,
    [
      String(userId),
      input.acceptsFreeRequests ? 1 : 0,
      clampInt(input.minCoins, REQUEST_MIN_COINS, REQUEST_MAX_COINS, 500),
      input.allowsR18 ? 1 : 0,
      clampInt(input.maxActive, 1, 10, 3),
      text(input.note, 500),
      now,
      toOptionalFlag(input.premiumOnly),
    ],
  )
  return getRequestSettings({ db, userId })
}

// ---- プラン ----

const PLAN_SORTS = {
  popular: "p.order_count DESC, p.completed_count DESC, p.id DESC",
  new: "p.id DESC",
  price_asc: "p.price_coins ASC, p.id DESC",
  price_desc: "p.price_coins DESC, p.id DESC",
  fast: "p.delivery_days ASC, p.id DESC",
}

/** プランの一覧（userId を指定するとその人のプラン。includeHidden は本人のときだけ） */
export const listPlans = async ({ db, userId = null, category = null, sort = "popular", maxPrice = null, maxDays = null, r18 = null, includeHidden = false, acceptingOnly = false, limit = 30, offset = 0 }) => {
  const where = [includeHidden ? "p.status <> 'DELETED'" : "p.status = 'ACTIVE'"]
  const params = []
  const add = (sql, value) => {
    params.push(value)
    where.push(sql.replace("?", `$${params.length}`))
  }
  if (userId) add("p.user_id = ?", String(userId))
  if (category && PLAN_CATEGORIES.includes(category)) add("p.category = ?", category)
  if (maxPrice) add("p.price_coins <= ?", clampInt(maxPrice, 1, REQUEST_MAX_COINS, REQUEST_MAX_COINS))
  if (maxDays) add("p.delivery_days <= ?", clampInt(maxDays, 1, 90, 90))
  // r18: true = R18 を受け付けるプランだけ、false = 指定なし（全年齢の依頼はどのプランでもできる）
  if (r18 === true) where.push("p.allows_r18 = 1")
  if (acceptingOnly) where.push("p.is_accepting = 1")
  params.push(clampInt(limit, 1, 60, 30), clampInt(offset, 0, 10000, 0))
  const rows = await db.query(
    `SELECT p.*, (SELECT COUNT(*) FROM coin_requests r WHERE r.plan_id = p.id AND r.status IN (${inList(ACTIVE_STATUSES)})) AS active_count
       FROM request_plans p WHERE ${where.join(" AND ")}
      ORDER BY p.is_accepting DESC, ${PLAN_SORTS[sort] ?? PLAN_SORTS.popular}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  return rows.map((row) => toPlan(row))
}

export const getPlan = async ({ db, planId }) => {
  const row = await db.queryOne(
    `SELECT p.*, (SELECT COUNT(*) FROM coin_requests r WHERE r.plan_id = p.id AND r.status IN (${inList(ACTIVE_STATUSES)})) AS active_count
       FROM request_plans p WHERE p.id = $1 AND p.status <> 'DELETED'`,
    [planId],
  )
  return toPlan(row)
}

export const validatePlanInput = (input) => {
  const title = text(input.title, MAX_TITLE_LENGTH)
  const description = text(input.description, MAX_BODY_LENGTH)
  if (!title) return { error: "TITLE_REQUIRED" }
  if (!description) return { error: "DESCRIPTION_REQUIRED" }
  const price = Math.floor(Number(input.priceCoins))
  if (!Number.isFinite(price) || price < REQUEST_MIN_COINS || price > REQUEST_MAX_COINS) return { error: "INVALID_PRICE" }
  return {
    value: {
      title,
      description,
      category: PLAN_CATEGORIES.includes(input.category) ? input.category : "ILLUSTRATION",
      sampleImageUrls: cleanImageUrls(input.sampleImageUrls, MAX_SAMPLE_IMAGES),
      priceCoins: price,
      deliveryDays: clampInt(input.deliveryDays, 1, 90, 7),
      imageCount: clampInt(input.imageCount, 1, 20, 1),
      revisionCount: clampInt(input.revisionCount, 0, 5, 1),
      maxActive: clampInt(input.maxActive, 1, 10, 3),
      isAccepting: input.isAccepting !== false,
      allowsR18: input.allowsR18 === true,
      // null = 送られてこなかった（古いアプリ）。編集では今の設定のまま、新規はフリーコインもOK
      premiumOnly: toOptionalFlag(input.premiumOnly),
      status: input.status === "HIDDEN" ? "HIDDEN" : "ACTIVE",
    },
  }
}

export const savePlan = async ({ db, now, userId, planId = null, input }) => {
  const checked = validatePlanInput(input)
  if (checked.error) return { ok: false, code: checked.error }
  const v = checked.value
  const values = [
    v.title,
    v.description,
    v.category,
    JSON.stringify(v.sampleImageUrls),
    v.priceCoins,
    v.deliveryDays,
    v.imageCount,
    v.revisionCount,
    v.maxActive,
    v.isAccepting ? 1 : 0,
    v.allowsR18 ? 1 : 0,
    v.status,
    now,
    String(userId),
    v.premiumOnly,
  ]
  if (planId) {
    const result = await db.executeResult(
      `UPDATE request_plans SET title = $1, description = $2, category = $3, sample_image_urls = $4, price_coins = $5, delivery_days = $6,
              image_count = $7, revision_count = $8, max_active = $9, is_accepting = $10, allows_r18 = $11, status = $12, updated_at = $13,
              premium_only = COALESCE($15, premium_only)
        WHERE id = $16 AND user_id = $14 AND status <> 'DELETED'`,
      [...values, planId],
    )
    if (result.rowCount !== 1) return { ok: false, code: "PLAN_NOT_FOUND" }
    return { ok: true, plan: await getPlan({ db, planId }) }
  }
  const count = await db.queryOne(`SELECT COUNT(*) AS n FROM request_plans WHERE user_id = $1 AND status <> 'DELETED'`, [String(userId)])
  if (Number(count?.n ?? 0) >= 20) return { ok: false, code: "TOO_MANY_PLANS" }
  const result = await db.executeResult(
    `INSERT INTO request_plans(title, description, category, sample_image_urls, price_coins, delivery_days, image_count, revision_count, max_active,
            is_accepting, allows_r18, status, created_at, updated_at, user_id, premium_only)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14, COALESCE($15, 0))`,
    values,
  )
  return { ok: true, plan: await getPlan({ db, planId: result.lastRowId }) }
}

export const deletePlan = async ({ db, now, userId, planId, isModerator = false }) => {
  const result = await db.executeResult(
    `UPDATE request_plans SET status = 'DELETED', is_accepting = 0, updated_at = $1 WHERE id = $2 AND ($4 = 1 OR user_id = $3) AND status <> 'DELETED'`,
    [now, planId, String(userId), isModerator ? 1 : 0],
  )
  return { ok: result.rowCount === 1 }
}

/** クリエイターのページに出す受付の情報（プラン・自由リクエスト） */
export const getCreatorRequestProfile = async ({ db, userId, viewerUserId = null }) => {
  const isOwner = viewerUserId && String(viewerUserId) === String(userId)
  const [plans, settings, active] = await Promise.all([
    listPlans({ db, userId, includeHidden: isOwner, limit: 20 }),
    getRequestSettings({ db, userId }),
    db.queryOne(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN plan_id IS NULL THEN 1 ELSE 0 END) AS free_n FROM coin_requests WHERE creator_user_id = $1 AND status IN (${inList(ACTIVE_STATUSES)})`,
      [String(userId)],
    ),
  ])
  const [completed, showcase, counts] = await Promise.all([
    db.queryOne(`SELECT COUNT(*) AS n FROM coin_requests WHERE creator_user_id = $1 AND status IN ('COMPLETED', 'ADMIN_COMPLETED')`, [String(userId)]),
    listShowcase({ db, creatorUserId: userId, limit: 12 }),
    countShowcase({ db, creatorUserId: userId }),
  ])
  return {
    // 全年齢の実績だけ。R18 は件数だけ返し、画面が年齢の確認のあとに showcase?r18=1 で読む
    showcase,
    showcaseCount: counts.all,
    showcaseR18Count: counts.r18,
    plans,
    settings,
    activeCount: Number(active?.n ?? 0),
    freeRequestActiveCount: Number(active?.free_n ?? 0),
    completedCount: Number(completed?.n ?? 0),
    canFreeRequest: settings.acceptsFreeRequests && Number(active?.free_n ?? 0) < settings.maxActive,
  }
}

// ---- 申し込み ----

export const applyRequest = async ({ db, env, core, activity, now, input }) => {
  const config = getRequestConfig(env)
  if (!config.enabled) return { ok: false, code: "DISABLED" }
  const requesterUserId = String(input.requesterUserId)
  const title = text(input.title, MAX_TITLE_LENGTH)
  const body = text(input.body, MAX_BODY_LENGTH)
  const clientKey = text(input.clientKey, 64)
  if (!body) return { ok: false, code: "BODY_REQUIRED" }
  if (!clientKey) return { ok: false, code: "CLIENT_KEY_REQUIRED" }
  let creatorUserId = input.creatorUserId ? String(input.creatorUserId) : null
  let planId = input.planId ? Number(input.planId) : null
  let priceCoins = Math.floor(Number(input.priceCoins))
  let deliveryDays = clampInt(input.deliveryDays, 1, 90, 14)
  let revisionCount = clampInt(input.revisionCount, 0, 3, 1)
  let planTitle = null
  let premiumOnly = false
  if (planId) {
    const plan = await getPlan({ db, planId })
    if (!plan || plan.status !== "ACTIVE") return { ok: false, code: "PLAN_NOT_FOUND" }
    creatorUserId = plan.userId
    deliveryDays = plan.deliveryDays
    revisionCount = plan.revisionCount
    planTitle = plan.title
    premiumOnly = plan.premiumOnly
    // 値段は画面で見た値段（変わっていたら受け付けない）
    if (!Number.isFinite(priceCoins)) priceCoins = plan.priceCoins
  }
  if (!creatorUserId) return { ok: false, code: "CREATOR_REQUIRED" }
  if (!planId) premiumOnly = (await getRequestSettings({ db, userId: creatorUserId })).premiumOnly
  if (creatorUserId === requesterUserId) return { ok: false, code: "SELF_REQUEST" }
  if (!Number.isFinite(priceCoins) || priceCoins < REQUEST_MIN_COINS || priceCoins > REQUEST_MAX_COINS) return { ok: false, code: "INVALID_PRICE" }
  if (core) {
    // ブロックしている/されている相手には申し込めない。退会した人にも
    const blocked = await core
      .prepare(
        `SELECT 1 AS hit FROM blocked_users WHERE is_canceled = 0 AND ((user_id = ?1 AND blocked_user_id = ?2) OR (user_id = ?2 AND blocked_user_id = ?1)) LIMIT 1`,
      )
      .bind(Number(requesterUserId), Number(creatorUserId))
      .first()
      .catch(() => null)
    if (blocked) return { ok: false, code: "BLOCKED" }
    const creator = await core.prepare(`SELECT ID FROM wp_users WHERE ID = ?1`).bind(Number(creatorUserId)).first().catch(() => ({ ID: creatorUserId }))
    if (!creator) return { ok: false, code: "CREATOR_NOT_FOUND" }
  }
  const result = await createEscrowedRequest({
    db,
    now,
    input: {
      requesterUserId,
      creatorUserId,
      planId,
      clientKey,
      title: title || planTitle || "リクエスト",
      body,
      referenceImageUrls: cleanImageUrls(input.referenceImageUrls, MAX_REFERENCE_IMAGES),
      isR18: input.isR18 === true,
      priceCoins,
      deliveryDays,
      revisionCount,
      // 払うコイン（FREE / PREMIUM のどちらか一方）。指定がなければ預かりの処理が決める
      coinType: input.coinType,
      premiumOnly,
    },
  })
  if (!result.ok) return result
  if (!result.duplicated) {
    // 完成した作品をクリエイターの実績として公開してよいか（依頼者があとから変えられる）
    if (input.showcaseAllowed === true) {
      await db.execute(`UPDATE coin_requests SET showcase_allowed = 1 WHERE id = $1`, [result.requestId])
    }
    await notifyRequestEvent({ db, env, core, activity, requestId: result.requestId, event: "APPLIED", actorUserId: requesterUserId })
  }
  return { ok: true, requestId: String(result.requestId) }
}

// ---- 依頼の取得 ----

/** メッセージに付けられるリアクション（相手のメッセージに 1 人 1 つ） */
export const MESSAGE_REACTIONS = ["👍", "❤️", "🙏", "😊", "🎉", "👀"]

/** { "<userId>": "👍" } を [{ userId, emoji }] にする（壊れた値や許可していない絵文字は捨てる） */
const parseReactions = (value) => {
  try {
    const parsed = JSON.parse(value ?? "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
    return Object.entries(parsed)
      .filter(([, emoji]) => MESSAGE_REACTIONS.includes(String(emoji)))
      .map(([userId, emoji]) => ({ userId: String(userId), emoji: String(emoji) }))
  } catch {
    return []
  }
}

/** 送信を取り消したメッセージの代わりに出す文（取り消しを知らない古いアプリでもこの文が出る） */
export const UNSENT_MESSAGE_BODY = "メッセージの送信を取り消しました"

const REQUEST_SELECT = `SELECT r.*, p.title AS plan_title FROM coin_requests r LEFT JOIN request_plans p ON p.id = r.plan_id`

export const getRequest = async ({ db, requestId, viewerUserId, isModerator = false }) => {
  const row = await db.queryOne(`${REQUEST_SELECT} WHERE r.id = $1`, [requestId])
  if (!row) return null
  const isParty = String(row.requester_user_id) === String(viewerUserId) || String(row.creator_user_id) === String(viewerUserId)
  if (!isParty && !isModerator) return null
  const messages = await db.query(
    `SELECT id, sender_user_id, body, image_urls, reactions, created_at, deleted_at FROM coin_request_messages WHERE request_id = $1 ORDER BY id ASC LIMIT 300`,
    [requestId],
  )
  return {
    ...toRequest(row, isParty ? viewerUserId : null),
    messages: messages.map((m) => {
      // 取り消したメッセージは当事者には中身を見せない（運営は通報の確認のため元の内容を見られる）
      const hidden = m.deleted_at != null && isParty
      return {
        id: String(m.id),
        senderUserId: m.sender_user_id === null ? null : String(m.sender_user_id),
        body: hidden ? UNSENT_MESSAGE_BODY : m.body,
        imageUrls: hidden ? [] : parseJsonArray(m.image_urls),
        reactions: hidden ? [] : parseReactions(m.reactions),
        createdAt: Number(m.created_at),
        deletedAt: m.deleted_at == null ? null : Number(m.deleted_at),
      }
    }),
  }
}

const STATUS_GROUPS = {
  pending: ["PENDING"],
  active: ["ACCEPTED"],
  delivered: ["DELIVERED"],
  open: OPEN_STATUSES,
  done: ["COMPLETED", "ADMIN_COMPLETED"],
  closed: ["DECLINED", "CANCELED", "EXPIRED", "ADMIN_CANCELED"],
}

export const listRequests = async ({ db, userId, role = "received", status = "open", limit = 50, offset = 0 }) => {
  const column = role === "sent" ? "requester_user_id" : "creator_user_id"
  const statuses = STATUS_GROUPS[status] ?? null
  const rows = await db.query(
    `${REQUEST_SELECT} WHERE r.${column} = $1 ${statuses ? `AND r.status IN (${inList(statuses)})` : ""}
      ORDER BY CASE WHEN r.status IN (${inList(OPEN_STATUSES)}) THEN 0 ELSE 1 END, r.updated_at DESC LIMIT $2 OFFSET $3`,
    [String(userId), clampInt(limit, 1, 100, 50), clampInt(offset, 0, 10000, 0)],
  )
  const counts = await db.query(`SELECT status, COUNT(*) AS n FROM coin_requests WHERE ${column} = $1 GROUP BY status`, [String(userId)])
  const countBy = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]))
  const groupCounts = Object.fromEntries(Object.entries(STATUS_GROUPS).map(([k, list]) => [k, list.reduce((sum, s) => sum + (countBy[s] ?? 0), 0)]))
  return { requests: rows.map((row) => toRequest(row, userId)), counts: groupCounts }
}

/** 未対応の数（マイページ・ヘッダーのバッジ用）: 受けた依頼の承諾待ち＋制作中、出した依頼の納品済み（確認待ち） */
export const getRequestBadge = async ({ db, userId }) => {
  const row = await db.queryOne(
    `SELECT (SELECT COUNT(*) FROM coin_requests WHERE creator_user_id = $1 AND status IN ('PENDING', 'ACCEPTED')) AS received,
            (SELECT COUNT(*) FROM coin_requests WHERE requester_user_id = $1 AND status = 'DELIVERED') AS to_confirm`,
    [String(userId)],
  )
  return { received: Number(row?.received ?? 0), toConfirm: Number(row?.to_confirm ?? 0) }
}

// ---- 操作 ----

const addMessage = (db, now, requestId, senderUserId, body, imageUrls = []) =>
  db.execute(`INSERT INTO coin_request_messages(request_id, sender_user_id, body, image_urls, created_at) VALUES ($1, $2, $3, $4, $5)`, [
    requestId,
    senderUserId === null ? null : String(senderUserId),
    body,
    JSON.stringify(imageUrls),
    now,
  ])

/** 報酬にするか: 報酬が有効・クリエイターが参加中・全年齢の依頼 */
export const isEarningsEligible = async ({ db, env, request }) => {
  if (Number(request.is_r18) === 1) return false
  if (!getCreatorPayoutConfig(env).enabled) return false
  const profile = await db.queryOne(`SELECT status FROM creator_payout_profiles WHERE user_id = $1`, [String(request.creator_user_id)])
  return profile?.status === "JOINED"
}

export const completeRequest = async ({ db, env, core, activity, now, request, fromStatuses, toStatus, actorUserId, reason = null }) => {
  const eligible = await isEarningsEligible({ db, env, request })
  const result = await settleRequest({
    db,
    now,
    request,
    fromStatuses,
    toStatus,
    feePpm: getRequestConfig(env).feePpm,
    eligible,
    actorUserId,
    reason,
  })
  if (result.ok) {
    await addMessage(db, now, request.id, null, toStatus === "COMPLETED" ? "取引が完了しました" : "運営が取引を完了にしました")
    await notifyRequestEvent({ db, env, core, activity, requestId: request.id, event: "COMPLETED", actorUserId })
    // 実績の許可があれば透かし入りの画像を作る（作れなければ runRequestJob がやり直す）
    if (Number(request.showcase_allowed ?? 0) === 1) {
      await ensureShowcaseImages({ db, env, core, now, requestId: request.id }).catch(() => null)
    }
  }
  return result
}

/**
 * 当事者の操作。action:
 * - accept / decline（クリエイター、承諾待ちのとき）
 * - cancel（依頼者: 承諾待ち、または納期を過ぎた制作中）
 * - deliver（クリエイター: 制作中のとき。画像・メッセージ・作品の ID）
 * - revise（依頼者: 納品済みで修正回数が残っているとき）
 * - complete（依頼者: 納品済みのとき）
 * - message（当事者、終わっていても 30 日まで）
 * - react（当事者: 相手のメッセージにリアクションを 1 つ付ける。input.messageId・input.emoji。emoji が空なら外す。通知はしない）
 * - showcase（依頼者: 実績として公開してよいか。input.allowed。いつでも変えられる）
 * - showcase-hide（クリエイター: 許可された実績を自分の実績に出さない。input.hidden）
 */
export const actOnRequest = async ({ db, env, core, activity, now, requestId, userId, action, input = {} }) => {
  const row = await db.queryOne(`SELECT * FROM coin_requests WHERE id = $1`, [requestId])
  if (!row) return { ok: false, code: "NOT_FOUND" }
  const uid = String(userId)
  const isCreator = String(row.creator_user_id) === uid
  const isRequester = String(row.requester_user_id) === uid
  if (!isCreator && !isRequester) return { ok: false, code: "NOT_FOUND" }
  const fail = (code) => ({ ok: false, code })
  const done = async (event, extra = {}) => {
    if (event) await notifyRequestEvent({ db, env, core, activity, requestId, event, actorUserId: uid, extra })
    return { ok: true, request: await getRequest({ db, requestId, viewerUserId: uid }) }
  }
  switch (action) {
    case "accept": {
      if (!isCreator) return fail("FORBIDDEN")
      const dueAt = now + Number(row.delivery_days) * DAY
      const r = await transitionRequest({
        db,
        requestId,
        fromStatuses: ["PENDING"],
        set: "status = 'ACCEPTED', accepted_at = $2, due_at = $3, reminded_at = NULL, updated_at = $2",
        params: [now, dueAt],
      })
      if (!r.ok) return fail("INVALID_STATE")
      const note = text(input.message, MAX_MESSAGE_LENGTH)
      await addMessage(db, now, requestId, null, "依頼を承諾しました")
      if (note) await addMessage(db, now, requestId, uid, note)
      return done("ACCEPTED")
    }
    case "decline": {
      if (!isCreator) return fail("FORBIDDEN")
      const reason = text(input.reason, 500)
      const r = await refundRequest({ db, now, requestId, fromStatuses: ["PENDING"], toStatus: "DECLINED", reason: reason || null, actorUserId: uid })
      if (!r.ok) return fail(r.code)
      await addMessage(db, now, requestId, null, `依頼をお断りしました。コインは全額返却されました${reason ? `\n理由: ${reason}` : ""}`)
      return done("DECLINED")
    }
    case "cancel": {
      if (!isRequester) return fail("FORBIDDEN")
      const overdue = row.status === "ACCEPTED" && row.due_at && now > Number(row.due_at)
      if (row.status !== "PENDING" && !overdue) return fail(row.status === "ACCEPTED" ? "NOT_OVERDUE" : "INVALID_STATE")
      const r = await refundRequest({
        db,
        now,
        requestId,
        fromStatuses: overdue ? ["ACCEPTED"] : ["PENDING"],
        toStatus: "CANCELED",
        reason: overdue ? "overdue" : "requester",
        actorUserId: uid,
      })
      if (!r.ok) return fail(r.code)
      await addMessage(db, now, requestId, null, overdue ? "納期を過ぎたため依頼者がキャンセルしました。コインは全額返却されました" : "依頼者が依頼を取り下げました。コインは全額返却されました")
      return done("CANCELED")
    }
    case "deliver": {
      if (!isCreator) return fail("FORBIDDEN")
      const images = cleanImageUrls(input.imageUrls, MAX_DELIVERY_IMAGES)
      const workId = input.workId && /^\d+$/.test(String(input.workId)) ? String(input.workId) : null
      if (images.length === 0 && !workId) return fail("DELIVERY_REQUIRED")
      const message = text(input.message, MAX_MESSAGE_LENGTH)
      const r = await transitionRequest({
        db,
        requestId,
        fromStatuses: ["ACCEPTED"],
        set: "status = 'DELIVERED', delivered_at = $2, auto_complete_at = $3, delivery_message = $4, delivery_image_urls = $5, delivered_work_id = $6, updated_at = $2",
        params: [now, now + AUTO_COMPLETE_DAYS * DAY, message || null, JSON.stringify(images), workId],
      })
      if (!r.ok) return fail("INVALID_STATE")
      await addMessage(db, now, requestId, uid, message || "納品しました", images)
      return done("DELIVERED")
    }
    case "revise": {
      if (!isRequester) return fail("FORBIDDEN")
      const note = text(input.message, MAX_MESSAGE_LENGTH)
      if (!note) return fail("MESSAGE_REQUIRED")
      const r = await transitionRequest({
        db,
        requestId,
        fromStatuses: ["DELIVERED"],
        set: "status = 'ACCEPTED', revision_left = revision_left - 1, auto_complete_at = NULL, reminded_at = NULL, due_at = max(COALESCE(due_at, 0), $2) + $3, updated_at = $2",
        where: "revision_left > 0",
        params: [now, REVISION_EXTEND_DAYS * DAY],
      })
      if (!r.ok) return fail(row.status === "DELIVERED" && Number(row.revision_left) <= 0 ? "NO_REVISIONS_LEFT" : "INVALID_STATE")
      await addMessage(db, now, requestId, uid, `修正をお願いしました\n${note}`)
      return done("REVISION")
    }
    case "complete": {
      if (!isRequester) return fail("FORBIDDEN")
      const r = await completeRequest({ db, env, core, activity, now, request: row, fromStatuses: ["DELIVERED"], toStatus: "COMPLETED", actorUserId: uid })
      if (!r.ok) return fail(r.code)
      return done(null)
    }
    case "showcase": {
      if (!isRequester) return fail("FORBIDDEN")
      const allowed = input.allowed === true
      if ((Number(row.showcase_allowed) === 1) === allowed) return done(null)
      await db.execute(`UPDATE coin_requests SET showcase_allowed = $2, showcase_failed_at = NULL, updated_at = $3 WHERE id = $1`, [requestId, allowed ? 1 : 0, now])
      await addMessage(
        db,
        now,
        requestId,
        null,
        allowed ? "依頼者が、完成した作品を実績として公開することを許可しました（透かし入り）" : "依頼者が、実績としての公開の許可を取り消しました",
      )
      if (allowed) await ensureShowcaseImages({ db, env, core, now, requestId }).catch(() => null)
      return done(null)
    }
    case "showcase-hide": {
      if (!isCreator) return fail("FORBIDDEN")
      await db.execute(`UPDATE coin_requests SET showcase_hidden = $2, updated_at = $3 WHERE id = $1`, [requestId, input.hidden === true ? 1 : 0, now])
      return done(null)
    }
    case "message": {
      const body = text(input.body, MAX_MESSAGE_LENGTH)
      const images = cleanImageUrls(input.imageUrls, 4)
      if (!body && images.length === 0) return fail("MESSAGE_REQUIRED")
      const closedAt = Number(row.closed_at ?? row.completed_at ?? 0)
      if (closedAt && now - closedAt > 30 * DAY) return fail("CLOSED")
      await addMessage(db, now, requestId, uid, body, images)
      await db.execute(`UPDATE coin_requests SET updated_at = $2 WHERE id = $1`, [requestId, now])
      return done("MESSAGE", { body })
    }
    case "react": {
      const emoji = input.emoji ? String(input.emoji) : ""
      if (emoji && !MESSAGE_REACTIONS.includes(emoji)) return fail("INVALID_REACTION")
      const message = await db.queryOne(`SELECT id, sender_user_id, reactions, deleted_at FROM coin_request_messages WHERE id = $1 AND request_id = $2`, [
        Number(input.messageId),
        requestId,
      ])
      // 自分のメッセージ・取り消したメッセージと運営・システムのお知らせには付けない
      if (!message || message.sender_user_id === null || String(message.sender_user_id) === uid || message.deleted_at != null) return fail("MESSAGE_NOT_FOUND")
      const reactions = Object.fromEntries(parseReactions(message.reactions).map((r) => [r.userId, r.emoji]))
      if (emoji) reactions[uid] = emoji
      else delete reactions[uid]
      await db.execute(`UPDATE coin_request_messages SET reactions = $2 WHERE id = $1`, [message.id, JSON.stringify(reactions)])
      return done(null)
    }
    case "unsend": {
      // 自分が送ったメッセージの送信取り消し。納品と修正のお願いは依頼の記録なので取り消せない
      const message = await db.queryOne(
        `SELECT id, sender_user_id, body, image_urls, created_at, deleted_at FROM coin_request_messages WHERE id = $1 AND request_id = $2`,
        [Number(input.messageId), requestId],
      )
      if (!message || message.sender_user_id === null || String(message.sender_user_id) !== uid) return fail("MESSAGE_NOT_FOUND")
      if (message.deleted_at != null) return done(null)
      const isRevision = String(message.body).startsWith("修正をお願いしました\n")
      const isDelivery =
        isCreator &&
        row.delivered_at !== null &&
        Number(message.created_at) === Number(row.delivered_at) &&
        String(message.image_urls) === String(row.delivery_image_urls ?? "[]")
      if (isRevision || isDelivery) return fail("CANNOT_UNSEND")
      const closedAt = Number(row.closed_at ?? row.completed_at ?? 0)
      if (closedAt && now - closedAt > 30 * DAY) return fail("CLOSED")
      await db.execute(`UPDATE coin_request_messages SET deleted_at = $2, reactions = '{}' WHERE id = $1 AND deleted_at IS NULL`, [message.id, now])
      await removeMessageNotification({ activity, requestId, body: message.body })
      return done(null)
    }
    case "report": {
      const reason = text(input.reason, 1000)
      if (!reason) return fail("REASON_REQUIRED")
      await db.execute(`INSERT INTO coin_request_reports(request_id, reporter_user_id, reason, created_at) VALUES ($1, $2, $3, $4)`, [requestId, uid, reason, now])
      await db.execute(`UPDATE coin_requests SET report_count = report_count + 1 WHERE id = $1`, [requestId])
      return { ok: true }
    }
    default:
      return fail("UNKNOWN_ACTION")
  }
}

export const reportPlan = async ({ db, now, planId, userId, reason }) => {
  const body = text(reason, 1000)
  if (!body) return { ok: false, code: "REASON_REQUIRED" }
  await db.execute(`INSERT INTO coin_request_reports(plan_id, reporter_user_id, reason, created_at) VALUES ($1, $2, $3, $4)`, [planId, String(userId), body, now])
  return { ok: true }
}

// ---- 運営 ----

export const listRequestsForAdmin = async ({ db, status = null, reportedOnly = false, limit = 100 }) => {
  const where = []
  if (status && STATUS_GROUPS[status]) where.push(`r.status IN (${inList(STATUS_GROUPS[status])})`)
  if (reportedOnly) where.push("r.report_count > 0")
  const rows = await db.query(
    `${REQUEST_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.updated_at DESC LIMIT $1`,
    [clampInt(limit, 1, 300, 100)],
  )
  const reports = await db.query(
    `SELECT id, request_id, plan_id, reporter_user_id, reason, status, created_at FROM coin_request_reports ORDER BY id DESC LIMIT 100`,
  )
  const totals = await db.queryOne(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN status IN (${inList(OPEN_STATUSES)}) THEN free_spent + premium_spent ELSE 0 END) AS escrow_coins,
            SUM(CASE WHEN status IN ('COMPLETED', 'ADMIN_COMPLETED') THEN fee_coins ELSE 0 END) AS fee_coins,
            SUM(CASE WHEN status IN ('COMPLETED', 'ADMIN_COMPLETED') THEN earned_milliyen ELSE 0 END) AS earned_milliyen
       FROM coin_requests`,
  )
  return {
    requests: rows.map((row) => toRequest(row, null)),
    reports: reports.map((r) => ({ ...r, id: String(r.id) })),
    totals: {
      count: Number(totals?.n ?? 0),
      escrowCoins: Number(totals?.escrow_coins ?? 0),
      feeCoins: Number(totals?.fee_coins ?? 0),
      earnedYen: Math.floor(Number(totals?.earned_milliyen ?? 0) / 1000),
    },
  }
}

/** 運営の介入: cancel（全額返却）/ complete（確定） */
export const adminActOnRequest = async ({ db, env, core, activity, now, requestId, moderatorUserId, action, reason }) => {
  const row = await db.queryOne(`SELECT * FROM coin_requests WHERE id = $1`, [requestId])
  if (!row) return { ok: false, code: "NOT_FOUND" }
  const note = text(reason, 500) || null
  if (action === "cancel") {
    const r = await refundRequest({ db, now, requestId, fromStatuses: OPEN_STATUSES, toStatus: "ADMIN_CANCELED", reason: note, actorUserId: String(moderatorUserId) })
    if (!r.ok) return r
    await addMessage(db, now, requestId, null, `運営が依頼をキャンセルしました。コインは全額返却されました${note ? `\n理由: ${note}` : ""}`)
    await notifyRequestEvent({ db, env, core, activity, requestId, event: "ADMIN_CANCELED", actorUserId: null })
    return { ok: true }
  }
  if (action === "complete") {
    return completeRequest({ db, env, core, activity, now, request: row, fromStatuses: ["ACCEPTED", "DELIVERED"], toStatus: "ADMIN_COMPLETED", actorUserId: String(moderatorUserId), reason: note })
  }
  if (action === "resolve_report") {
    await db.execute(`UPDATE coin_request_reports SET status = 'RESOLVED' WHERE request_id = $1`, [requestId])
    return { ok: true }
  }
  return { ok: false, code: "UNKNOWN_ACTION" }
}

// ---- 期限（5 分ごとの cron） ----

export const runRequestJob = async ({ db, env, core, activity, now }) => {
  const summary = { expired: 0, overdueCanceled: 0, autoCompleted: 0, reminded: 0, failed: 0 }
  const each = async (rows, fn, key) => {
    for (const row of rows) {
      try {
        const r = await fn(row)
        if (r?.ok) summary[key]++
      } catch (error) {
        summary.failed++
        console.error(JSON.stringify({ event: "coin_requests.job_failed", key, requestId: row.id, message: String(error?.message ?? error) }))
      }
    }
  }
  // 承諾待ちの期限切れ → 全額返却
  const expired = await db.query(`SELECT id FROM coin_requests WHERE status = 'PENDING' AND respond_by <= $1 ORDER BY id LIMIT 50`, [now])
  await each(
    expired,
    async (row) => {
      const r = await refundRequest({ db, now, requestId: row.id, fromStatuses: ["PENDING"], toStatus: "EXPIRED", reason: "no_response" })
      if (r.ok) {
        await addMessage(db, now, row.id, null, "期限までに承諾されなかったため、依頼は取り消されました。コインは全額返却されました")
        await notifyRequestEvent({ db, env, core, activity, requestId: row.id, event: "EXPIRED", actorUserId: null })
      }
      return r
    },
    "expired",
  )
  // 納期を大きく過ぎた制作中 → 自動キャンセル・全額返却
  const overdue = await db.query(`SELECT id FROM coin_requests WHERE status = 'ACCEPTED' AND due_at <= $1 ORDER BY id LIMIT 50`, [now - OVERDUE_GRACE_DAYS * DAY])
  await each(
    overdue,
    async (row) => {
      const r = await refundRequest({ db, now, requestId: row.id, fromStatuses: ["ACCEPTED"], toStatus: "EXPIRED", reason: "overdue" })
      if (r.ok) {
        await addMessage(db, now, row.id, null, "納期を過ぎても納品されなかったため、依頼は自動でキャンセルされました。コインは全額返却されました")
        await notifyRequestEvent({ db, env, core, activity, requestId: row.id, event: "EXPIRED", actorUserId: null })
      }
      return r
    },
    "overdueCanceled",
  )
  // 納品から一定期間 → 自動で確定
  const toComplete = await db.query(`SELECT * FROM coin_requests WHERE status = 'DELIVERED' AND auto_complete_at <= $1 ORDER BY id LIMIT 50`, [now])
  await each(
    toComplete,
    (row) => completeRequest({ db, env, core, activity, now, request: row, fromStatuses: ["DELIVERED"], toStatus: "COMPLETED", actorUserId: null, reason: "auto" }),
    "autoCompleted",
  )
  // 期限が近い（承諾待ちは残り 24 時間、制作中は納期の 24 時間前）→ 1 回だけ知らせる
  const soon = await db.query(
    `SELECT id, status FROM coin_requests
      WHERE reminded_at IS NULL AND ((status = 'PENDING' AND respond_by <= $1) OR (status = 'ACCEPTED' AND due_at <= $1))
      ORDER BY id LIMIT 50`,
    [now + DAY],
  )
  await each(
    soon,
    async (row) => {
      const r = await db.executeResult(`UPDATE coin_requests SET reminded_at = $2 WHERE id = $1 AND reminded_at IS NULL`, [row.id, now])
      if (r.rowCount === 1) await notifyRequestEvent({ db, env, core, activity, requestId: row.id, event: "DEADLINE_SOON", actorUserId: null })
      return { ok: r.rowCount === 1 }
    },
    "reminded",
  )
  // 実績の透かし入りの画像（許可されたのにまだのもの）
  summary.showcase = await runShowcaseJob({ db, env, core, now }).catch(() => 0)
  return summary
}

export { calcSettlement, countShowcase, listShowcase }

// ---- 見本の画像がないプランは、クリエイターの投稿作品のサムネイルを使う ----

/** プランに出す投稿作品のサムネイルの数 */
const PLAN_WORK_IMAGES = 6

/**
 * 見本の画像（sampleImageUrls）が空のプランに workImageUrls（クリエイターの新しい公開中・全年齢の作品のサムネイル）を付ける。
 * sampleImageUrls は変えない（編集画面で保存されないように）。core が読めなければそのまま返す
 */
export const attachPlanWorkImages = async (core, plans) => {
  const userIds = [...new Set(plans.filter((p) => p && p.sampleImageUrls.length === 0).map((p) => p.userId))]
    .filter((id) => /^\d+$/.test(String(id)))
    .slice(0, 60)
  if (!core || userIds.length === 0) return plans
  try {
    const results = await core.batch(
      userIds.map((id) =>
        core
          .prepare(
            `SELECT large_thumbnail_image_url AS url FROM works
              WHERE userId = ?1 AND ageLimit = 0 AND is_deleted = 0 AND adminViewMode = 0 AND viewMode = 0
                AND large_thumbnail_image_url LIKE 'https://%'
              ORDER BY time DESC LIMIT ${PLAN_WORK_IMAGES}`,
          )
          .bind(Number(id)),
      ),
    )
    const byUser = new Map(userIds.map((id, i) => [String(id), (results[i]?.results ?? []).map((r) => r.url)]))
    return plans.map((p) => (p && p.sampleImageUrls.length === 0 ? { ...p, workImageUrls: byUser.get(String(p.userId)) ?? [] } : p))
  } catch (error) {
    console.error(JSON.stringify({ event: "coin_requests.work_images_failed", message: String(error?.message ?? error) }))
    return plans
  }
}

// ---- 表示用のユーザー（名前・ログイン名・アイコン）。core が読めなければ空 ----
export const loadRequestUsers = async (core, ids) => {
  const unique = [...new Set(ids.filter((id) => id !== null && id !== undefined && /^\d+$/.test(String(id))).map(String))].slice(0, 100)
  if (!core || unique.length === 0) return {}
  try {
    const rows =
      (
        await core
          .prepare(
            `SELECT u.ID AS id, u.user_login AS login, p.userName AS name, p.iconUrl AS icon_url
               FROM wp_users u LEFT JOIN user_profiles p ON p.userId = u.ID
              WHERE u.ID IN (${unique.map(() => "?").join(", ")})`,
          )
          .bind(...unique.map(Number))
          .all()
      ).results ?? []
    return Object.fromEntries(rows.map((r) => [String(r.id), { id: String(r.id), login: r.login, name: r.name || r.login || "ユーザー", iconUrl: r.icon_url || null }]))
  } catch (error) {
    console.error(JSON.stringify({ event: "coin_requests.users_failed", message: String(error?.message ?? error) }))
    return {}
  }
}
