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
  return { error: null, message: toMessage(row) }
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
  return { error: null, data: { best, isNewBest, rank: Number(above?.n ?? 0) + 1 } }
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
      `SELECT p.user_id, MAX(p.score) AS score, s.user_name, s.user_login, s.icon_url, s.badge, 0 AS coins
         FROM pictor_run_plays p JOIN pictor_run_scores s ON s.user_id = p.user_id
        WHERE p.created_at >= $1
        GROUP BY p.user_id ORDER BY score DESC, MIN(p.created_at) LIMIT $2`,
      [since, limit]
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
