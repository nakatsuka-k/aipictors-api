// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// アプリ（user_profiles.fcm_token）へのプッシュ通知: 生成の完了・ランキング入り・週のまとめ。
// しつこくならないように、種類ごとに送る間隔を決めて push_sends に残し、設定（push_preferences）でオフにできる。
// ブラウザ（web_fcm_token）には送らない（いいね・コメントなどのブラウザ向けは aipictors-system の lib/web-push.ts）
import { getAccessToken } from "./coin-requests/notify"

const JST = 9 * 3600
const DAY = 86400

export const PUSH_KINDS = ["generation", "ranking", "digest"]

/** 生成の完了は、続けて生成しても 2 分に 1 回まで */
export const GENERATION_PUSH_INTERVAL = 120

const shorten = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const isPushConfigured = (env) => Boolean(env?.FIREBASE_PRIVATE_KEY && env?.FIREBASE_CLIENT_EMAIL && env?.FIREBASE_PROJECT_ID)

const toPrefs = (row) => ({
  generation: row ? Number(row.generation) !== 0 : true,
  ranking: row ? Number(row.ranking) !== 0 : true,
  digest: row ? Number(row.digest) !== 0 : true,
})

export const getPushPreferences = async (db, userId) => {
  const row = await db.queryOne(`SELECT generation, ranking, digest FROM push_preferences WHERE user_id = $1`, [String(userId)])
  return toPrefs(row)
}

/** 渡した項目だけ変える（行が無ければ既定のオンで作る） */
export const savePushPreferences = async (db, userId, input, now) => {
  const current = await getPushPreferences(db, userId)
  const next = { ...current }
  for (const kind of PUSH_KINDS) {
    if (typeof input?.[kind] === "boolean") next[kind] = input[kind]
  }
  await db.execute(
    `INSERT INTO push_preferences (user_id, generation, ranking, digest, updated_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET generation = excluded.generation, ranking = excluded.ranking, digest = excluded.digest, updated_at = excluded.updated_at`,
    [String(userId), next.generation ? 1 : 0, next.ranking ? 1 : 0, next.digest ? 1 : 0, now],
  )
  return next
}

/** 送ったことを残す。同じ key をほかの実行が先に書いていたら false（二重に送らない） */
const claimSend = async (db, userId, kind, key, now, minInterval = 0) => {
  const result = await db.executeResult(
    `INSERT INTO push_sends (user_id, kind, key, sent_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, kind) DO UPDATE SET key = excluded.key, sent_at = excluded.sent_at
     WHERE push_sends.key <> excluded.key AND push_sends.sent_at <= $5`,
    [String(userId), kind, key, now, now - minInterval],
  )
  return Number(result?.rowCount ?? 0) > 0
}

/** ほかのファイルから使う名前（推しの通知: coin-support/notify.ts） */
export const claimPushSend = claimSend

const readAppTokens = async (core, userIds) => {
  const tokens = new Map()
  const ids = [...new Set(userIds.map(String))].filter((id) => /^\d+$/.test(id))
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const rows =
      (
        await core
          .prepare(`SELECT userId, fcm_token FROM user_profiles WHERE userId IN (SELECT value FROM json_each(?1)) AND length(fcm_token) > 20`)
          .bind(JSON.stringify(chunk.map(Number)))
          .all()
      ).results ?? []
    for (const r of rows) tokens.set(String(r.userId), r.fcm_token)
  }
  return tokens
}

/** FCM の 1 通（アプリ向け）。トークンが使えなくなっていれば "invalid" */
export const buildAppPushMessage = ({ token, title, body, type, url, tag }) => ({
  message: {
    token,
    notification: { title: shorten(title, 60), body: shorten(body, 120) },
    data: { type, url },
    android: { priority: "high", collapse_key: tag, notification: { tag, click_action: "FLUTTER_NOTIFICATION_CLICK" } },
    apns: { headers: { "apns-collapse-id": tag }, payload: { aps: { sound: "default", "thread-id": type } } },
  },
})

export const sendAppPushToToken = async (env, message) => {
  const accessToken = await getAccessToken(env)
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(message),
  })
  if (response.ok) return "sent"
  const text = await response.text().catch(() => "")
  if (response.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT.*token/i.test(text)) return "invalid"
  console.warn(JSON.stringify({ event: "app_push.failed", status: response.status, body: text.slice(0, 200) }))
  return "failed"
}

/** 使えなくなったトークンは消す（次からそもそも送らない。アプリを開けば登録し直す） */
const dropToken = async (core, userId, token) => {
  try {
    await core.prepare(`UPDATE user_profiles SET fcm_token = NULL WHERE userId = ?1 AND fcm_token = ?2`).bind(Number(userId), token).run()
  } catch {}
}

const deliver = async ({ env, core, userId, token, ...content }) => {
  const result = await sendAppPushToToken(env, buildAppPushMessage({ token, ...content }))
  if (result === "invalid") await dropToken(core, userId, token)
  return result
}

// ---- 生成の完了 ----

/**
 * 生成ワーカーが 1 件保存するたびに呼ぶ。アプリから頼んだ生成で、その人の待ち・生成中・予約が残っていなければ「できました」を送る。
 * 続けて頼んだ分は最後の 1 件で 1 回だけ（2 分に 1 回まで）
 */
export const notifyGenerationDone = async ({ env, db, genlog, core, userId, platform, now }) => {
  if (String(platform ?? "") !== "flutter") return { skipped: "platform" }
  if (!isPushConfigured(env) || !core || !/^\d+$/.test(String(userId))) return { skipped: "disabled" }
  const prefs = await getPushPreferences(db, userId)
  if (!prefs.generation) return { skipped: "preference" }
  // 索引 (user_id, is_deleted, status, id) でその人の生成中だけを読む
  const [active, reserved] = await Promise.all([
    genlog.queryOne(
      `SELECT COUNT(*) AS count FROM generated_queues INDEXED BY idx_generated_queues_deleted_user_id_status_id
        WHERE user_id = $1 AND is_deleted = FALSE AND status IN ('wait', 'generating')`,
      [Number(userId)],
    ),
    genlog.queryOne(
      `SELECT COUNT(*) AS count FROM generated_reservation_queues WHERE user_id = $1 AND is_deleted = FALSE AND is_generated = FALSE`,
      [Number(userId)],
    ),
  ])
  if (Number(active?.count ?? 0) + Number(reserved?.count ?? 0) > 0) return { skipped: "pending" }
  const tokens = await readAppTokens(core, [userId])
  const token = tokens.get(String(userId))
  if (!token) return { skipped: "no_token" }
  if (!(await claimSend(db, userId, "generation", String(now), now, GENERATION_PUSH_INTERVAL))) return { skipped: "interval" }
  const result = await deliver({
    env,
    core,
    userId,
    token,
    title: "画像の生成が終わりました",
    body: "できあがった画像を見てみましょう。気に入ったら投稿もできます",
    type: "generation",
    url: "/generation",
    tag: "generation",
  })
  return { result }
}

// ---- ランキング入り ----

const jstDate = (sec) => new Date((sec + JST) * 1000)
const ymd = (d) => d.toISOString().slice(0, 10)
const favDateText = (d) => `${ymd(d)}T00:00:00.000+00:00`

const RANKING_LABEL = { daily: "デイリー", weekly: "ウィークリー", monthly: "マンスリー" }
const RANKING_PRIORITY = { monthly: 0, weekly: 1, daily: 2 }

/**
 * その日の朝（4:00）に決まったランキングの範囲。デイリーは前日、月曜はウィークリー（前の週の月曜）、1 日はマンスリー（前の月の 1 日）
 */
export const rankingRangesFor = (now) => {
  const today = jstDate(now)
  today.setUTCHours(0, 0, 0, 0)
  const ranges = [{ rankingType: "daily", favDate: favDateText(new Date(today.getTime() - DAY * 1000)) }]
  if (today.getUTCDay() === 1) ranges.push({ rankingType: "weekly", favDate: favDateText(new Date(today.getTime() - 7 * DAY * 1000)) })
  if (today.getUTCDate() === 1) {
    const prev = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))
    ranges.push({ rankingType: "monthly", favDate: favDateText(prev) })
  }
  return { day: ymd(today), ranges }
}

/** 1 人 1 通にまとめる（マンスリー → ウィークリー → デイリー、順位の高いもの） */
export const pickBestRankings = (rows) => {
  const best = new Map()
  for (const r of rows) {
    const key = String(r.userId)
    const current = best.get(key)
    const better =
      !current ||
      RANKING_PRIORITY[r.rankingType] < RANKING_PRIORITY[current.rankingType] ||
      (RANKING_PRIORITY[r.rankingType] === RANKING_PRIORITY[current.rankingType] && Number(r.rank) < Number(current.rank))
    if (better) best.set(key, { ...r, count: (current?.count ?? 0) + 1 })
    else current.count += 1
  }
  return best
}

export const buildRankingPush = ({ rankingType, rank, title, count }) => {
  const label = RANKING_LABEL[rankingType] ?? ""
  const work = shorten(title, 24) ? `「${shorten(title, 24)}」` : "あなたの作品"
  return {
    title: `${work}が${label}ランキング ${rank} 位に入りました`,
    body: count > 1 ? `ほかに ${count - 1} 件もランクイン。おめでとうございます！` : "おめでとうございます！ランキングを見てみましょう",
  }
}

/**
 * 12:00 JST: 朝のランキング（全年齢）に入った人へ 1 日 1 通。アプリは R18 を出さないので R18 のランキングは送らない
 */
export const runRankingPush = async ({ env, db, core, now }) => {
  if (!isPushConfigured(env) || !core) return { skipped: "disabled" }
  const { day, ranges } = rankingRangesFor(now)
  const rows = []
  for (const range of ranges) {
    // 主キー (favDate, rankingType, ...) で読む
    const found =
      (
        await core
          .prepare(`SELECT userId, worksId, rank, rankingType FROM work_rankings WHERE favDate = ?1 AND rankingType = ?2 AND worksR18 = 0`)
          .bind(range.favDate, range.rankingType)
          .all()
      ).results ?? []
    rows.push(...found)
  }
  const best = pickBestRankings(rows)
  const tokens = await readAppTokens(core, [...best.keys()])
  const targets = [...best.values()].filter((r) => tokens.has(String(r.userId)))
  if (targets.length === 0) return { day, ranked: best.size, sent: 0 }
  const disabled = new Set(
    (
      await db.query(
        `SELECT user_id FROM push_preferences WHERE ranking = 0 AND user_id IN (SELECT value FROM json_each($1))`,
        [JSON.stringify(targets.map((r) => String(r.userId)))],
      )
    ).map((r) => String(r.user_id)),
  )
  const titles = new Map(
    (
      (
        await core
          .prepare(`SELECT id, title FROM works WHERE id IN (SELECT value FROM json_each(?1))`)
          .bind(JSON.stringify(targets.map((r) => Number(r.worksId))))
          .all()
      ).results ?? []
    ).map((w) => [String(w.id), w.title]),
  )
  let sent = 0
  for (const r of targets) {
    const userId = String(r.userId)
    if (disabled.has(userId)) continue
    if (!(await claimSend(db, userId, "ranking", day, now))) continue
    const content = buildRankingPush({ ...r, title: titles.get(String(r.worksId)) })
    const result = await deliver({ env, core, userId, token: tokens.get(userId), ...content, type: "ranking", url: `/works/${r.worksId}`, tag: "ranking" })
    if (result === "sent") sent++
  }
  return { day, ranked: best.size, targets: targets.length, sent }
}

// ---- 週のまとめ ----

export const buildDigestPush = ({ likes, comments, follows }) => {
  const parts = []
  if (likes > 0) parts.push(`いいね ${likes}`)
  if (comments > 0) parts.push(`コメント ${comments}`)
  if (follows > 0) parts.push(`フォロー ${follows}`)
  if (parts.length === 0) return null
  return { title: `今週の反応: ${parts.join("・")}`, body: "あなたの作品に届いた反応をチェックしましょう" }
}

/**
 * 日曜 19:00 JST: この 1 週間に反応（いいね・コメント・返信・フォロー）があった人へ週 1 通。
 * 対象はアプリで Push を登録した人（push_preferences に行がある人）だけ。反応が 0 の人には送らない
 */
export const runWeeklyDigestPush = async ({ env, db, core, activity, now, limit = 3000 }) => {
  if (!isPushConfigured(env) || !core || !activity) return { skipped: "disabled" }
  const week = ymd(jstDate(now))
  const since = `${ymd(jstDate(now - 7 * DAY))}T${jstDate(now).toISOString().slice(11, 19)}`
  const users = (await db.query(`SELECT user_id FROM push_preferences WHERE digest = 1 ORDER BY user_id LIMIT $1`, [limit])).map((r) => String(r.user_id))
  // 今週もう送った人（5 分ごとの回が重なったとき）は数え直さない
  const done = new Set((await db.query(`SELECT user_id FROM push_sends WHERE kind = 'digest' AND key = $1`, [week])).map((r) => String(r.user_id)))
  const tokens = await readAppTokens(core, users.filter((id) => !done.has(id)))
  let sent = 0
  let empty = 0
  for (const userId of users) {
    const token = tokens.get(userId)
    if (!token) continue
    // 索引 (userId, notifyType, notifyTime) で種類ごとに数える。作品のない notifyType 0 はお知らせ（コイン・推しなど）なので、いいねに数えない
    const rows =
      (
        await activity
          .prepare(
            `SELECT notifyType, COUNT(*) AS count FROM notifications
              WHERE userId = ?1 AND notifyType IN (0, 1, 2, 3) AND notifyTime > ?2
                AND NOT (notifyType = 0 AND workId = 0) GROUP BY notifyType`,
          )
          .bind(Number(userId), since)
          .all()
      ).results ?? []
    const n = (type) => Number(rows.find((r) => Number(r.notifyType) === type)?.count ?? 0)
    const content = buildDigestPush({ likes: n(0), comments: n(1) + n(2), follows: n(3) })
    if (!content) {
      empty++
      continue
    }
    if (!(await claimSend(db, userId, "digest", week, now, 5 * DAY))) continue
    const result = await deliver({ env, core, userId, token, ...content, type: "digest", url: "/notifications", tag: "digest" })
    if (result === "sent") sent++
  }
  return { week, users: users.length, withToken: tokens.size, empty, sent }
}

