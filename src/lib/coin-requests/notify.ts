// @ts-nocheck
// 有料リクエストのお知らせ: サイト内通知（activity D1 の notifications、notifyType 6・commentId = 依頼 ID）と、
// アプリ・ブラウザのプッシュ（FCM HTTP v1。FIREBASE_* が設定されているときだけ）。失敗しても依頼の操作は止めない
import { getNow } from "../db"

export const REQUEST_NOTIFY_TYPE = 6
const JST = 9 * 3600

const shorten = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
const coins = (n) => `${Number(n ?? 0).toLocaleString("ja-JP")}コイン`
const jstDate = (sec) => {
  const d = new Date((Number(sec) + JST) * 1000)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`
}

const userNames = async (core, ids) => {
  const names = new Map()
  if (!core || ids.length === 0) return names
  try {
    const rows =
      (
        await core
          .prepare(`SELECT userId AS id, userName AS name FROM user_profiles WHERE userId IN (${ids.map(() => "?").join(", ")})`)
          .bind(...ids.map(Number))
          .all()
      ).results ?? []
    for (const r of rows) names.set(String(r.id), r.name || "ユーザー")
  } catch {}
  return names
}

/** 誰に何を知らせるか（[userId, 文面] の組） */
export const buildRequestMessages = ({ event, request, names, extra = {} }) => {
  const title = `「${shorten(request.title, 30)}」`
  const creator = names.get(String(request.creator_user_id)) ?? "クリエイター"
  const requester = names.get(String(request.requester_user_id)) ?? "依頼者"
  const toCreator = (m) => [String(request.creator_user_id), m]
  const toRequester = (m) => [String(request.requester_user_id), m]
  switch (event) {
    case "APPLIED":
      return [toCreator(`${requester}さんからリクエスト${title}が届きました（${coins(request.price_coins)}）。${jstDate(request.respond_by)}までに承諾かお断りをしてください`)]
    case "ACCEPTED":
      return [toRequester(`${creator}さんがリクエスト${title}を承諾しました。納期は${jstDate(request.due_at)}です`)]
    case "DECLINED":
      return [toRequester(`${creator}さんがリクエスト${title}をお断りしました。${coins(request.price_coins)}は全額返却されました`)]
    case "CANCELED":
      return [toCreator(`${requester}さんがリクエスト${title}をキャンセルしました`)]
    case "DELIVERED":
      return [toRequester(`${creator}さんからリクエスト${title}の納品が届きました。確認して「受け取り完了」を押してください（${jstDate(request.auto_complete_at)}に自動で完了します）`)]
    case "REVISION":
      return [toCreator(`${requester}さんからリクエスト${title}の修正のお願いが届きました。新しい納期は${jstDate(request.due_at)}です`)]
    case "COMPLETED": {
      const parts = []
      if (Number(request.earned_milliyen ?? 0) > 0) parts.push(`報酬 ${Math.floor(Number(request.earned_milliyen) / 1000).toLocaleString("ja-JP")}円`)
      if (Number(request.settle_premium_coins ?? 0) > 0) parts.push(`プレミアムコイン ${Number(request.settle_premium_coins).toLocaleString("ja-JP")}`)
      if (Number(request.settle_free_coins ?? 0) > 0) parts.push(`無料コイン ${Number(request.settle_free_coins).toLocaleString("ja-JP")}`)
      return [
        toCreator(`リクエスト${title}の取引が完了しました。${parts.length ? `受け取り: ${parts.join("・")}` : ""}`),
        toRequester(`リクエスト${title}の取引が完了しました。ご依頼ありがとうございました`),
      ]
    }
    case "EXPIRED":
      return request.closed_reason === "overdue"
        ? [
            toRequester(`リクエスト${title}は納期を過ぎたため自動でキャンセルされました。${coins(request.price_coins)}は全額返却されました`),
            toCreator(`リクエスト${title}は納期を過ぎたため自動でキャンセルされました`),
          ]
        : [
            toRequester(`リクエスト${title}は期限までに承諾されなかったため取り消されました。${coins(request.price_coins)}は全額返却されました`),
            toCreator(`リクエスト${title}は承諾の期限を過ぎたため取り消されました`),
          ]
    case "ADMIN_CANCELED":
      return [
        toRequester(`リクエスト${title}は運営によりキャンセルされました。${coins(request.price_coins)}は全額返却されました`),
        toCreator(`リクエスト${title}は運営によりキャンセルされました`),
      ]
    case "DEADLINE_SOON":
      return request.status === "PENDING"
        ? [toCreator(`リクエスト${title}の承諾の期限が近づいています（${jstDate(request.respond_by)}まで）`)]
        : [toCreator(`リクエスト${title}の納期が近づいています（${jstDate(request.due_at)}まで）`)]
    case "MESSAGE": {
      const isCreatorSender = String(extra.actorUserId) === String(request.creator_user_id)
      const sender = isCreatorSender ? creator : requester
      const m = `${sender}さんからリクエスト${title}にメッセージ: ${shorten(extra.body, 40)}`
      return [isCreatorSender ? toRequester(m) : toCreator(m)]
    }
    default:
      return []
  }
}

/** 送信を取り消したメッセージのサイト内通知を消す（本文の書き出しが通知に出ているため。プッシュは届いた後なので消せない） */
export const removeMessageNotification = async ({ activity, requestId, body }) => {
  const head = shorten(body, 40)
  if (!activity || !head) return
  const tail = `にメッセージ: ${head}`
  try {
    await activity
      .prepare(`DELETE FROM notifications WHERE notifyType = ?1 AND commentId = ?2 AND substr(comment, -length(?3)) = ?3`)
      .bind(REQUEST_NOTIFY_TYPE, Number(requestId), tail)
      .run()
  } catch (error) {
    console.error(JSON.stringify({ event: "coin_requests.unsend_notify_failed", requestId, message: String(error?.message ?? error) }))
  }
}

export const notifyRequestEvent = async ({ db, env, core, activity, requestId, event, actorUserId = null, extra = {} }) => {
  try {
    const request = await db.queryOne(`SELECT * FROM coin_requests WHERE id = $1`, [requestId])
    if (!request) return
    const names = await userNames(core, [request.creator_user_id, request.requester_user_id])
    const messages = buildRequestMessages({ event, request, names, extra: { ...extra, actorUserId } })
      // 自分の操作は自分に知らせない（運営・自動の処理は両方に）
      .filter(([userId]) => !actorUserId || event === "COMPLETED" || String(userId) !== String(actorUserId))
    if (messages.length === 0) return
    const now = getNow()
    const notifyTime = `${new Date((now + JST) * 1000).toISOString().slice(0, 23)}+00:00`
    if (activity) {
      for (const [userId, message] of messages) {
        if (event === "MESSAGE") {
          // メッセージは同じ依頼で 10 分に 1 回まで知らせる
          const since = `${new Date((now - 600 + JST) * 1000).toISOString().slice(0, 23)}+00:00`
          const recent = await activity
            .prepare(`SELECT 1 AS hit FROM notifications WHERE userId = ?1 AND notifyType = ?2 AND commentId = ?3 AND notifyTime > ?4 AND comment LIKE '%メッセージ%' LIMIT 1`)
            .bind(Number(userId), REQUEST_NOTIFY_TYPE, Number(requestId), since)
            .first()
            .catch(() => null)
          if (recent) continue
        }
        await activity
          .prepare(
            `INSERT INTO notifications (userId, workId, comment, stampId, ownerUserId, notifyInnerCount, notifyType, notifyTime, commentId)
             VALUES (?1, 0, ?2, -1, ?3, 0, ?4, ?5, ?6)`,
          )
          .bind(Number(userId), message, actorUserId ? Number(actorUserId) : -1, REQUEST_NOTIFY_TYPE, notifyTime, Number(requestId))
          .run()
        await sendPush({ env, core, userId, title: "リクエスト", body: message, url: `/requests/${requestId}` })
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "coin_requests.notify_failed", requestId, kind: event, message: String(error?.message ?? error) }))
  }
}

// ---- FCM ----

let cachedToken = null

const b64url = (input) => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input)
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export const getAccessToken = async (env) => {
  const now = Math.floor(Date.now() / 1000)
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.token
  const pem = String(env.FIREBASE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n")
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claims = b64url(
    JSON.stringify({
      iss: env.FIREBASE_CLIENT_EMAIL,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  )
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`))
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${b64url(signature)}` }),
  })
  const json = await response.json().catch(() => null)
  if (!response.ok || !json?.access_token) throw new Error(`fcm token ${response.status}`)
  cachedToken = { token: json.access_token, expiresAt: now + Number(json.expires_in ?? 3600) }
  return cachedToken.token
}

export const sendPush = async ({ env, core, userId, title, body, url }) => {
  if (!env?.FIREBASE_PRIVATE_KEY || !env?.FIREBASE_CLIENT_EMAIL || !env?.FIREBASE_PROJECT_ID || !core) return 0
  if (String(env.COIN_REQUEST_PUSH ?? "1") !== "1") return 0
  try {
    const row = await core.prepare(`SELECT fcm_token, web_fcm_token FROM user_profiles WHERE userId = ?1`).bind(Number(userId)).first()
    const tokens = [row?.fcm_token, row?.web_fcm_token].filter((t) => typeof t === "string" && t.length > 20)
    if (tokens.length === 0) return 0
    const accessToken = await getAccessToken(env)
    let sent = 0
    for (const token of tokens) {
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body: shorten(body, 120) },
            data: { type: "request", url },
            webpush: { fcm_options: { link: `https://www.aipictors.com${url}` } },
            apns: { payload: { aps: { sound: "default" } } },
          },
        }),
      })
      if (response.ok) sent++
    }
    return sent
  } catch (error) {
    console.error(JSON.stringify({ event: "coin_requests.push_failed", message: String(error?.message ?? error) }))
    return 0
  }
}
