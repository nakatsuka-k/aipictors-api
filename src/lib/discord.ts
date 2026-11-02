// @ts-nocheck -- このリポジトリの lib と同じく DB まわりは型なし
import { grantCoins } from "./coins"
import { getNow } from "./db"

/**
 * Discord 連携
 *
 * - 連携は OAuth2（identify）。本人確認にだけ使い、トークンは持たない（role_connections.write を許可したときだけ暗号化して持つ）
 * - 名前の横の表示は、サーバーのロールアイコンで出す（Discord に個人ごとのバナーの仕組みはない）。ニックネームは変えない
 * - 同期は 5 分ごとの cron と、連携・設定変更・実績の達成のときに行う
 */

export const DISCORD_API = "https://discord.com/api/v10"
export const DISCORD_GUILD_ID = "1069968879272595476"
/** 連携（OAuth2）に使う Discord アプリ「Aipictors」。公開クライアントなので secret はなく PKCE で確かめる */
export const DISCORD_APPLICATION_ID = "1566508809940115497"
/** ロールやニックネームを変えるボット（ぴくたーちゃん）。サーバーには前からこちらがいる */
export const DISCORD_BOT_USER_ID = "1306188881418391573"
// role_connections.write は公開クライアントでは invalid_scope になる。プロフィールへの表示には client secret が要る
export const DISCORD_OAUTH_SCOPES = "identify"

/** 連携ボーナス（1 人 1 回、1 つの Discord アカウントにつき 1 回） */
export const LINK_BONUS_FREE_COINS = 100
const LINK_BONUS_VALID_SECONDS = 7 * 24 * 60 * 60

/** お祝いを投稿する実績のランク（ゴールド以上） */
const CELEBRATE_MIN_TIER = 3
const CELEBRATE_MAX_PER_SYNC = 3

// 以前ニックネームに付けていた「✦Lv.42」。残っていたら外す
const NICK_SUFFIX_PATTERN = /\s*✦Lv\.\d+$/u

/** Discord のロールは 250 個まで。実績のロールはここまでにして、使われていないものから消す */
const ACHIEVEMENT_ROLE_LIMIT = 150

const TIER_COLORS = {
  1: 0xcd7f32,
  2: 0xb4c0cc,
  3: 0xf1c40f,
  4: 0x8fd3e8,
  5: 0x4fc3f7,
  6: 0xb14cff,
  7: 0xff4d6d,
}

/** レベルのバッジの色。そのレベルから上がこの色になる */
const LEVEL_TIERS = [
  { level: 1, tier: 1 },
  { level: 10, tier: 2 },
  { level: 20, tier: 3 },
  { level: 40, tier: 4 },
  { level: 60, tier: 5 },
  { level: 80, tier: 6 },
  { level: 100, tier: 7 },
]

export const toLevelTier = (level) => {
  let matched = LEVEL_TIERS[0].tier
  for (const item of LEVEL_TIERS) {
    if (level >= item.level) matched = item.tier
  }
  return matched
}

/** 作ったばかりのレベルのロールは、付ける前に消さないようしばらく残す */
const LEVEL_ROLE_GRACE_SECONDS = 60 * 60
const LEVEL_ROLE_REMOVE_PER_BATCH = 10

/** ニックネームから「✦Lv.42」を外す */
export const stripNickSuffix = (nick) => (nick ?? "").replace(NICK_SUFFIX_PATTERN, "")

/* ------------------------------------------------------------------ */
/* トークンの暗号化                                                    */
/* ------------------------------------------------------------------ */

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

const loadTokenKey = async (env) => {
  if (!env.DISCORD_TOKEN_KEY) throw new Error("DISCORD_TOKEN_KEY is not configured")
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.DISCORD_TOKEN_KEY))
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"])
}

export const encryptToken = async (env, value) => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await loadTokenKey(env)
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value))
  return `${toBase64(iv)}.${toBase64(new Uint8Array(encrypted))}`
}

export const decryptToken = async (env, value) => {
  const [iv, data] = value.split(".")
  const key = await loadTokenKey(env)
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, key, fromBase64(data))
  return new TextDecoder().decode(decrypted)
}

/* ------------------------------------------------------------------ */
/* Discord API                                                         */
/* ------------------------------------------------------------------ */

export class DiscordApiError extends Error {
  constructor(status, code, message) {
    super(`Discord API ${status}: ${message}`)
    this.status = status
    this.code = code
  }
}

export const discordFetch = async (props) => {
  const fetcher = props.fetch ?? fetch
  const headers = { "user-agent": "DiscordBot (https://www.aipictors.com, 1.0)" }
  if (props.auth) headers.authorization = props.auth
  if (props.reason) headers["x-audit-log-reason"] = encodeURIComponent(props.reason)
  if (props.body !== undefined) headers["content-type"] = "application/json"

  for (let attempt = 0; ; attempt++) {
    const response = await fetcher(`${DISCORD_API}${props.path}`, {
      method: props.method ?? "GET",
      headers,
      body: props.body === undefined ? undefined : JSON.stringify(props.body),
    })

    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 1)
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 5) * 1000))
      continue
    }
    if (response.status === 204) return null

    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!response.ok) {
      throw new DiscordApiError(response.status, json?.code ?? null, json?.message ?? text.slice(0, 200))
    }
    return json
  }
}

const botFetch = (env, props) =>
  discordFetch({ ...props, auth: `Bot ${env.DISCORD_BOT_TOKEN}`, fetch: env.__fetch })

const postOAuthToken = async (env, params) => {
  const fetcher = env.__fetch ?? fetch
  const response = await fetcher(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: DISCORD_APPLICATION_ID, ...params }),
  })
  const json = await response.json().catch(() => null)
  if (!response.ok) {
    throw new DiscordApiError(response.status, json?.error ?? null, json?.error_description ?? "token request failed")
  }
  return json
}

/* ------------------------------------------------------------------ */
/* Aipictors 側の情報（公開の GraphQL。非公開設定の人は返らない）       */
/* ------------------------------------------------------------------ */

const ACHIEVEMENT_QUERY = `query DiscordLinkAchievements($userId: ID!) {
  user(id: $userId) { id login name }
  achievementSummary(userId: $userId) { level points unlockedCount totalCount }
  achievements(userId: $userId) { key name tier isUnlocked isHidden unlockedAt }
}`

export const loadAchievementState = async (env, userId) => {
  const fetcher = env.__fetch ?? fetch
  const response = await fetcher(env.AIPICTORS_GRAPHQL_ENDPOINT ?? "https://api.aipictors.com/", {
    method: "POST",
    headers: { "content-type": "application/json", platform: "web", "user-agent": "aipictors-api discord-link" },
    body: JSON.stringify({ query: ACHIEVEMENT_QUERY, variables: { userId } }),
  })
  const json = await response.json()
  if (!response.ok || !json?.data) {
    throw new Error(`achievement query failed: ${response.status}`)
  }
  const summary = json.data.achievementSummary
  return {
    login: json.data.user?.login ?? null,
    name: json.data.user?.name ?? null,
    // 実績を他の人に見せない設定の人は null
    isVisible: summary !== null && summary !== undefined,
    level: summary?.level ?? 1,
    points: summary?.points ?? 0,
    unlockedCount: summary?.unlockedCount ?? 0,
    totalCount: summary?.totalCount ?? 0,
    unlocked: summary ? (json.data.achievements ?? []).filter((item) => item.isUnlocked) : [],
  }
}

/* ------------------------------------------------------------------ */
/* ロール                                                              */
/* ------------------------------------------------------------------ */

const fetchRoleIcon = async (env, path) => {
  const fetcher = env.__fetch ?? fetch
  const origin = env.ASSETS_ORIGIN ?? "https://assets.aipictors.com"
  const response = await fetcher(`${origin}/${path}`, { headers: { "user-agent": "aipictors-api discord-link" } })
  if (!response.ok) return null
  const bytes = new Uint8Array(await response.arrayBuffer())
  // data URL にするだけなので 1 文字ずつでよい（アイコンは数十 KB）
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:image/png;base64,${btoa(binary)}`
}

/**
 * 新しいロールを、ボットのロールのすぐ下に動かす。
 * レベルのロールは実績のロールより下に置く（アイコンは一番上のロールのものが出るので、実績を優先して見せるため）
 */
const moveRoleBelowBot = async (env, db, roleId, isBelowAchievements) => {
  const [roles, botMember, achievementRows] = await Promise.all([
    botFetch(env, { path: `/guilds/${DISCORD_GUILD_ID}/roles` }),
    botFetch(env, { path: `/guilds/${DISCORD_GUILD_ID}/members/${DISCORD_BOT_USER_ID}` }),
    isBelowAchievements ? db.query("SELECT role_id FROM discord_roles WHERE role_key LIKE 'achievement:%'") : [],
  ])
  const byId = new Map(roles.map((role) => [role.id, role]))
  const top = Math.max(...botMember.roles.map((id) => byId.get(id)?.position ?? 0))
  const achievementPositions = achievementRows
    .map((row) => byId.get(row.role_id)?.position)
    .filter((position) => position !== undefined)
  // 下から動かすと間のロールが 1 つずつ下がるので、1 つ下の番号を指定するとそのロールのすぐ下に入る
  const ceiling = achievementPositions.length > 0 ? Math.min(...achievementPositions) : top
  await botFetch(env, {
    method: "PATCH",
    path: `/guilds/${DISCORD_GUILD_ID}/roles`,
    body: [{ id: roleId, position: Math.max(1, ceiling - 1) }],
    reason: "Aipictors 連携のロール",
  })
}

const createRole = async (env, db, props) => {
  const icon = await fetchRoleIcon(env, props.iconPath)
  const role = await botFetch(env, {
    method: "POST",
    path: `/guilds/${DISCORD_GUILD_ID}/roles`,
    body: {
      name: props.name,
      color: TIER_COLORS[props.tier] ?? 0,
      permissions: "0",
      hoist: false,
      mentionable: false,
      ...(icon ? { icon } : {}),
    },
    reason: "Aipictors 連携のロール",
  })
  await moveRoleBelowBot(env, db, role.id, props.key.startsWith("level:"))
  await db.execute(
    `INSERT INTO discord_roles(role_key, role_id, name, created_at, last_used_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (role_key) DO UPDATE SET role_id = EXCLUDED.role_id, name = EXCLUDED.name, last_used_at = EXCLUDED.last_used_at`,
    [props.key, role.id, props.name, getNow()],
  )
  return role.id
}

const levelRoleKey = (level) => `level:${level}`
const achievementRoleKey = (key) => `achievement:${key}`

/** ロールが Discord 側で消されていたら作り直す */
const ensureRole = async (env, db, props) => {
  const row = await db.queryOne("SELECT role_id FROM discord_roles WHERE role_key = $1", [props.key])
  if (row) return row.role_id
  return createRole(env, db, props)
}

const ensureLevelRole = (env, db, level) =>
  ensureRole(env, db, {
    key: levelRoleKey(level),
    name: `Lv.${level}`,
    tier: toLevelTier(level),
    iconPath: `discord/level/${level}.png`,
  })

const ensureAchievementRole = async (env, db, achievement) => {
  const key = achievementRoleKey(achievement.key)
  const existing = await db.queryOne("SELECT role_id FROM discord_roles WHERE role_key = $1", [key])
  if (existing) return existing.role_id
  await removeUnusedAchievementRoles(env, db, ACHIEVEMENT_ROLE_LIMIT - 1)
  return createRole(env, db, {
    key,
    name: `🏅${achievement.name}`.slice(0, 100),
    tier: achievement.tier,
    iconPath: `achievements/badges-png/${achievement.key}.png`,
  })
}

/** 誰も選んでいない実績のロールを、古いものから消して limit 個以内にする */
export const removeUnusedAchievementRoles = async (env, db, limit) => {
  const counted = await db.queryOne(
    "SELECT COUNT(*)::INTEGER AS count FROM discord_roles WHERE role_key LIKE 'achievement:%'",
  )
  const overflow = (counted?.count ?? 0) - limit
  if (overflow <= 0) return 0
  const unused = await db.query(
    `SELECT r.role_key, r.role_id
       FROM discord_roles r
      WHERE r.role_key LIKE 'achievement:%'
        AND NOT EXISTS (
          SELECT 1 FROM discord_links l WHERE 'achievement:' || l.highlight_key = r.role_key
        )
      ORDER BY r.last_used_at ASC
      LIMIT $1`,
    [overflow],
  )
  for (const row of unused) {
    await botFetch(env, {
      method: "DELETE",
      path: `/guilds/${DISCORD_GUILD_ID}/roles/${row.role_id}`,
      reason: "Aipictors 連携: 使われていない実績のロール",
    }).catch(() => undefined)
    await db.execute("DELETE FROM discord_roles WHERE role_key = $1", [row.role_key])
  }
  return unused.length
}

/** 誰のレベルでもなくなったロールを消す。レベルごとに作るので、残すとロールの上限（250 個）に近づいていく */
export const removeUnusedLevelRoles = async (env, db, now = getNow()) => {
  const unused = await db.query(
    `SELECT r.role_key, r.role_id
       FROM discord_roles r
      WHERE r.role_key LIKE 'level:%'
        AND r.last_used_at < $1
        AND NOT EXISTS (
          SELECT 1 FROM discord_links l
           WHERE 'level:' || l.level = r.role_key
             AND l.in_guild = TRUE
             AND l.is_achievement_visible IS NOT FALSE
        )
      ORDER BY r.last_used_at ASC
      LIMIT $2`,
    [now - LEVEL_ROLE_GRACE_SECONDS, LEVEL_ROLE_REMOVE_PER_BATCH],
  )
  let removed = 0
  for (const row of unused) {
    try {
      await botFetch(env, {
        method: "DELETE",
        path: `/guilds/${DISCORD_GUILD_ID}/roles/${row.role_id}`,
        reason: "Aipictors 連携: 使われていないレベルのロール",
      })
    } catch (error) {
      // 消せなかったものは次回に回す（記録を消すと Discord に残ったままになる）
      if (!(error instanceof DiscordApiError) || error.status !== 404) continue
    }
    await db.execute("DELETE FROM discord_roles WHERE role_key = $1", [row.role_key])
    removed += 1
  }
  return removed
}

/* ------------------------------------------------------------------ */
/* 同期                                                                */
/* ------------------------------------------------------------------ */

const updateRoleConnection = async (env, link, state) => {
  if (!link.refresh_token_enc) return
  let accessToken = await decryptToken(env, link.access_token_enc)
  let tokens = null

  if (Number(link.token_expires_at) < getNow() + 60) {
    const refreshed = await postOAuthToken(env, {
      grant_type: "refresh_token",
      refresh_token: await decryptToken(env, link.refresh_token_enc),
    })
    accessToken = refreshed.access_token
    tokens = refreshed
  }

  await discordFetch({
    method: "PUT",
    path: `/users/@me/applications/${DISCORD_APPLICATION_ID}/role-connection`,
    auth: `Bearer ${accessToken}`,
    fetch: env.__fetch,
    body: {
      platform_name: "Aipictors",
      platform_username: state.name ?? state.login ?? "",
      // レベルと実績数の項目は、アプリのボットトークンで登録するまで送れない（setup を参照）
      ...(env.DISCORD_ROLE_METADATA_ENABLED === "1" && state.isVisible
        ? { metadata: { level: String(state.level), achievements: String(state.unlockedCount) } }
        : {}),
    },
  })
  return tokens
}

const postCelebrations = async (env, db, link, state, member) => {
  const channelId = env.DISCORD_CELEBRATION_CHANNEL_ID
  const since = Number(link.celebrated_until ?? link.created_at)
  const fresh = state.unlocked
    .filter((item) => !item.isHidden && Number(item.unlockedAt) > since && item.tier >= CELEBRATE_MIN_TIER)
    .sort((a, b) => b.tier - a.tier)
  if (!channelId || fresh.length === 0) return

  const shown = fresh.slice(0, CELEBRATE_MAX_PER_SYNC)
  const assets = env.ASSETS_ORIGIN ?? "https://assets.aipictors.com"
  await botFetch(env, {
    method: "POST",
    path: `/channels/${channelId}/messages`,
    body: {
      // 実績を達成した本人にも通知を飛ばさない
      allowed_mentions: { parse: [] },
      content: `<@${member.user.id}> さんが実績を達成しました！`,
      embeds: shown.map((item) => ({
        title: `🏅 ${item.name}`,
        color: TIER_COLORS[item.tier] ?? 0,
        thumbnail: { url: `${assets}/achievements/badges-png/${item.key}.png` },
        url: `https://www.aipictors.com/achievements?user=${link.user_id}&highlight=${item.key}`,
        footer: { text: `Lv.${state.level}・実績 ${state.unlockedCount}/${state.totalCount}` },
      })),
    },
  })
}

/**
 * 1 人分を Discord に反映する。サーバーにいない人は記録だけして、参加したときに反映する
 */
export const syncDiscordLink = async (env, db, link) => {
  const now = getNow()
  const state = await loadAchievementState(env, link.user_id)

  let member = null
  try {
    member = await botFetch(env, { path: `/guilds/${DISCORD_GUILD_ID}/members/${link.discord_user_id}` })
  } catch (error) {
    if (!(error instanceof DiscordApiError) || error.status !== 404) throw error
  }

  let celebratedUntil = link.celebrated_until
  const lastGlobalName = link.last_global_name ?? null

  if (member) {
    /* ロール */
    const managed = await db.query("SELECT role_key, role_id FROM discord_roles")
    const desired = new Set()
    if (state.isVisible) {
      desired.add(await ensureLevelRole(env, db, state.level))
      const highlight = state.unlocked.find((item) => item.key === link.highlight_key)
      if (highlight) {
        desired.add(await ensureAchievementRole(env, db, highlight))
      }
    }
    const managedIds = new Set(managed.map((row) => row.role_id))
    for (const roleId of member.roles) {
      if (managedIds.has(roleId) && !desired.has(roleId)) {
        await botFetch(env, {
          method: "DELETE",
          path: `/guilds/${DISCORD_GUILD_ID}/members/${link.discord_user_id}/roles/${roleId}`,
          reason: "Aipictors 連携",
        })
      }
    }
    for (const roleId of desired) {
      if (!member.roles.includes(roleId)) {
        await botFetch(env, {
          method: "PUT",
          path: `/guilds/${DISCORD_GUILD_ID}/members/${link.discord_user_id}/roles/${roleId}`,
          reason: "Aipictors 連携",
        }).catch(async (error) => {
          // Discord 側でロールが消えていたら記録を消す。次の同期で作り直す
          if (error instanceof DiscordApiError && error.code === 10011) {
            await db.execute("DELETE FROM discord_roles WHERE role_id = $1", [roleId])
          }
          throw error
        })
      }
    }

    /* 以前付けた「✦Lv」が残っていたら外す */
    const strippedNick = stripNickSuffix(member.nick)
    if (member.nick && strippedNick !== member.nick) {
      const globalName = member.user.global_name ?? member.user.username
      const isFollowingGlobal = strippedNick === globalName || strippedNick === lastGlobalName
      await botFetch(env, {
        method: "PATCH",
        path: `/guilds/${DISCORD_GUILD_ID}/members/${link.discord_user_id}`,
        body: { nick: isFollowingGlobal ? null : strippedNick },
        reason: "Aipictors 連携",
      }).catch(() => undefined)
    }

    /* 実績のお祝い（希望した人だけ） */
    if (link.celebrate && state.isVisible) {
      await postCelebrations(env, db, link, state, member).catch((error) => {
        console.log(JSON.stringify({ event: "discord.celebrate.failed", message: error.message }))
      })
    }
    celebratedUntil = now
  }

  /* プロフィールの接続先の表示（レベルが変わったときだけ） */
  let tokens = null
  let hasValidToken = link.refresh_token_enc !== null
  if (hasValidToken && (link.level !== state.level || link.unlocked_count !== state.unlockedCount || !link.synced_at)) {
    try {
      tokens = await updateRoleConnection(env, link, state)
    } catch (error) {
      // 本人が Discord 側で連携を取り消した等。ロールとニックネームはボットの権限で続けられる
      hasValidToken = false
      console.log(JSON.stringify({ event: "discord.role_connection.failed", message: error.message }))
    }
  }

  await db.execute(
    `UPDATE discord_links
        SET in_guild = $2,
            level = $3,
            unlocked_count = $4,
            is_achievement_visible = $5,
            celebrated_until = $6,
            aipictors_name = $7,
            aipictors_login = $8,
            access_token_enc = COALESCE($9, access_token_enc),
            refresh_token_enc = CASE WHEN $12 THEN COALESCE($10, refresh_token_enc) ELSE NULL END,
            token_expires_at = COALESCE($11, token_expires_at),
            sync_requested_at = NULL,
            sync_error = NULL,
            synced_at = $13,
            updated_at = $13
      WHERE user_id = $1`,
    [
      link.user_id,
      member !== null,
      state.level,
      state.unlockedCount,
      state.isVisible,
      celebratedUntil,
      state.name,
      state.login,
      tokens ? await encryptToken(env, tokens.access_token) : null,
      tokens ? await encryptToken(env, tokens.refresh_token) : null,
      tokens ? now + Number(tokens.expires_in) : null,
      hasValidToken,
      now,
    ],
  )
  return { inGuild: member !== null, level: state.level }
}

const recordSyncError = async (db, userId, error) => {
  await db.execute(
    "UPDATE discord_links SET sync_error = $2, synced_at = $3 WHERE user_id = $1",
    [userId, String(error?.message ?? error).slice(0, 300), getNow()],
  )
}

/** 頼まれている人を先に、残りは前回の同期が古い順に */
export const runDiscordSyncBatch = async (env, db, limit) => {
  const links = await db.query(
    `SELECT * FROM discord_links
      ORDER BY (sync_requested_at IS NULL) ASC, synced_at ASC NULLS FIRST
      LIMIT $1`,
    [limit],
  )
  let synced = 0
  let failed = 0
  for (const link of links) {
    try {
      await syncDiscordLink(env, db, link)
      synced += 1
    } catch (error) {
      failed += 1
      await recordSyncError(db, link.user_id, error)
      console.log(JSON.stringify({ event: "discord.sync.failed", message: String(error?.message ?? error) }))
    }
  }
  await removeUnusedLevelRoles(env, db).catch((error) => {
    console.log(JSON.stringify({ event: "discord.level_roles.remove_failed", message: String(error?.message ?? error) }))
  })
  return { synced, failed }
}

export const syncDiscordLinkByUserId = async (env, db, userId) => {
  const link = await db.queryOne("SELECT * FROM discord_links WHERE user_id = $1", [userId])
  if (!link) return null
  try {
    return await syncDiscordLink(env, db, link)
  } catch (error) {
    await recordSyncError(db, userId, error)
    throw error
  }
}

/* ------------------------------------------------------------------ */
/* 連携・解除                                                          */
/* ------------------------------------------------------------------ */

/** 連携ボーナス。ユーザーでも Discord アカウントでも 1 回だけ（解除と連携を繰り返しても増えない） */
const grantLinkBonus = async (db, userId, discordUserId) => {
  const now = getNow()
  const rows = await db.query(
    `INSERT INTO discord_link_bonuses(user_id, discord_user_id, free_coins, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING user_id`,
    [userId, discordUserId, LINK_BONUS_FREE_COINS, now],
  )
  if (rows.length === 0) return 0
  await grantCoins({
    db,
    userId,
    freeCoins: LINK_BONUS_FREE_COINS,
    premiumCoins: 0,
    kind: "GRANT",
    reason: "Discord 連携ボーナス",
    source: "discord-link",
    now,
    expiresAt: now + LINK_BONUS_VALID_SECONDS,
  })
  return LINK_BONUS_FREE_COINS
}

const revokeToken = async (env, token) => {
  const fetcher = env.__fetch ?? fetch
  await fetcher(`${DISCORD_API}/oauth2/token/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: DISCORD_APPLICATION_ID,
      token,
      token_type_hint: "refresh_token",
    }),
  }).catch(() => undefined)
}

export const linkDiscordAccount = async (env, db, props) => {
  const tokens = await postOAuthToken(env, {
    grant_type: "authorization_code",
    code: props.code,
    redirect_uri: props.redirectUri,
    code_verifier: props.codeVerifier,
  })
  const me = await discordFetch({
    path: "/users/@me",
    auth: `Bearer ${tokens.access_token}`,
    fetch: env.__fetch,
  })

  const taken = await db.queryOne(
    "SELECT user_id FROM discord_links WHERE discord_user_id = $1 AND user_id <> $2",
    [me.id, props.userId],
  )
  if (taken) {
    return { ok: false, code: "DISCORD_ALREADY_LINKED" }
  }

  const now = getNow()
  const previous = await db.queryOne("SELECT discord_user_id FROM discord_links WHERE user_id = $1", [props.userId])
  if (previous && previous.discord_user_id !== me.id) {
    return { ok: false, code: "USER_ALREADY_LINKED" }
  }

  // 本人確認にしか使わないトークンは持たずに取り消す
  const keepsTokens = String(tokens.scope ?? "").split(" ").includes("role_connections.write")
  if (!keepsTokens) {
    await revokeToken(env, tokens.refresh_token)
  }

  await db.execute(
    `INSERT INTO discord_links(
       user_id, discord_user_id, discord_username, discord_global_name, discord_avatar,
       access_token_enc, refresh_token_enc, token_expires_at, sync_requested_at, created_at, updated_at, celebrated_until
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9, $9)
     ON CONFLICT (user_id) DO UPDATE SET
       discord_username = EXCLUDED.discord_username,
       discord_global_name = EXCLUDED.discord_global_name,
       discord_avatar = EXCLUDED.discord_avatar,
       access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       token_expires_at = EXCLUDED.token_expires_at,
       sync_requested_at = EXCLUDED.sync_requested_at,
       updated_at = EXCLUDED.updated_at`,
    [
      props.userId,
      me.id,
      me.username,
      me.global_name ?? null,
      me.avatar ?? null,
      keepsTokens ? await encryptToken(env, tokens.access_token) : null,
      keepsTokens ? await encryptToken(env, tokens.refresh_token) : null,
      keepsTokens ? now + Number(tokens.expires_in) : null,
      now,
    ],
  )

  const bonusCoins = await grantLinkBonus(db, props.userId, me.id)
  await syncDiscordLinkByUserId(env, db, props.userId).catch(() => undefined)
  return { ok: true, bonusCoins }
}

/** ロールとニックネームを元に戻して、連携の記録を消す（ボーナスの記録は残す） */
export const unlinkDiscordAccount = async (env, db, userId) => {
  const link = await db.queryOne("SELECT * FROM discord_links WHERE user_id = $1", [userId])
  if (!link) return { ok: true }

  try {
    const member = await botFetch(env, { path: `/guilds/${DISCORD_GUILD_ID}/members/${link.discord_user_id}` })
    const managed = await db.query("SELECT role_id FROM discord_roles")
    const managedIds = new Set(managed.map((row) => row.role_id))
    for (const roleId of member.roles) {
      if (managedIds.has(roleId)) {
        await botFetch(env, {
          method: "DELETE",
          path: `/guilds/${DISCORD_GUILD_ID}/members/${link.discord_user_id}/roles/${roleId}`,
          reason: "Aipictors 連携の解除",
        })
      }
    }
    const stripped = stripNickSuffix(member.nick)
    if (member.nick && stripped !== member.nick) {
      const globalName = member.user.global_name ?? member.user.username
      const isFollowingGlobal = stripped === globalName || stripped === link.last_global_name
      await botFetch(env, {
        method: "PATCH",
        path: `/guilds/${DISCORD_GUILD_ID}/members/${link.discord_user_id}`,
        body: { nick: isFollowingGlobal ? null : stripped },
        reason: "Aipictors 連携の解除",
      }).catch(() => undefined)
    }
  } catch (error) {
    if (!(error instanceof DiscordApiError) || error.status !== 404) {
      throw error
    }
  }

  if (link.refresh_token_enc) {
    await revokeToken(env, await decryptToken(env, link.refresh_token_enc))
  }

  await db.execute("DELETE FROM discord_links WHERE user_id = $1", [userId])
  return { ok: true }
}

export const toDiscordStatus = async (db, userId) => {
  const link = await db.queryOne("SELECT * FROM discord_links WHERE user_id = $1", [userId])
  const bonus = await db.queryOne("SELECT free_coins FROM discord_link_bonuses WHERE user_id = $1", [userId])
  return {
    isLinked: link !== null,
    bonusCoins: LINK_BONUS_FREE_COINS,
    hasReceivedBonus: bonus !== null,
    link: link
      ? {
          discordUserId: link.discord_user_id,
          username: link.discord_username,
          globalName: link.discord_global_name,
          avatar: link.discord_avatar,
          isInGuild: link.in_guild === true,
          level: link.level,
          unlockedCount: link.unlocked_count,
          isAchievementVisible: link.is_achievement_visible !== false,
          highlightKey: link.highlight_key,
          celebrate: link.celebrate,
          expiryDm: link.expiry_dm,
          syncedAt: link.synced_at === null ? null : Number(link.synced_at),
          syncError: link.sync_error !== null,
          isProfileConnected: link.refresh_token_enc !== null,
        }
      : null,
  }
}

export const updateDiscordSettings = async (db, props) => {
  await db.execute(
    `UPDATE discord_links
        SET celebrate = COALESCE($2, celebrate),
            expiry_dm = COALESCE($3, expiry_dm),
            highlight_key = CASE WHEN $4 THEN $5 ELSE highlight_key END,
            sync_requested_at = $6,
            updated_at = $6
      WHERE user_id = $1`,
    [
      props.userId,
      props.celebrate ?? null,
      props.expiryDm ?? null,
      props.highlightKey !== undefined,
      props.highlightKey ?? null,
      getNow(),
    ],
  )
}

/* ------------------------------------------------------------------ */
/* 準備（最初に 1 回。何度実行してもよい）                               */
/* ------------------------------------------------------------------ */

export const setupDiscordIntegration = async (env, db) => {
  // プロフィールのレベル表示には Aipictors アプリのボットトークンが要る（なくても連携そのものは動く）
  if (env.DISCORD_OAUTH_APP_BOT_TOKEN) {
  await discordFetch({
    auth: `Bot ${env.DISCORD_OAUTH_APP_BOT_TOKEN}`,
    fetch: env.__fetch,
    method: "PUT",
    path: `/applications/${DISCORD_APPLICATION_ID}/role-connections/metadata`,
    body: [
      {
        type: 2,
        key: "level",
        name: "Achievement level",
        name_localizations: { ja: "実績レベル" },
        description: "Aipictors achievement level",
        description_localizations: { ja: "Aipictors の実績レベル" },
      },
      {
        type: 2,
        key: "achievements",
        name: "Achievements",
        name_localizations: { ja: "達成した実績" },
        description: "Number of unlocked achievements",
        description_localizations: { ja: "達成した実績の数" },
      },
    ],
  })
  }

  // レベルのロールは、そのレベルの人が出たときに作る
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* コインの失効前のお知らせ（希望した人に DM）                           */
/* ------------------------------------------------------------------ */

/**
 * 48 時間以内に失効するコインをお知らせする。その日のうちに失効する毎日のコインは、
 * 毎日出ると邪魔なので対象にしない。1 人 1 日 1 回まで
 */
export const sendCoinExpiryDms = async (env, db, now = getNow()) => {
  const dateKey = new Date((now + 9 * 3600) * 1000).toISOString().slice(0, 10)
  const rows = await db.query(
    `SELECT l.user_id, l.discord_user_id,
            SUM(CASE WHEN c.coin_type = 'FREE' THEN c.remaining ELSE 0 END)::INTEGER AS free_coins,
            SUM(CASE WHEN c.coin_type = 'PREMIUM' THEN c.remaining ELSE 0 END)::INTEGER AS premium_coins,
            MIN(c.expires_at) AS expires_at
       FROM discord_links l
       JOIN coin_lots c ON c.user_id = l.user_id
      WHERE l.expiry_dm = TRUE
        AND c.remaining > 0
        AND c.expires_at > $1
        AND c.expires_at <= $1 + 172800
        AND c.expires_at - c.created_at > 86400
        AND NOT EXISTS (
          SELECT 1 FROM discord_expiry_notices n WHERE n.user_id = l.user_id AND n.date_key = $2
        )
      GROUP BY l.user_id, l.discord_user_id
      LIMIT 40`,
    [now, dateKey],
  )

  let sent = 0
  for (const row of rows) {
    const parts = []
    if (row.free_coins > 0) parts.push(`フリーコイン ${row.free_coins.toLocaleString()} 枚`)
    if (row.premium_coins > 0) parts.push(`プレミアムコイン ${row.premium_coins.toLocaleString()} 枚`)
    await db.execute(
      "INSERT INTO discord_expiry_notices(user_id, date_key, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [row.user_id, dateKey, now],
    )
    try {
      const channel = await botFetch(env, {
        method: "POST",
        path: "/users/@me/channels",
        body: { recipient_id: row.discord_user_id },
      })
      await botFetch(env, {
        method: "POST",
        path: `/channels/${channel.id}/messages`,
        body: {
          content: `🪙 ${parts.join("・")}がまもなく失効します（<t:${Number(row.expires_at)}:R>）。\n生成や推しに使ってね → https://www.aipictors.com/generation\n\nお知らせの設定: https://www.aipictors.com/settings/discord`,
        },
      })
      sent += 1
    } catch (error) {
      // DM を受け取らない設定の人など
      console.log(JSON.stringify({ event: "discord.expiry_dm.failed", message: String(error?.message ?? error) }))
    }
  }
  return { sent, targets: rows.length }
}
