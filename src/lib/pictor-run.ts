// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// ミニゲーム「ぴくたーちゃんラン」のチャットとスコアランキング（表は migrations/gen/0010_pictor_run.sql）

export var PICTOR_RUN_BODY_MAX_LENGTH = 200
export var PICTOR_RUN_MESSAGE_LIMIT = 60
export var PICTOR_RUN_RANKING_LIMIT = 50
/** 続けて書き込める数（この秒数の間に、この件数まで） */
export var PICTOR_RUN_RATE_WINDOW_SECONDS = 20
export var PICTOR_RUN_RATE_MAX = 4
/** 1 秒に進める距離の上限と、1 秒に取れるコインの上限（あり得ないスコアを弾く目安） */
export var PICTOR_RUN_MAX_METERS_PER_SECOND = 7.2
export var PICTOR_RUN_MAX_COINS_PER_SECOND = 2.5
export var PICTOR_RUN_MAX_SCORE = 200000

var parseJson = (text) => {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

var toText = (value, max) => {
  if (typeof value !== "string") return null
  const text = value.trim()
  return text.length > 0 ? text.slice(0, max) : null
}

/** 書き込む人（サイトの API がログイン中の本人から作る） */
export var toPictorRunUser = (input) => {
  const id = toText(input?.id, 40)
  const name = toText(input?.name, 80)
  if (!id || !name) return null
  const badge = input?.badge && typeof input.badge === "object" ? input.badge : null
  return {
    id,
    name,
    login: toText(input?.login, 80),
    iconUrl: toText(input?.iconUrl, 500),
    badge: badge ? JSON.stringify(badge).slice(0, 1000) : null
  }
}

var toMessage = (row) => ({
  id: String(row.id),
  user: {
    id: row.user_id,
    name: row.user_name,
    login: row.user_login,
    iconUrl: row.icon_url,
    badge: parseJson(row.badge)
  },
  body: row.body,
  stickerId: row.sticker_id,
  stickerUrl: row.sticker_url,
  replyTo: row.reply_to_id
    ? {
        id: String(row.reply_to_id),
        userId: row.reply_to_user_id,
        name: row.reply_to_name,
        excerpt: row.reply_to_excerpt
      }
    : null,
  mentions: parseJson(row.mentions) ?? [],
  /** "discord" = Discord で書かれたもの */
  source: row.source ?? null,
  createdAt: Number(row.created_at)
})

/** 新しい順に limit 件を取り、古い順に並べて返す。afterId があればそれより新しいものだけ */
export var listPictorRunMessages = async (db, props) => {
  const limit = Math.min(Math.max(Number(props.limit) || PICTOR_RUN_MESSAGE_LIMIT, 1), PICTOR_RUN_MESSAGE_LIMIT)
  const afterId = Number(props.afterId) || 0
  const beforeId = Number(props.beforeId) || 0
  const rows = beforeId > 0
    ? await db.query(
        "SELECT * FROM pictor_run_messages WHERE deleted_at IS NULL AND id < $1 ORDER BY id DESC LIMIT $2",
        [beforeId, limit]
      )
    : await db.query(
        "SELECT * FROM pictor_run_messages WHERE deleted_at IS NULL AND id > $1 ORDER BY id DESC LIMIT $2",
        [afterId, limit]
      )
  return rows.reverse().map(toMessage)
}

/** この間に消されたもの（開いている人の画面からも消す） */
export var listPictorRunDeletedIds = async (db, since) => {
  const rows = await db.query(
    "SELECT id FROM pictor_run_messages WHERE deleted_at IS NOT NULL AND deleted_at >= $1 ORDER BY id DESC LIMIT 100",
    [since]
  )
  return rows.map((row) => String(row.id))
}

export var createPictorRunMessage = async (db, props) => {
  const { user, now } = props
  const body = (typeof props.body === "string" ? props.body : "").replace(/\s+\n/g, "\n").trim()
  const stickerUrl = toText(props.stickerUrl, 500)
  const stickerId = toText(props.stickerId, 40)
  if (body.length === 0 && !stickerUrl) return { error: "empty", status: 400 }
  if (body.length > PICTOR_RUN_BODY_MAX_LENGTH) return { error: "too_long", status: 400 }

  const recent = await db.query(
    "SELECT body, sticker_id, created_at FROM pictor_run_messages WHERE user_id = $1 AND created_at >= $2 ORDER BY id DESC LIMIT 10",
    [user.id, now - 60]
  )
  const inWindow = recent.filter((row) => Number(row.created_at) >= now - PICTOR_RUN_RATE_WINDOW_SECONDS)
  if (inWindow.length >= PICTOR_RUN_RATE_MAX) return { error: "rate_limited", status: 429 }
  // 同じ文の連投は弾く
  if (body.length > 0 && recent.some((row) => row.body === body)) return { error: "duplicate", status: 429 }

  let reply = null
  const replyToId = Number(props.replyToId) || 0
  if (replyToId > 0) {
    const target = await db.queryOne(
      "SELECT id, user_id, user_name, body, sticker_url FROM pictor_run_messages WHERE id = $1 AND deleted_at IS NULL",
      [replyToId]
    )
    if (target) {
      reply = {
        id: Number(target.id),
        userId: target.user_id,
        name: target.user_name,
        excerpt: (target.body || (target.sticker_url ? "（スタンプ）" : "")).slice(0, 60)
      }
    }
  }

  const mentions = (Array.isArray(props.mentions) ? props.mentions : [])
    .map((item) => ({ userId: toText(item?.userId, 40), name: toText(item?.name, 80) }))
    .filter((item) => item.userId && item.name && body.includes(`@${item.name}`))
    .slice(0, 5)

  const row = await db.queryOne(
    `INSERT INTO pictor_run_messages
       (user_id, user_name, user_login, icon_url, badge, body, sticker_id, sticker_url,
        reply_to_id, reply_to_user_id, reply_to_name, reply_to_excerpt, mentions, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      user.id, user.name, user.login, user.iconUrl, user.badge, body, stickerId, stickerUrl,
      reply?.id ?? null, reply?.userId ?? null, reply?.name ?? null, reply?.excerpt ?? null,
      mentions.length > 0 ? JSON.stringify(mentions) : null, now
    ]
  )
  return { error: null, message: toMessage(row), row }
}

// ---- Discord のチャンネルとの連携 -------------------------------------------------
// サイト → Discord: Webhook で、書いた人の名前とアイコンのまま写す
// Discord → サイト: だれかがチャットを読みに来たときに、新しいものを取り込む（数秒に 1 回まで。だれも見ていない間は何もしない）
var DISCORD_API = "https://discord.com/api/v10"
/** Discord へ取りに行く間隔（秒） */
var DISCORD_SYNC_INTERVAL_SECONDS = 4

var discordConfig = (env) => {
  const token = env?.PICTOR_RUN_DISCORD_BOT_TOKEN
  const channelId = env?.PICTOR_RUN_DISCORD_CHANNEL_ID
  const webhookUrl = env?.PICTOR_RUN_DISCORD_WEBHOOK_URL
  return token && channelId && webhookUrl ? { token, channelId, webhookUrl } : null
}

/** Discord の文を、サイトで出す文にする（メンション・絵文字の記号を読める形に） */
var toSiteBody = (message) => {
  let text = typeof message.content === "string" ? message.content : ""
  for (const user of message.mentions ?? []) {
    text = text.split(`<@${user.id}>`).join(`@${user.global_name || user.username}`)
    text = text.split(`<@!${user.id}>`).join(`@${user.global_name || user.username}`)
  }
  text = text
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/<#\d+>/g, "#チャンネル")
    .replace(/<@&\d+>/g, "@ロール")
    .trim()
  const images = (message.attachments ?? []).length + (message.sticker_items ?? []).length
  if (images > 0) text = `${text}${text ? " " : ""}（画像）`
  return text.slice(0, PICTOR_RUN_BODY_MAX_LENGTH)
}

/** Discord の新しいメッセージを取り込む */
export var syncPictorRunDiscord = async (db, env, now) => {
  const config = discordConfig(env)
  if (!config) return
  // 同時に何人が読みに来ても、取りに行くのは数秒に 1 回だけ
  const claimed = await db.executeResult(
    `INSERT INTO pictor_run_state (key, value, updated_at) VALUES ('discord_sync', '', $1)
     ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at
     WHERE pictor_run_state.updated_at <= $2`,
    [now, now - DISCORD_SYNC_INTERVAL_SECONDS]
  )
  if ((claimed?.rowCount ?? 0) === 0) return
  const state = await db.queryOne("SELECT value FROM pictor_run_state WHERE key = 'discord_last_id'", [])
  const lastId = state?.value || ""
  const response = await fetch(
    `${DISCORD_API}/channels/${config.channelId}/messages?limit=${lastId ? 50 : 1}${lastId ? `&after=${lastId}` : ""}`,
    { headers: { authorization: `Bot ${config.token}`, "user-agent": "DiscordBot (https://www.aipictors.com, 1.0)" } }
  )
  if (!response.ok) return
  const list = await response.json().catch(() => null)
  if (!Array.isArray(list)) return
  if (list.length === 0) {
    // まだ何も書かれていないチャンネル: 次からは最初の 1 件めから取り込む
    if (!lastId) {
      await db.execute(
        "INSERT OR IGNORE INTO pictor_run_state (key, value, updated_at) VALUES ('discord_last_id', '1', $1)",
        [now]
      )
    }
    return
  }
  // 新しい順で届くので、古い順に入れる。はじめての回は、いまの位置を覚えるだけ（過去のものは取り込まない）
  const messages = lastId ? list.slice().reverse() : []
  for (const message of messages) {
    // Webhook で写したもの（= サイトで書かれたもの）とボットは取り込まない。ふつうの発言と返信だけ
    if (message.webhook_id || message.author?.bot || (message.type !== 0 && message.type !== 19)) continue
    const body = toSiteBody(message)
    if (body.length === 0) continue
    const author = message.author
    const name = String(message.member?.nick || author.global_name || author.username || "Discord").slice(0, 80)
    const iconUrl = author.avatar
      ? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.webp?size=128`
      : null
    let reply = null
    const referenceId = message.message_reference?.message_id
    if (referenceId) {
      const target = await db.queryOne(
        "SELECT id, user_id, user_name, body, sticker_url FROM pictor_run_messages WHERE discord_id = $1 AND deleted_at IS NULL",
        [String(referenceId)]
      )
      if (target) {
        reply = {
          id: Number(target.id),
          userId: target.user_id,
          name: target.user_name,
          excerpt: (target.body || (target.sticker_url ? "（スタンプ）" : "")).slice(0, 60)
        }
      }
    }
    await db.execute(
      `INSERT OR IGNORE INTO pictor_run_messages
         (user_id, user_name, icon_url, body, reply_to_id, reply_to_user_id, reply_to_name, reply_to_excerpt,
          created_at, source, discord_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'discord', $10)`,
      [
        `discord:${author.id}`, name, iconUrl, body,
        reply?.id ?? null, reply?.userId ?? null, reply?.name ?? null, reply?.excerpt ?? null,
        now, String(message.id)
      ]
    )
  }
  await db.execute(
    `INSERT INTO pictor_run_state (key, value, updated_at) VALUES ('discord_last_id', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [String(list[0].id), now]
  )
}

/** サイトで書かれたものを、Discord のチャンネルに写す */
export var sendPictorRunMessageToDiscord = async (db, env, row) => {
  const config = discordConfig(env)
  if (!config || !row) return
  const quote = row.reply_to_name ? `> ↪ ${row.reply_to_name}: ${String(row.reply_to_excerpt ?? "").replace(/\n/g, " ")}\n` : ""
  const content = `${quote}${row.body || ""}${row.sticker_url ? `${row.body ? "\n" : ""}${row.sticker_url}` : ""}`.slice(0, 1900)
  if (content.length === 0) return
  // Webhook の名前に「discord」「clyde」は使えない
  const username = String(row.user_name).replace(/discord/gi, "d1scord").replace(/clyde/gi, "c1yde").slice(0, 80) || "Aipictors"
  const response = await fetch(`${config.webhookUrl}?wait=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content,
      username,
      avatar_url: typeof row.icon_url === "string" && row.icon_url.startsWith("https://") ? row.icon_url : undefined,
      // サイトから @everyone などを飛ばせないようにする
      allowed_mentions: { parse: [] }
    })
  })
  if (!response.ok) return
  const sent = await response.json().catch(() => null)
  if (sent?.id) {
    await db.execute("UPDATE pictor_run_messages SET discord_id = $1 WHERE id = $2 AND discord_id IS NULL", [String(sent.id), row.id])
  }
}

/** サイトで消されたものを、Discord からも消す（サイトで書かれて、写してあるものだけ） */
export var deletePictorRunMessageFromDiscord = async (db, env, messageId) => {
  const config = discordConfig(env)
  if (!config) return
  const row = await db.queryOne(
    "SELECT discord_id FROM pictor_run_messages WHERE id = $1 AND deleted_at IS NOT NULL AND source IS NULL AND discord_id IS NOT NULL",
    [Number(messageId) || 0]
  )
  if (!row?.discord_id) return
  await fetch(`${config.webhookUrl}/messages/${row.discord_id}`, { method: "DELETE" })
}

/** 本人かモデレーターだけ消せる */
export var deletePictorRunMessage = async (db, props) => {
  const result = await db.executeResult(
    `UPDATE pictor_run_messages SET deleted_at = $1
      WHERE id = $2 AND deleted_at IS NULL AND (user_id = $3 OR $4 = 1)`,
    [props.now, Number(props.messageId) || 0, props.userId, props.isModerator ? 1 : 0]
  )
  return (result?.rowCount ?? 0) > 0
}

/** 日本時間の月曜 0 時（UNIX 秒） */
export var pictorRunWeekStart = (now) => {
  const jst = now + 9 * 3600
  const days = Math.floor(jst / 86400)
  // 1970-01-01 は木曜。月曜までさかのぼる
  const sinceMonday = (days + 3) % 7
  return (days - sinceMonday) * 86400 - 9 * 3600
}

var isPlausibleScore = (score, coins, durationMs) => {
  if (!Number.isInteger(score) || !Number.isInteger(coins)) return false
  if (score < 0 || coins < 0 || score > PICTOR_RUN_MAX_SCORE) return false
  const seconds = Math.max(0, Number(durationMs) || 0) / 1000
  if (seconds <= 0) return score === 0
  if (coins > seconds * PICTOR_RUN_MAX_COINS_PER_SECOND + 5) return false
  return score <= seconds * PICTOR_RUN_MAX_METERS_PER_SECOND + coins * 10 + 20
}

export var submitPictorRunScore = async (db, props) => {
  const { user, now } = props
  const score = Number(props.score)
  const coins = Number(props.coins)
  if (!isPlausibleScore(score, coins, props.durationMs)) return { error: "invalid_score", status: 400 }
  const before = await db.queryOne("SELECT best_score FROM pictor_run_scores WHERE user_id = $1", [user.id])
  const previousBest = before ? Number(before.best_score) : 0
  const isNewBest = score > previousBest
  await db.batch([
    {
      text: "INSERT INTO pictor_run_plays (user_id, score, coins, created_at) VALUES ($1, $2, $3, $4)",
      params: [user.id, score, coins, now]
    },
    {
      text: `INSERT INTO pictor_run_scores
               (user_id, user_name, user_login, icon_url, badge, best_score, best_coins, plays, best_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)
             ON CONFLICT (user_id) DO UPDATE SET
               user_name = excluded.user_name,
               user_login = excluded.user_login,
               icon_url = excluded.icon_url,
               badge = excluded.badge,
               plays = pictor_run_scores.plays + 1,
               best_coins = CASE WHEN excluded.best_score > pictor_run_scores.best_score THEN excluded.best_coins ELSE pictor_run_scores.best_coins END,
               best_at = CASE WHEN excluded.best_score > pictor_run_scores.best_score THEN excluded.best_at ELSE pictor_run_scores.best_at END,
               best_score = MAX(pictor_run_scores.best_score, excluded.best_score),
               updated_at = excluded.updated_at`,
      params: [user.id, user.name, user.login, user.iconUrl, user.badge, score, coins, now]
    }
  ])
  const best = Math.max(previousBest, score)
  const above = await db.queryOne("SELECT COUNT(*) AS n FROM pictor_run_scores WHERE best_score > $1", [best])
  // サイトの隠し実績: はじめて遊んだ・全 13 ステージを走りぬけた（走った距離 = 得点 - コイン × 10）
  const achievements = []
  if (!before) achievements.push("special-pictor-run-play")
  if (score - coins * 10 >= PICTOR_RUN_CLEAR_DISTANCE) achievements.push("special-pictor-run-clear")
  return { error: null, data: { best, isNewBest, rank: Number(above?.n ?? 0) + 1 }, achievements }
}

/** 全 13 ステージ（1 ステージ 80m）を走りぬけた距離 */
export var PICTOR_RUN_CLEAR_DISTANCE = 1040
/** 実績でもらえる無料コイン（aipictors-system の achievement-catalog.ts のランクと同じ: ブロンズ 10・プラチナ 50） */
var PICTOR_RUN_ACHIEVEMENT_COINS = { "special-pictor-run-play": 10, "special-pictor-run-clear": 50 }

/**
 * サイトの実績（aipictors-system の core の user_achievement_unlocks）に、達成を記録する。
 * 既に達成していれば何もしない。コインは、次にサイトが実績を確かめたときに付与される（reward_status = PENDING）
 */
export var unlockPictorRunAchievements = async (core, userId, keys, nowMs) => {
  const id = Number(userId)
  if (!core || !Number.isInteger(id) || id <= 0 || keys.length === 0) return
  // ほかの表と同じく、日本時間をそのまま入れる
  const unlockedAt = new Date(nowMs + 9 * 3600 * 1000).toISOString().replace("Z", "+00:00")
  for (const key of keys) {
    const coins = PICTOR_RUN_ACHIEVEMENT_COINS[key]
    if (coins === undefined) continue
    await core
      .prepare(
        `INSERT INTO user_achievement_unlocks (user_id, achievement_key, unlocked_at, reward_coins, reward_status, is_initial_sync)
         VALUES (?, ?, ?, ?, 'PENDING', 0)
         ON CONFLICT(user_id, achievement_key) DO NOTHING`
      )
      .bind(id, key, unlockedAt, coins)
      .run()
  }
}

var toRankingItem = (row, index) => ({
  rank: index + 1,
  user: {
    id: row.user_id,
    name: row.user_name,
    login: row.user_login,
    iconUrl: row.icon_url,
    badge: parseJson(row.badge)
  },
  score: Number(row.score),
  coins: Number(row.coins ?? 0)
})

/** period: all（自己ベストの累計）/ week（今週の最高） */
export var getPictorRunRanking = async (db, props) => {
  const limit = Math.min(Math.max(Number(props.limit) || PICTOR_RUN_RANKING_LIMIT, 1), PICTOR_RUN_RANKING_LIMIT)
  const userId = props.userId ? String(props.userId) : null
  if (props.period === "week") {
    const since = pictorRunWeekStart(props.now)
    const rows = await db.query(
      `SELECT p.user_id, MAX(p.score) AS score, s.user_name, s.user_login, s.icon_url, s.badge,
              (SELECT q.coins FROM pictor_run_plays q
                WHERE q.user_id = p.user_id AND q.created_at >= $3
                ORDER BY q.score DESC, q.created_at LIMIT 1) AS coins
         FROM pictor_run_plays p JOIN pictor_run_scores s ON s.user_id = p.user_id
        WHERE p.created_at >= $1
        GROUP BY p.user_id ORDER BY score DESC, MIN(p.created_at) LIMIT $2`,
      // coins = 今週いちばん良かった回のコイン（走れた距離 = 得点 - コイン × 10 を、看板に出すのに使う）
      [since, limit, since]
    )
    let me = null
    if (userId) {
      const mine = await db.queryOne(
        "SELECT MAX(score) AS score FROM pictor_run_plays WHERE user_id = $1 AND created_at >= $2",
        [userId, since]
      )
      if (mine?.score !== null && mine?.score !== undefined) {
        const above = await db.queryOne(
          `SELECT COUNT(*) AS n FROM (SELECT user_id FROM pictor_run_plays WHERE created_at >= $1 GROUP BY user_id HAVING MAX(score) > $2)`,
          [since, Number(mine.score)]
        )
        me = { rank: Number(above?.n ?? 0) + 1, score: Number(mine.score) }
      }
    }
    return { items: rows.map(toRankingItem), me }
  }
  const rows = await db.query(
    `SELECT user_id, user_name, user_login, icon_url, badge, best_score AS score, best_coins AS coins
       FROM pictor_run_scores ORDER BY best_score DESC, best_at LIMIT $1`,
    [limit]
  )
  let me = null
  if (userId) {
    const mine = await db.queryOne("SELECT best_score FROM pictor_run_scores WHERE user_id = $1", [userId])
    if (mine) {
      const above = await db.queryOne("SELECT COUNT(*) AS n FROM pictor_run_scores WHERE best_score > $1", [Number(mine.best_score)])
      me = { rank: Number(above?.n ?? 0) + 1, score: Number(mine.best_score) }
    }
  }
  return { items: rows.map(toRankingItem), me }
}
