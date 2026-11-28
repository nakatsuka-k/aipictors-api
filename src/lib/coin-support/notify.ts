// @ts-nocheck
// ユーザーへの推し（プロフィール・作品ページの「作者を推す」・アプリのユーザーの推し）を受け取った人へのお知らせ。
// 作品への推しを終えるまでは推し付きコメントの通知で知らせていたので、ユーザーへの推しだけになってから何も届いていなかった。
// - サイト内通知: activity D1 の notifications に、コインのお知らせと同じ形（notifyType 0・workId 0・ownerUserId -1）で 1 行。
//   Web・アプリとも通知の「コイン」タブにそのまま出る（古いアプリでも出る）
// - プッシュ: アプリ・ブラウザに FCM で（有料リクエストと同じ sendPush）。金額は書かず、1 人に 1 時間に 1 通まで
// - 受け取る人が「推しを表示しない」（hide_coin_support）か、コメントの通知をオフ（notNotificationComment。推し付きコメントの通知と同じ項目）なら何もしない
// - 匿名の推しは送った人の名前を出さない
// - 送った人のユーザー ID を commentId に入れる（匿名は -1）。通知の行にアイコンとプロフィールへのリンクを出すため
//   （aipictors-system の WorkAwardNotificationNode.user）。ownerUserId を -1 のままにして、古いアプリでも今までどおりコインのお知らせとして出す
// 失敗しても推しそのものは止めない（呼ぶ側は waitUntil で投げる）
import { claimPushSend } from "../app-push"
import { sendPush } from "../coin-requests/notify"

const JST = 9 * 3600

/** 1 人に送るプッシュの間隔（続けて推されても 1 時間に 1 通） */
export const SUPPORT_PUSH_INTERVAL = 3600

/** 通知の文面に必ず入る言葉（Web の推しを表示しない設定で外すときの目印にもなる） */
export const SUPPORT_NOTIFICATION_PHRASE = "あなたを推しました"

const supporterLabel = ({ senderName, isAnonymous }) =>
  isAnonymous ? "匿名のユーザー" : `${String(senderName ?? "").trim() || "ユーザー"}さん`

/** 通知一覧の文面: 「◯◯さんがあなたを推しました（プレミアムコイン 10）」 */
export const buildSupportNotificationMessage = ({ senderName, isAnonymous, coinType, amount }) => {
  const coin = coinType === "PREMIUM" ? "プレミアムコイン" : "フリーコイン"
  return `${supporterLabel({ senderName, isAnonymous })}が${SUPPORT_NOTIFICATION_PHRASE}（${coin} ${Number(amount ?? 0).toLocaleString("ja-JP")}）`
}

/** プッシュの文面（ロック画面に出るので金額は書かない） */
export const buildSupportPushBody = ({ senderName, isAnonymous }) =>
  `${supporterLabel({ senderName, isAnonymous })}が${SUPPORT_NOTIFICATION_PHRASE}`

/** 受け取る人に知らせてよいか。読めないときは知らせない（表示しない設定の人に出さないことを優先） */
const shouldNotify = async (core, recipientUserId) => {
  try {
    const row = await core
      .prepare(`SELECT hide_coin_support AS hide, notNotificationComment AS off FROM user_settings WHERE userId = ?1`)
      .bind(Number(recipientUserId))
      .first()
    return Number(row?.hide ?? 0) !== 1 && Number(row?.off ?? 0) !== 1
  } catch (error) {
    console.log(JSON.stringify({ event: "coin_support.notify_setting_failed", message: String(error?.message ?? error) }))
    return false
  }
}

/** 通知の commentId に入れる送った人の ID（匿名・数字でない ID は -1） */
export const toSenderColumn = ({ senderUserId, isAnonymous }) =>
  !isAnonymous && /^\d+$/.test(String(senderUserId ?? "")) ? Number(senderUserId) : -1

const loadUserName = async (core, userId) => {
  try {
    const row = await core
      .prepare(
        `SELECT COALESCE(NULLIF(p.userName, ''), NULLIF(u.display_name, '')) AS name
           FROM wp_users u LEFT JOIN user_profiles p ON p.userId = u.ID WHERE u.ID = ?1 LIMIT 1`,
      )
      .bind(Number(userId))
      .first()
    return row?.name ?? null
  } catch {
    return null
  }
}

export const notifySupportReceived = async ({ env, db, core, activity, senderUserId, recipientUserId, coinType, amount, isAnonymous, now }) => {
  try {
    if (!core || !activity || !/^\d+$/.test(String(recipientUserId ?? ""))) return { skipped: "disabled" }
    if (!(await shouldNotify(core, recipientUserId))) return { skipped: "setting" }
    const senderName = isAnonymous ? null : await loadUserName(core, senderUserId)
    const message = buildSupportNotificationMessage({ senderName, isAnonymous, coinType, amount })
    const notifyTime = `${new Date((now + JST) * 1000).toISOString().slice(0, 23)}+00:00`
    await activity
      .prepare(
        `INSERT INTO notifications (userId, workId, comment, stampId, ownerUserId, notifyInnerCount, notifyType, notifyTime, commentId)
         VALUES (?1, 0, ?2, -1, -1, 0, 0, ?3, ?4)`,
      )
      .bind(Number(recipientUserId), message, notifyTime, toSenderColumn({ senderUserId, isAnonymous }))
      .run()
    let pushed = 0
    if (db && (await claimPushSend(db, recipientUserId, "support", `${now}:${senderUserId}`, now, SUPPORT_PUSH_INTERVAL))) {
      pushed = await sendPush({ env, core, userId: recipientUserId, title: "推しが届きました", body: buildSupportPushBody({ senderName, isAnonymous }), url: "/notifications" })
    }
    return { notified: true, pushed }
  } catch (error) {
    console.error(JSON.stringify({ event: "coin_support.notify_failed", recipientUserId: String(recipientUserId), message: String(error?.message ?? error) }))
    return { skipped: "error" }
  }
}
