// @ts-nocheck
// 募集リクエストのお知らせ。有料リクエストと同じサイト内通知（notifyType 6）を使い、commentId は「募集の ID のマイナス」にする
// （有料リクエストの ID とぶつからない。フロントはマイナスなら /requests/open/:id へ飛ばす）。プッシュも同じ仕組み。失敗しても操作は止めない
import { getNow } from "../db"
import { REQUEST_NOTIFY_TYPE, sendPush } from "../coin-requests/notify"

const JST = 9 * 3600

const shorten = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
const num = (n) => Number(n ?? 0).toLocaleString("ja-JP")
const jstDate = (sec) => {
  const d = new Date((Number(sec) + JST) * 1000)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`
}

const userNames = async (core, ids) => {
  const names = new Map()
  const unique = [...new Set(ids.filter(Boolean).map(String))]
  if (!core || unique.length === 0) return names
  try {
    const rows =
      (
        await core
          .prepare(`SELECT userId AS id, userName AS name FROM user_profiles WHERE userId IN (${unique.map(() => "?").join(", ")})`)
          .bind(...unique.map(Number))
          .all()
      ).results ?? []
    for (const r of rows) names.set(String(r.id), r.name || "ユーザー")
  } catch {}
  return names
}

/** 誰に何を知らせるか（[userId, 文面] の組） */
export const buildOpenRequestMessages = ({ event, request, proposal = null, names, extra = {} }) => {
  const title = `「${shorten(request.title, 30)}」`
  const actor = names.get(String(extra.actorUserId)) ?? "ユーザー"
  const toRequester = (m) => [String(request.requester_user_id), m]
  switch (event) {
    case "PROPOSED":
      return [toRequester(`${actor}さんが募集リクエスト${title}に提案しました`)]
    case "COMMENTED": {
      const m = `${actor}さんが募集リクエスト${title}の提案にコメント: ${shorten(extra.body, 40)}`
      return [toRequester(m), ...(proposal ? [[String(proposal.user_id), m]] : [])]
    }
    case "AWARDED": {
      if (!proposal) return []
      const parts = []
      if (Number(request.earned_milliyen ?? 0) > 0) parts.push(`報酬 ${num(Math.floor(Number(request.earned_milliyen) / 1000))}円`)
      if (Number(request.settle_premium_coins ?? 0) > 0) parts.push(`プレミアムコイン ${num(request.settle_premium_coins)}`)
      const auto = request.status === "AUTO_AWARDED"
      return [
        [String(proposal.user_id), `🏆 あなたの提案が募集リクエスト${title}に${auto ? "（いいねが一番多かったため）" : ""}採用されました。${parts.length ? `受け取り: ${parts.join("・")}` : ""}`],
        ...(auto ? [toRequester(`募集リクエスト${title}は締切までに採用がなかったため、いいねが一番多い提案を自動で採用しました`)] : []),
      ]
    }
    case "EXPIRED":
      return [toRequester(`募集リクエスト${title}は締切までに提案がなかったため終了しました。プレミアムコイン ${num(request.reward_coins)}は全額返却されました`)]
    case "ADMIN_CANCELED":
      return [toRequester(`募集リクエスト${title}は運営によりキャンセルされました。プレミアムコイン ${num(request.reward_coins)}は全額返却されました`)]
    case "DEADLINE_SOON":
      return [toRequester(`募集リクエスト${title}の締切が近づいています（${jstDate(request.deadline_at)}まで）。採用しないと、いいねが一番多い提案が自動で採用されます`)]
    default:
      return []
  }
}

export const notifyOpenRequestEvent = async ({ db, env, core, activity, requestId, proposalId = null, event, actorUserId = null, extra = {} }) => {
  try {
    const request = await db.queryOne(`SELECT * FROM open_requests WHERE id = $1`, [requestId])
    if (!request) return
    const pid = proposalId ?? request.awarded_proposal_id
    const proposal = pid ? await db.queryOne(`SELECT id, user_id FROM open_request_proposals WHERE id = $1`, [pid]) : null
    const names = await userNames(core, [actorUserId, request.requester_user_id])
    const seen = new Set()
    const messages = buildOpenRequestMessages({ event, request, proposal, names, extra: { ...extra, actorUserId } })
      // 自分の操作は自分に知らせない・同じ人に 2 回送らない
      .filter(([userId]) => (!actorUserId || String(userId) !== String(actorUserId)) && !seen.has(userId) && seen.add(userId))
    if (messages.length === 0 || !activity) return
    const now = getNow()
    const toTime = (sec) => `${new Date((sec + JST) * 1000).toISOString().slice(0, 23)}+00:00`
    for (const [userId, message] of messages) {
      if (event === "COMMENTED" || event === "PROPOSED") {
        // コメント・提案は同じ募集で 10 分に 1 回まで知らせる
        const recent = await activity
          .prepare(`SELECT 1 AS hit FROM notifications WHERE userId = ?1 AND notifyType = ?2 AND commentId = ?3 AND notifyTime > ?4 LIMIT 1`)
          .bind(Number(userId), REQUEST_NOTIFY_TYPE, -Number(requestId), toTime(now - 600))
          .first()
          .catch(() => null)
        if (recent) continue
      }
      await activity
        .prepare(
          `INSERT INTO notifications (userId, workId, comment, stampId, ownerUserId, notifyInnerCount, notifyType, notifyTime, commentId)
           VALUES (?1, 0, ?2, -1, ?3, 0, ?4, ?5, ?6)`,
        )
        .bind(Number(userId), message, actorUserId ? Number(actorUserId) : -1, REQUEST_NOTIFY_TYPE, toTime(now), -Number(requestId))
        .run()
      await sendPush({ env, core, userId, title: "募集リクエスト", body: message, url: `/requests/open/${requestId}` })
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "open_requests.notify_failed", requestId, kind: event, message: String(error?.message ?? error) }))
  }
}
