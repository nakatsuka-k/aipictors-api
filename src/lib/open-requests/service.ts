// @ts-nocheck
// 募集リクエスト（コンペ型）: 募集・一覧・詳細（募集 → 提案 → コメントの 3 段のツリー）・提案・いいね・コメント・採用・取り下げ・通報・
// 運営の介入・締切の処理（いいね最多の自動採用 / 提案なしは全額返却）・採用された人の実績
import { ADULT_AGE_LIMITS, getCreatorPayoutConfig } from "../creator-payouts/config"
import { cleanImageUrls, getRequestConfig, parseJsonArray } from "../coin-requests/config"
import { loadRequestUsers } from "../coin-requests/service"
import {
  AWARDED_STATUSES,
  DAY,
  DEADLINE_DEFAULT_DAYS,
  DEADLINE_MAX_DAYS,
  DEADLINE_MIN_DAYS,
  MAX_BODY_LENGTH,
  MAX_COMMENT_LENGTH,
  MAX_COMMENTS_PER_PROPOSAL,
  MAX_PROPOSAL_IMAGES,
  MAX_PROPOSAL_MESSAGE_LENGTH,
  MAX_REFERENCE_IMAGES,
  MAX_TITLE_LENGTH,
  OPEN_REQUEST_MAX_COINS,
  OPEN_REQUEST_MIN_COINS,
  PROPOSALS_PER_USER,
  getOpenRequestConfig,
} from "./config"
import { awardOpenRequest, createEscrowedOpenRequest, getPaidPremiumBalance, refundOpenRequest } from "./escrow"
import { notifyOpenRequestEvent } from "./notify"

const clampInt = (value, min, max, fallback) => {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
const text = (value, max) => String(value ?? "").trim().slice(0, max)
const inList = (values) => values.map((v) => `'${v}'`).join(", ")
const fail = (code) => ({ ok: false, code })

export { loadRequestUsers }

// ---- 表示用の形 ----

const toOpenRequest = (row, viewerUserId = null) => ({
  id: String(row.id),
  requesterUserId: String(row.requester_user_id),
  isMine: viewerUserId !== null && String(row.requester_user_id) === String(viewerUserId),
  title: row.title,
  body: row.body,
  referenceImageUrls: parseJsonArray(row.reference_image_urls),
  isR18: Number(row.is_r18) === 1,
  rewardCoins: Number(row.reward_coins),
  status: row.status,
  deadlineAt: Number(row.deadline_at),
  showcaseAllowed: Number(row.showcase_allowed) === 1,
  awardedProposalId: row.awarded_proposal_id ? String(row.awarded_proposal_id) : null,
  awardedUserId: row.awarded_user_id ? String(row.awarded_user_id) : null,
  awardedAt: row.awarded_at ? Number(row.awarded_at) : null,
  proposalCount: Number(row.proposal_count ?? 0),
  isHidden: Number(row.is_hidden ?? 0) === 1,
  closedAt: row.closed_at ? Number(row.closed_at) : null,
  closedReason: row.closed_reason ?? null,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

const toProposal = (row, likedIds = new Set()) => ({
  id: String(row.id),
  requestId: String(row.request_id),
  userId: String(row.user_id),
  imageUrls: parseJsonArray(row.image_urls),
  workId: row.work_id ?? null,
  message: row.message ?? "",
  status: row.status,
  likeCount: Number(row.like_count ?? 0),
  commentCount: Number(row.comment_count ?? 0),
  isAwarded: Number(row.is_awarded ?? 0) === 1,
  isLikedByMe: likedIds.has(String(row.id)),
  createdAt: Number(row.created_at),
})

const toComment = (row) => ({
  id: String(row.id),
  proposalId: String(row.proposal_id),
  userId: String(row.user_id),
  body: row.body,
  createdAt: Number(row.created_at),
})

// ---- 一覧 ----

const SORTS = {
  new: "r.id DESC",
  deadline: "r.deadline_at ASC, r.id DESC",
  reward: "r.reward_coins DESC, r.id DESC",
  proposals: "r.proposal_count DESC, r.id DESC",
}
const STATUS_GROUPS = {
  open: ["OPEN"],
  done: AWARDED_STATUSES,
}

/**
 * 募集の一覧。r18: true = R18 だけ（画面は年齢の確認のあとに読む）、それ以外 = 全年齢だけ。
 * requesterUserId = その人が出した募集、proposerUserId = その人が提案した募集（どちらも終わったものを含む）
 */
export const listOpenRequests = async ({ db, status = "open", sort = "new", r18 = false, requesterUserId = null, proposerUserId = null, viewerUserId = null, limit = 30, offset = 0 }) => {
  const where = []
  const params = []
  const add = (sql, value) => {
    params.push(value)
    where.push(sql.replaceAll("?", `$${params.length}`))
  }
  if (requesterUserId) add("r.requester_user_id = ?", String(requesterUserId))
  else if (proposerUserId) add("r.id IN (SELECT request_id FROM open_request_proposals WHERE user_id = ? AND status <> 'WITHDRAWN')", String(proposerUserId))
  else {
    // みんなの一覧: 運営が隠したもの・返却で終わったものは出さない
    where.push("r.is_hidden = 0")
    where.push(`r.status IN (${inList(STATUS_GROUPS[status] ?? [...STATUS_GROUPS.open, ...STATUS_GROUPS.done])})`)
    where.push(r18 ? "r.is_r18 = 1" : "r.is_r18 = 0")
  }
  params.push(clampInt(limit, 1, 60, 30), clampInt(offset, 0, 10000, 0))
  const rows = await db.query(
    `SELECT r.* FROM open_requests r ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${requesterUserId || proposerUserId ? "CASE WHEN r.status = 'OPEN' THEN 0 ELSE 1 END, r.id DESC" : (SORTS[sort] ?? SORTS.new)}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  const ids = rows.map((r) => Number(r.id))
  // 一覧に出す見本: 採用された提案、なければいいねの多い提案から 3 件
  const previews = new Map()
  if (ids.length > 0) {
    const list = await db.query(
      `SELECT request_id, image_urls FROM open_request_proposals
        WHERE request_id IN (SELECT value FROM json_each($1)) AND status = 'ACTIVE'
        ORDER BY is_awarded DESC, like_count DESC, id ASC LIMIT 600`,
      [JSON.stringify(ids)],
    )
    for (const p of list) {
      const key = String(p.request_id)
      const urls = previews.get(key) ?? []
      if (urls.length < 3) {
        const first = parseJsonArray(p.image_urls)[0]
        if (first) urls.push(first)
      }
      previews.set(key, urls)
    }
  }
  return rows.map((row) => ({ ...toOpenRequest(row, viewerUserId), previewImageUrls: previews.get(String(row.id)) ?? [] }))
}

// ---- 詳細（ツリー） ----

export const getOpenRequest = async ({ db, requestId, viewerUserId = null, isModerator = false }) => {
  const row = await db.queryOne(`SELECT * FROM open_requests WHERE id = $1`, [requestId])
  if (!row) return null
  const isRequester = viewerUserId !== null && String(row.requester_user_id) === String(viewerUserId)
  if (Number(row.is_hidden) === 1 && !isRequester && !isModerator) return null
  const proposals = await db.query(
    `SELECT * FROM open_request_proposals WHERE request_id = $1 AND (status = 'ACTIVE' ${isModerator ? "OR status = 'HIDDEN'" : ""})
      ORDER BY is_awarded DESC, like_count DESC, id ASC LIMIT 300`,
    [requestId],
  )
  const comments = await db.query(
    `SELECT id, proposal_id, user_id, body, created_at FROM open_request_comments WHERE request_id = $1 AND status = 'ACTIVE' ORDER BY id ASC LIMIT 2000`,
    [requestId],
  )
  const liked = viewerUserId
    ? await db.query(
        `SELECT l.proposal_id FROM open_request_proposal_likes l JOIN open_request_proposals p ON p.id = l.proposal_id WHERE p.request_id = $1 AND l.user_id = $2`,
        [requestId, String(viewerUserId)],
      )
    : []
  const likedIds = new Set(liked.map((l) => String(l.proposal_id)))
  const byProposal = new Map()
  for (const c of comments) {
    const key = String(c.proposal_id)
    byProposal.set(key, [...(byProposal.get(key) ?? []), toComment(c)])
  }
  return {
    ...toOpenRequest(row, viewerUserId),
    reportCount: isModerator ? Number(row.report_count ?? 0) : undefined,
    // 預かりの内訳は依頼者と運営にだけ
    settlement:
      (isRequester || isModerator) && row.fee_coins !== null
        ? { feeCoins: Number(row.fee_coins), earnedCoins: Number(row.earned_coins ?? 0), premiumCoins: Number(row.settle_premium_coins ?? 0) }
        : null,
    proposals: proposals.map((p) => ({ ...toProposal(p, likedIds), comments: byProposal.get(String(p.id)) ?? [] })),
    myProposalCount: viewerUserId ? proposals.filter((p) => String(p.user_id) === String(viewerUserId)).length : 0,
  }
}

// ---- 募集 ----

const isBlocked = async (core, a, b) => {
  if (!core) return false
  const hit = await core
    .prepare(`SELECT 1 AS hit FROM blocked_users WHERE is_canceled = 0 AND ((user_id = ?1 AND blocked_user_id = ?2) OR (user_id = ?2 AND blocked_user_id = ?1)) LIMIT 1`)
    .bind(Number(a), Number(b))
    .first()
    .catch(() => null)
  return Boolean(hit)
}

export const createOpenRequest = async ({ db, env, now, input }) => {
  if (!getOpenRequestConfig(env).enabled) return fail("DISABLED")
  const requesterUserId = String(input.requesterUserId)
  const title = text(input.title, MAX_TITLE_LENGTH)
  const body = text(input.body, MAX_BODY_LENGTH)
  const clientKey = text(input.clientKey, 64)
  if (!title) return fail("TITLE_REQUIRED")
  if (!body) return fail("BODY_REQUIRED")
  if (!clientKey) return fail("CLIENT_KEY_REQUIRED")
  const rewardCoins = Math.floor(Number(input.rewardCoins))
  if (!Number.isFinite(rewardCoins) || rewardCoins < OPEN_REQUEST_MIN_COINS || rewardCoins > OPEN_REQUEST_MAX_COINS) return fail("INVALID_REWARD")
  const days = clampInt(input.deadlineDays, DEADLINE_MIN_DAYS, DEADLINE_MAX_DAYS, DEADLINE_DEFAULT_DAYS)
  const result = await createEscrowedOpenRequest({
    db,
    now,
    input: {
      requesterUserId,
      clientKey,
      title,
      body,
      referenceImageUrls: cleanImageUrls(input.referenceImageUrls, MAX_REFERENCE_IMAGES),
      isR18: input.isR18 === true,
      rewardCoins,
      deadlineAt: now + days * DAY,
      showcaseAllowed: input.showcaseAllowed === true,
    },
  })
  return result.ok ? { ok: true, requestId: String(result.requestId) } : result
}

// ---- 提案 ----

/** 作品で提案するとき: 提案者の公開中の作品で、全年齢の募集には全年齢の作品だけ。サムネイルを画像にする */
const loadProposalWork = async (core, workId, userId, isR18) => {
  if (!core) return null
  const work = await core
    .prepare(`SELECT id, userId AS user_id, ageLimit AS age_limit, large_thumbnail_image_url AS url FROM works WHERE id = ?1 AND is_deleted = 0 AND adminViewMode = 0 AND viewMode IN (0, 1)`)
    .bind(Number(workId))
    .first()
    .catch(() => null)
  if (!work || String(work.user_id) !== String(userId)) return null
  if (!isR18 && ADULT_AGE_LIMITS.includes(Number(work.age_limit))) return { r18Mismatch: true }
  return work
}

export const createProposal = async ({ db, env, core, activity, now, requestId, userId, input }) => {
  const uid = String(userId)
  const request = await db.queryOne(`SELECT * FROM open_requests WHERE id = $1`, [requestId])
  if (!request || Number(request.is_hidden) === 1) return fail("NOT_FOUND")
  if (request.status !== "OPEN" || Number(request.deadline_at) <= now) return fail("CLOSED")
  if (String(request.requester_user_id) === uid) return fail("SELF_PROPOSAL")
  if (await isBlocked(core, uid, request.requester_user_id)) return fail("BLOCKED")
  let imageUrls = cleanImageUrls(input.imageUrls, MAX_PROPOSAL_IMAGES)
  let workId = null
  if (input.workId && /^\d+$/.test(String(input.workId))) {
    const work = await loadProposalWork(core, input.workId, uid, Number(request.is_r18) === 1)
    if (!work) return fail("WORK_NOT_FOUND")
    if (work.r18Mismatch) return fail("R18_NOT_ALLOWED")
    workId = String(work.id)
    if (work.url && imageUrls.length === 0) imageUrls = [work.url]
  }
  if (imageUrls.length === 0) return fail("IMAGE_REQUIRED")
  const message = text(input.message, MAX_PROPOSAL_MESSAGE_LENGTH)
  // 1 人 3 件まで・募集中・締切前を、入れる文の条件で確かめる（同時に送っても超えない）
  const result = await db.executeResult(
    `INSERT INTO open_request_proposals(request_id, user_id, image_urls, work_id, message, created_at, updated_at)
     SELECT $1, $2, $3, $4, $5, $6, $6
      WHERE EXISTS (SELECT 1 FROM open_requests WHERE id = $1 AND status = 'OPEN' AND deadline_at > $6 AND requester_user_id <> $2)
        AND (SELECT COUNT(*) FROM open_request_proposals WHERE request_id = $1 AND user_id = $2 AND status <> 'WITHDRAWN') < ${PROPOSALS_PER_USER}`,
    [Number(requestId), uid, JSON.stringify(imageUrls), workId, message, now],
  )
  if (result.rowCount !== 1) return fail("TOO_MANY_PROPOSALS")
  await recountProposals(db, requestId, now)
  await notifyOpenRequestEvent({ db, env, core, activity, requestId, proposalId: result.lastRowId, event: "PROPOSED", actorUserId: uid })
  return { ok: true, proposalId: String(result.lastRowId) }
}

const recountProposals = (db, requestId, now) =>
  db.execute(
    `UPDATE open_requests SET proposal_count = (SELECT COUNT(*) FROM open_request_proposals WHERE request_id = $1 AND status = 'ACTIVE'), updated_at = $2 WHERE id = $1`,
    [Number(requestId), now],
  )

/**
 * 提案への操作。action:
 * - withdraw（提案者: 募集中で採用されていないとき）
 * - like / unlike（提案者以外: 募集中のとき。締切の自動採用に使う）
 * - comment（ログインしている人）/ delete-comment（コメントした人）
 * - report
 */
export const actOnProposal = async ({ db, env, core, activity, now, proposalId, userId, action, input = {} }) => {
  const uid = String(userId)
  const proposal = await db.queryOne(`SELECT * FROM open_request_proposals WHERE id = $1`, [proposalId])
  if (!proposal || proposal.status !== "ACTIVE") return fail("NOT_FOUND")
  const request = await db.queryOne(`SELECT * FROM open_requests WHERE id = $1`, [proposal.request_id])
  if (!request || (Number(request.is_hidden) === 1 && String(request.requester_user_id) !== uid)) return fail("NOT_FOUND")
  const isOpen = request.status === "OPEN"
  switch (action) {
    case "withdraw": {
      if (String(proposal.user_id) !== uid) return fail("FORBIDDEN")
      if (!isOpen) return fail("CLOSED")
      const r = await db.executeResult(
        `UPDATE open_request_proposals SET status = 'WITHDRAWN', updated_at = $2 WHERE id = $1 AND status = 'ACTIVE' AND is_awarded = 0
           AND EXISTS (SELECT 1 FROM open_requests WHERE id = open_request_proposals.request_id AND status = 'OPEN')`,
        [proposalId, now],
      )
      if (r.rowCount !== 1) return fail("INVALID_STATE")
      await recountProposals(db, proposal.request_id, now)
      return { ok: true }
    }
    case "like":
    case "unlike": {
      if (String(proposal.user_id) === uid) return fail("SELF_LIKE")
      if (!isOpen) return fail("CLOSED")
      const r =
        action === "like"
          ? await db.executeResult(`INSERT INTO open_request_proposal_likes(proposal_id, user_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [proposalId, uid, now])
          : await db.executeResult(`DELETE FROM open_request_proposal_likes WHERE proposal_id = $1 AND user_id = $2`, [proposalId, uid])
      if (r.rowCount === 1) {
        await db.execute(`UPDATE open_request_proposals SET like_count = (SELECT COUNT(*) FROM open_request_proposal_likes WHERE proposal_id = $1) WHERE id = $1`, [proposalId])
      }
      const row = await db.queryOne(`SELECT like_count FROM open_request_proposals WHERE id = $1`, [proposalId])
      return { ok: true, likeCount: Number(row?.like_count ?? 0), isLiked: action === "like" }
    }
    case "comment": {
      const body = text(input.body, MAX_COMMENT_LENGTH)
      if (!body) return fail("BODY_REQUIRED")
      if (await isBlocked(core, uid, proposal.user_id)) return fail("BLOCKED")
      const r = await db.executeResult(
        `INSERT INTO open_request_comments(request_id, proposal_id, user_id, body, created_at)
         SELECT $1, $2, $3, $4, $5 WHERE (SELECT COUNT(*) FROM open_request_comments WHERE proposal_id = $2 AND status = 'ACTIVE') < ${MAX_COMMENTS_PER_PROPOSAL}`,
        [Number(proposal.request_id), Number(proposalId), uid, body, now],
      )
      if (r.rowCount !== 1) return fail("TOO_MANY_COMMENTS")
      await db.execute(`UPDATE open_request_proposals SET comment_count = comment_count + 1 WHERE id = $1`, [proposalId])
      await notifyOpenRequestEvent({ db, env, core, activity, requestId: proposal.request_id, proposalId, event: "COMMENTED", actorUserId: uid, extra: { body } })
      return { ok: true, commentId: String(r.lastRowId) }
    }
    case "delete-comment": {
      const r = await db.executeResult(
        `UPDATE open_request_comments SET status = 'DELETED' WHERE id = $1 AND proposal_id = $2 AND user_id = $3 AND status = 'ACTIVE'`,
        [Number(input.commentId), Number(proposalId), uid],
      )
      if (r.rowCount !== 1) return fail("NOT_FOUND")
      await db.execute(`UPDATE open_request_proposals SET comment_count = max(comment_count - 1, 0) WHERE id = $1`, [proposalId])
      return { ok: true }
    }
    case "report": {
      const reason = text(input.reason, 1000)
      if (!reason) return fail("REASON_REQUIRED")
      await db.execute(`INSERT INTO open_request_reports(request_id, proposal_id, reporter_user_id, reason, created_at) VALUES ($1, $2, $3, $4, $5)`, [
        Number(proposal.request_id),
        Number(proposalId),
        uid,
        reason,
        now,
      ])
      await db.execute(`UPDATE open_request_proposals SET report_count = report_count + 1 WHERE id = $1`, [proposalId])
      return { ok: true }
    }
    default:
      return fail("UNKNOWN_ACTION")
  }
}

// ---- 採用 ----

/** 報酬（現金）にするか: 報酬が有効・採用された人が参加中・全年齢の募集 */
const isEarningsEligible = async ({ db, env, request, userId }) => {
  if (Number(request.is_r18) === 1) return false
  if (!getCreatorPayoutConfig(env).enabled) return false
  const profile = await db.queryOne(`SELECT status FROM creator_payout_profiles WHERE user_id = $1`, [String(userId)])
  return profile?.status === "JOINED"
}

const award = async ({ db, env, core, activity, now, request, proposal, toStatus, actorUserId, reason = null }) => {
  const result = await awardOpenRequest({
    db,
    now,
    request,
    proposal,
    toStatus,
    feePpm: getRequestConfig(env).feePpm,
    eligible: await isEarningsEligible({ db, env, request, userId: proposal.user_id }),
    actorUserId,
    reason,
  })
  if (result.ok) await notifyOpenRequestEvent({ db, env, core, activity, requestId: request.id, proposalId: proposal.id, event: "AWARDED", actorUserId })
  return result
}

/**
 * 募集への依頼者の操作。action:
 * - award（採用。input.proposalId。募集中のとき。締切を過ぎていても自動の処理の前なら選べる）
 * - cancel（取り下げ。提案がまだないときだけ。全額返却）
 * - showcase（採用された作品を採用された人の実績に出してよいか。input.allowed）
 * - report（依頼者以外）
 */
export const actOnOpenRequest = async ({ db, env, core, activity, now, requestId, userId, action, input = {} }) => {
  const uid = String(userId)
  const request = await db.queryOne(`SELECT * FROM open_requests WHERE id = $1`, [requestId])
  if (!request) return fail("NOT_FOUND")
  const isRequester = String(request.requester_user_id) === uid
  if (Number(request.is_hidden) === 1 && !isRequester) return fail("NOT_FOUND")
  switch (action) {
    case "award": {
      if (!isRequester) return fail("FORBIDDEN")
      const proposal = await db.queryOne(`SELECT * FROM open_request_proposals WHERE id = $1 AND request_id = $2 AND status = 'ACTIVE'`, [Number(input.proposalId), Number(requestId)])
      if (!proposal) return fail("PROPOSAL_NOT_FOUND")
      const r = await award({ db, env, core, activity, now, request, proposal, toStatus: "AWARDED", actorUserId: uid })
      return r.ok ? { ok: true } : r
    }
    case "cancel": {
      if (!isRequester) return fail("FORBIDDEN")
      const r = await refundOpenRequest({
        db,
        now,
        requestId,
        toStatus: "CANCELED",
        reason: "requester",
        actorUserId: uid,
        where: "NOT EXISTS (SELECT 1 FROM open_request_proposals p WHERE p.request_id = open_requests.id AND p.status = 'ACTIVE')",
      })
      if (!r.ok) return fail(request.status === "OPEN" ? "HAS_PROPOSALS" : "INVALID_STATE")
      return { ok: true }
    }
    case "showcase": {
      if (!isRequester) return fail("FORBIDDEN")
      await db.execute(`UPDATE open_requests SET showcase_allowed = $2, updated_at = $3 WHERE id = $1`, [requestId, input.allowed === true ? 1 : 0, now])
      return { ok: true }
    }
    case "report": {
      if (isRequester) return fail("FORBIDDEN")
      const reason = text(input.reason, 1000)
      if (!reason) return fail("REASON_REQUIRED")
      await db.execute(`INSERT INTO open_request_reports(request_id, reporter_user_id, reason, created_at) VALUES ($1, $2, $3, $4)`, [Number(requestId), uid, reason, now])
      await db.execute(`UPDATE open_requests SET report_count = report_count + 1 WHERE id = $1`, [requestId])
      return { ok: true }
    }
    default:
      return fail("UNKNOWN_ACTION")
  }
}

/** 募集に使える残高（購入したプレミアムコイン）と、出している募集の数 */
export const getOpenRequestAccount = async ({ db, userId, now }) => {
  const open = await db.queryOne(`SELECT COUNT(*) AS n FROM open_requests WHERE requester_user_id = $1 AND status = 'OPEN'`, [String(userId)])
  return { paidPremiumBalance: await getPaidPremiumBalance({ db, userId, now }), openCount: Number(open?.n ?? 0) }
}

// ---- 実績（採用された人のページ） ----

/** 採用された作品のうち、依頼者が公開を許可したもの（r18: true = R18 だけ） */
export const listOpenRequestShowcase = async ({ db, userId, r18 = false, limit = 24, offset = 0 }) => {
  const rows = await db.query(
    `SELECT r.id, r.title, r.reward_coins, r.awarded_at, r.is_r18, p.id AS proposal_id, p.image_urls, p.work_id
       FROM open_requests r JOIN open_request_proposals p ON p.id = r.awarded_proposal_id
      WHERE r.awarded_user_id = $1 AND r.status IN (${inList(AWARDED_STATUSES)}) AND r.showcase_allowed = 1 AND r.is_hidden = 0 AND p.status = 'ACTIVE'
        AND r.is_r18 = $2
      ORDER BY r.awarded_at DESC LIMIT $3 OFFSET $4`,
    [String(userId), r18 ? 1 : 0, clampInt(limit, 1, 60, 24), clampInt(offset, 0, 10000, 0)],
  )
  const counts = await db.queryOne(
    `SELECT COALESCE(SUM(CASE WHEN is_r18 = 1 THEN 0 ELSE 1 END), 0) AS g, COALESCE(SUM(is_r18), 0) AS r18, COUNT(*) AS awarded
       FROM open_requests WHERE awarded_user_id = $1 AND status IN (${inList(AWARDED_STATUSES)}) AND is_hidden = 0`,
    [String(userId)],
  )
  return {
    items: rows.map((r) => ({
      requestId: String(r.id),
      title: r.title,
      rewardCoins: Number(r.reward_coins),
      awardedAt: Number(r.awarded_at),
      isR18: Number(r.is_r18) === 1,
      proposalId: String(r.proposal_id),
      imageUrls: parseJsonArray(r.image_urls),
      workId: r.work_id ?? null,
    })),
    // awardedCount は公開の許可に関係なく採用された回数
    counts: { awarded: Number(counts?.awarded ?? 0) },
  }
}

// ---- 運営 ----

export const listOpenRequestsForAdmin = async ({ db, status = null, reportedOnly = false, limit = 100 }) => {
  const where = []
  if (status === "open") where.push("r.status = 'OPEN'")
  if (status === "done") where.push(`r.status IN (${inList(AWARDED_STATUSES)})`)
  if (reportedOnly) where.push("(r.report_count > 0 OR EXISTS (SELECT 1 FROM open_request_proposals p WHERE p.request_id = r.id AND p.report_count > 0))")
  const rows = await db.query(`SELECT r.* FROM open_requests r ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.updated_at DESC LIMIT $1`, [
    clampInt(limit, 1, 300, 100),
  ])
  const reports = await db.query(`SELECT * FROM open_request_reports ORDER BY id DESC LIMIT 100`)
  const totals = await db.queryOne(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'OPEN' THEN premium_spent ELSE 0 END) AS escrow_coins,
            SUM(CASE WHEN status IN (${inList(AWARDED_STATUSES)}) THEN fee_coins ELSE 0 END) AS fee_coins
       FROM open_requests`,
  )
  return {
    requests: rows.map((r) => ({ ...toOpenRequest(r), reportCount: Number(r.report_count ?? 0) })),
    reports: reports.map((r) => ({ ...r, id: String(r.id) })),
    totals: { count: Number(totals?.n ?? 0), escrowCoins: Number(totals?.escrow_coins ?? 0), feeCoins: Number(totals?.fee_coins ?? 0) },
  }
}

/** 運営: cancel（募集中なら全額返却）/ hide / unhide（募集）/ hide-proposal / delete-comment / resolve_report */
export const adminActOnOpenRequest = async ({ db, env, core, activity, now, requestId, moderatorUserId, action, input = {} }) => {
  const request = await db.queryOne(`SELECT * FROM open_requests WHERE id = $1`, [requestId])
  if (!request) return fail("NOT_FOUND")
  const note = text(input.reason, 500) || null
  switch (action) {
    case "cancel": {
      const r = await refundOpenRequest({ db, now, requestId, toStatus: "ADMIN_CANCELED", reason: note, actorUserId: String(moderatorUserId) })
      if (!r.ok) return r
      await notifyOpenRequestEvent({ db, env, core, activity, requestId, event: "ADMIN_CANCELED", actorUserId: null })
      return { ok: true }
    }
    case "hide":
    case "unhide":
      await db.execute(`UPDATE open_requests SET is_hidden = $2, updated_at = $3 WHERE id = $1`, [requestId, action === "hide" ? 1 : 0, now])
      return { ok: true }
    case "hide-proposal": {
      // 採用済みの提案は隠せない（コインはもう渡っている）
      const r = await db.executeResult(`UPDATE open_request_proposals SET status = 'HIDDEN', updated_at = $3 WHERE id = $1 AND request_id = $2 AND is_awarded = 0`, [
        Number(input.proposalId),
        Number(requestId),
        now,
      ])
      if (r.rowCount !== 1) return fail("INVALID_STATE")
      await recountProposals(db, requestId, now)
      return { ok: true }
    }
    case "delete-comment": {
      const r = await db.executeResult(`UPDATE open_request_comments SET status = 'DELETED' WHERE id = $1 AND request_id = $2 AND status = 'ACTIVE'`, [
        Number(input.commentId),
        Number(requestId),
      ])
      if (r.rowCount === 1) {
        await db.execute(
          `UPDATE open_request_proposals SET comment_count = max(comment_count - 1, 0) WHERE id = (SELECT proposal_id FROM open_request_comments WHERE id = $1)`,
          [Number(input.commentId)],
        )
      }
      return { ok: true }
    }
    case "resolve_report":
      await db.execute(`UPDATE open_request_reports SET status = 'RESOLVED' WHERE request_id = $1`, [requestId])
      return { ok: true }
    default:
      return fail("UNKNOWN_ACTION")
  }
}

// ---- 締切（5 分ごとの cron） ----

export const runOpenRequestJob = async ({ db, env, core, activity, now }) => {
  const summary = { autoAwarded: 0, expired: 0, reminded: 0, failed: 0 }
  const due = await db.query(`SELECT * FROM open_requests WHERE status = 'OPEN' AND deadline_at <= $1 ORDER BY deadline_at LIMIT 50`, [now])
  for (const request of due) {
    try {
      // いいねが一番多い提案（同じなら先に出したもの）を自動で採用。提案がなければ全額返却
      const top = await db.queryOne(
        `SELECT * FROM open_request_proposals WHERE request_id = $1 AND status = 'ACTIVE' AND user_id <> $2 ORDER BY like_count DESC, id ASC LIMIT 1`,
        [Number(request.id), String(request.requester_user_id)],
      )
      if (top) {
        const r = await award({ db, env, core, activity, now, request, proposal: top, toStatus: "AUTO_AWARDED", actorUserId: null, reason: "auto" })
        if (r.ok) summary.autoAwarded++
      } else {
        const r = await refundOpenRequest({ db, now, requestId: request.id, toStatus: "EXPIRED", reason: "no_proposals" })
        if (r.ok) {
          summary.expired++
          await notifyOpenRequestEvent({ db, env, core, activity, requestId: request.id, event: "EXPIRED", actorUserId: null })
        }
      }
    } catch (error) {
      summary.failed++
      console.error(JSON.stringify({ event: "open_requests.job_failed", requestId: request.id, message: String(error?.message ?? error) }))
    }
  }
  // 締切の 24 時間前に、提案があれば依頼者に 1 回だけ知らせる
  const soon = await db.query(
    `SELECT id FROM open_requests WHERE status = 'OPEN' AND reminded_at IS NULL AND deadline_at <= $1 AND deadline_at > $2 AND proposal_count > 0 ORDER BY id LIMIT 50`,
    [now + DAY, now],
  )
  for (const row of soon) {
    const r = await db.executeResult(`UPDATE open_requests SET reminded_at = $2 WHERE id = $1 AND reminded_at IS NULL`, [row.id, now])
    if (r.rowCount === 1) {
      summary.reminded++
      await notifyOpenRequestEvent({ db, env, core, activity, requestId: row.id, event: "DEADLINE_SOON", actorUserId: null })
    }
  }
  return summary
}
