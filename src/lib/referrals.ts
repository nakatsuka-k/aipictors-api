// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { applyCoinDelta } from "./coins"
import { getNow } from "./db"
import { getNumber, getString } from "./record-fields"

/**
 * 紹介特典
 * - 紹介する人は自分の紹介リンク（/?ref=<コード>）を配る。リンクから来て新しく登録した人（紹介された人）に 300 フリーコイン
 * - 紹介した人には、紹介された人がはじめて生成するか作品を投稿すると 300、はじめてプランの支払い（¥1 以上）をすると 2,000 フリーコイン
 * - フリーコインは実績のコインと同じ 7 日有効
 * - 自分自身は不可・登録したばかりのアカウントだけ・同じ組み合わせは 1 回だけ・紹介した人が受け取れるのは月 20 人分まで・
 *   同じ端末 / 同じ IP からの量産は弾く。弾いた分は referral_rejections に残す
 */
export var REFERRAL_REWARDS = { signup: 300, action: 300, paid: 2000 }
export var REFERRAL_MONTHLY_LIMIT = 20
// 「リンクから来て新しく登録した人」: 登録から 72 時間以内のアカウントだけひも付ける
export var REFERRAL_NEW_ACCOUNT_SECONDS = 72 * 3600
export var REFERRAL_COIN_TTL_SECONDS = 7 * 86400
// 同じ紹介者の紹介で、同じ IP から登録できる人数（家族・同じ建物などを考えて 2 人まで）
export var REFERRAL_MAX_PER_IP = 2
// はじめての生成・投稿を確かめる期間（登録からこれを過ぎた紹介は確かめない）
var ACTION_CHECK_WINDOW_SECONDS = 90 * 86400

var CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
var CODE_LENGTH = 8
export var isReferralCode = (value) => typeof value === "string" && /^[a-z0-9]{6,16}$/.test(value)

var newCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH))
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("")
}

/** IP はそのまま持たず、内部トークンを混ぜたハッシュだけを持つ */
export var hashIp = async (env, ip) => {
  if (typeof ip !== "string" || ip.length === 0) return null
  const salt = env?.INTERNAL_API_TOKEN ?? env?.AIPICTORS_API_INTERNAL_TOKEN ?? ""
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`referral:${salt}:${ip}`))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)
}

var toDeviceId = (value) => (typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null)

/** 月の区切りは日本時間 */
export var jstMonthStart = (now) => {
  const jst = new Date((now + 9 * 3600) * 1e3)
  return Math.floor(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1) / 1e3) - 9 * 3600
}

/** 自分の紹介コード（なければ作る）。紹介ページを開いたときの端末と IP も覚える */
export var ensureReferralCode = async (db, userId, seen = {}) => {
  const existing = await db.queryOne("SELECT * FROM referral_codes WHERE user_id = $1", [String(userId)])
  if (existing) {
    const deviceId = toDeviceId(seen.deviceId)
    if ((deviceId && deviceId !== existing.device_id) || (seen.ipHash && seen.ipHash !== existing.ip_hash)) {
      await db.execute(
        "UPDATE referral_codes SET device_id = coalesce($2, device_id), ip_hash = coalesce($3, ip_hash) WHERE user_id = $1",
        [String(userId), deviceId, seen.ipHash ?? null]
      )
    }
    return getString(existing, "code")
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newCode()
    const result = await db.executeResult(
      `INSERT INTO referral_codes(user_id, code, device_id, ip_hash, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [String(userId), code, toDeviceId(seen.deviceId), seen.ipHash ?? null, getNow()]
    )
    if (result.rowCount > 0) return code
    // 同時に作られた（user_id の重複）ならそれを使う。コードの重複なら作り直す
    const row = await db.queryOne("SELECT code FROM referral_codes WHERE user_id = $1", [String(userId)])
    if (row) return getString(row, "code")
  }
  throw new Error("Failed to create referral code")
}

var reject = async (db, props) => {
  await db.execute(
    `INSERT INTO referral_rejections(referrer_user_id, referred_user_id, code, reason, device_id, ip_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [props.referrerUserId ?? null, String(props.referredUserId), props.code ?? null, props.reason, props.deviceId ?? null, props.ipHash ?? null, getNow()]
  )
  console.log(JSON.stringify({ event: "referral.rejected", reason: props.reason, referrerUserId: props.referrerUserId ?? null, referredUserId: String(props.referredUserId) }))
}

/** フリーコインを 7 日有効で付ける。その場にいない人（紹介した人）には、次に開いたときのお知らせも残す */
var grantReferralCoins = async (db, props) => {
  const now = getNow()
  await applyCoinDelta({
    db,
    userId: String(props.userId),
    freeDelta: props.amount,
    premiumDelta: 0,
    kind: "GRANT",
    reason: props.reason,
    source: props.source,
    expiresAt: now + REFERRAL_COIN_TTL_SECONDS
  })
  if (props.notify) {
    await db.execute(
      `INSERT INTO coin_pending_events(user_id, kind, message, free_coins, premium_coins, created_at)
       VALUES ($1, 'GRANT', $2, $3, 0, $4)`,
      [String(props.userId), `🎁 ${props.reason}: フリーコイン${props.amount}枚が付与されました（7日間有効）。`, props.amount, now]
    )
  }
}

/** アカウントの登録時刻（UNIX 秒）。aipictors-system の core（wp_users）から読む */
export var getUserRegisteredAt = async (core, userId) => {
  if (!core) return null
  const row = await core.prepare("SELECT user_registered FROM wp_users WHERE ID = ? AND is_deleted = 0").bind(Number(userId)).first()
  const time = row?.user_registered ? Date.parse(String(row.user_registered)) : Number.NaN
  return Number.isFinite(time) ? Math.floor(time / 1e3) : null
}

/** 2 人が同じ IP で使ったことがあるか（aipictors-system の ip_bindings） */
export var hasSharedIpBinding = async (core, userIdA, userIdB) => {
  if (!core) return false
  const row = await core
    .prepare("SELECT 1 AS hit FROM ip_bindings a JOIN ip_bindings b ON b.ip = a.ip WHERE a.user_id = ? AND b.user_id = ? LIMIT 1")
    .bind(Number(userIdA), Number(userIdB))
    .first()
  return row !== null && row !== undefined
}

/**
 * 登録した人を紹介コードにひも付けて、登録の特典を付ける。
 * 返す reason: attached / already（ひも付け済み）/ unknown_code / self / not_new_account / same_device / same_ip
 * retry が true のときだけ、あとでもう一度試してよい（一時的な失敗）
 */
export var attachReferral = async (props) => {
  const { db, core, env } = props
  const userId = String(props.userId)
  const code = typeof props.code === "string" ? props.code.trim().toLowerCase() : ""
  const deviceId = toDeviceId(props.deviceId)
  const ipHash = await hashIp(env, props.ip)
  const existing = await db.queryOne("SELECT id FROM referrals WHERE referred_user_id = $1", [userId])
  if (existing) return { attached: false, reason: "already", grantedCoins: 0 }
  if (!isReferralCode(code)) return { attached: false, reason: "unknown_code", grantedCoins: 0 }
  const owner = await db.queryOne("SELECT * FROM referral_codes WHERE code = $1", [code])
  if (!owner) {
    await reject(db, { referredUserId: userId, code, reason: "unknown_code", deviceId, ipHash })
    return { attached: false, reason: "unknown_code", grantedCoins: 0 }
  }
  const referrerUserId = getString(owner, "user_id")
  const base = { referrerUserId, referredUserId: userId, code, deviceId, ipHash }
  if (referrerUserId === userId) {
    await reject(db, { ...base, reason: "self" })
    return { attached: false, reason: "self", grantedCoins: 0 }
  }
  // 弾いたことがある組み合わせは、同じ理由を何度も記録しない
  const rejectedBefore = await db.queryOne(
    "SELECT reason FROM referral_rejections WHERE referred_user_id = $1 AND referrer_user_id = $2 AND reason <> 'monthly_limit' LIMIT 1",
    [userId, referrerUserId]
  )
  if (rejectedBefore) return { attached: false, reason: getString(rejectedBefore, "reason"), grantedCoins: 0 }
  const now = getNow()
  const registeredAt = await getUserRegisteredAt(core, userId)
  if (registeredAt === null) {
    // 登録時刻が読めない（core につながらない・まだ書かれていない）ときは付けずに、あとでもう一度試してもらう
    return { attached: false, reason: "not_ready", grantedCoins: 0, retry: true }
  }
  if (now - registeredAt > REFERRAL_NEW_ACCOUNT_SECONDS) {
    await reject(db, { ...base, reason: "not_new_account" })
    return { attached: false, reason: "not_new_account", grantedCoins: 0 }
  }
  // 同じ端末（紹介した人の端末・この紹介者の別の紹介と同じ端末）
  if (deviceId) {
    const sameDevice =
      owner.device_id === deviceId ||
      (await db.queryOne("SELECT id FROM referrals WHERE referrer_user_id = $1 AND device_id = $2 LIMIT 1", [referrerUserId, deviceId])) !== null
    if (sameDevice) {
      await reject(db, { ...base, reason: "same_device" })
      return { attached: false, reason: "same_device", grantedCoins: 0 }
    }
  }
  // 同じ IP（紹介した人の IP・この紹介者の紹介で同じ IP が上限まで来ている・生成で同じ IP を使ったことがある）
  if (ipHash) {
    const sameIpCount = await db.queryOne("SELECT count(*) AS count FROM referrals WHERE referrer_user_id = $1 AND ip_hash = $2", [referrerUserId, ipHash])
    if (owner.ip_hash === ipHash || Number(sameIpCount?.count ?? 0) >= REFERRAL_MAX_PER_IP) {
      await reject(db, { ...base, reason: "same_ip" })
      return { attached: false, reason: "same_ip", grantedCoins: 0 }
    }
  }
  if (await hasSharedIpBinding(core, referrerUserId, userId)) {
    await reject(db, { ...base, reason: "ip_overlap" })
    return { attached: false, reason: "ip_overlap", grantedCoins: 0 }
  }
  // 紹介した人が受け取れるのは月 20 人分まで。超えた分は紹介された人の特典だけ付ける
  const monthly = await db.queryOne(
    "SELECT count(*) AS count FROM referrals WHERE referrer_user_id = $1 AND referrer_capped = 0 AND created_at >= $2",
    [referrerUserId, jstMonthStart(now)]
  )
  const capped = Number(monthly?.count ?? 0) >= REFERRAL_MONTHLY_LIMIT
  const inserted = await db.executeResult(
    `INSERT INTO referrals(referrer_user_id, referred_user_id, code, status, referrer_capped, device_id, ip_hash, signup_rewarded_at, created_at)
     VALUES ($1, $2, $3, 'attached', $4, $5, $6, $7, $7)
     ON CONFLICT (referred_user_id) DO NOTHING`,
    [referrerUserId, userId, code, capped ? 1 : 0, deviceId, ipHash, now]
  )
  if (inserted.rowCount === 0) return { attached: false, reason: "already", grantedCoins: 0 }
  if (capped) await reject(db, { ...base, reason: "monthly_limit" })
  await grantReferralCoins(db, {
    userId,
    amount: REFERRAL_REWARDS.signup,
    reason: "紹介リンクからの登録特典",
    source: `referral_signup:${userId}`
  })
  console.log(JSON.stringify({ event: "referral.attached", referrerUserId, referredUserId: userId, capped }))
  return { attached: true, reason: "attached", grantedCoins: REFERRAL_REWARDS.signup }
}

/** 紹介した人に特典を付ける前の確認。生成で同じ IP を使っていたら、この紹介を無効にする */
var rejectIfSharedIp = async (db, core, referral) => {
  if (!(await hasSharedIpBinding(core, referral.referrer_user_id, referral.referred_user_id))) return false
  const result = await db.executeResult("UPDATE referrals SET status = 'rejected' WHERE id = $1 AND status = 'attached'", [referral.id])
  if (result.rowCount > 0) {
    await reject(db, {
      referrerUserId: referral.referrer_user_id,
      referredUserId: referral.referred_user_id,
      code: referral.code,
      reason: "ip_overlap",
      deviceId: referral.device_id,
      ipHash: referral.ip_hash
    })
  }
  return true
}

/**
 * 紹介された人のはじめての生成・投稿を確かめて、紹介した人に特典を付ける（5 分ごとの定期処理と、紹介ページを開いたとき）
 * referrerUserId を渡すとその人の紹介だけ確かめる
 */
export var grantReferralActionRewards = async (props) => {
  const { db, genlog, core } = props
  const now = getNow()
  // 定期処理では、登録から 2 日以内の紹介は毎回、それより古い紹介は 6 時間おきに確かめる（動かない人を毎回確かめ続けない）
  const pending = props.referrerUserId
    ? await db.query(
        `SELECT * FROM referrals
          WHERE action_rewarded_at IS NULL AND status = 'attached' AND referrer_capped = 0 AND created_at >= $1
            AND referrer_user_id = $2
          ORDER BY created_at DESC LIMIT ${props.limit ?? 200}`,
        [now - ACTION_CHECK_WINDOW_SECONDS, String(props.referrerUserId)]
      )
    : await db.query(
        `SELECT * FROM referrals
          WHERE action_rewarded_at IS NULL AND status = 'attached' AND referrer_capped = 0 AND created_at >= $1
            AND (action_checked_at IS NULL OR created_at >= $2 OR action_checked_at < $3)
          ORDER BY coalesce(action_checked_at, 0) ASC LIMIT ${props.limit ?? 200}`,
        [now - ACTION_CHECK_WINDOW_SECONDS, now - 2 * 86400, now - 6 * 3600]
      )
  if (pending.length === 0) return { checked: 0, granted: 0 }
  const ids = pending.map((row) => Number(row.referred_user_id)).filter((id) => Number.isFinite(id))
  const idsJson = JSON.stringify(ids)
  const [generated, results, posted] = await Promise.all([
    genlog
      ? genlog.query("SELECT DISTINCT user_id FROM generated_queues WHERE user_id IN (SELECT value FROM json_each($1)) AND status = 'generated'", [idsJson])
      : [],
    genlog ? genlog.query("SELECT DISTINCT user_id FROM image_generation_results WHERE user_id IN (SELECT value FROM json_each($1))", [idsJson]) : [],
    core
      ? core
          .prepare("SELECT DISTINCT userId AS user_id FROM works WHERE userId IN (SELECT value FROM json_each(?))")
          .bind(idsJson)
          .all()
          .then((result) => result.results ?? [])
      : []
  ])
  await db.execute("UPDATE referrals SET action_checked_at = $2 WHERE id IN (SELECT value FROM json_each($1))", [
    JSON.stringify(pending.map((row) => row.id)),
    now
  ])
  const generatedIds = new Set([...generated, ...results].map((row) => String(row.user_id)))
  const postedIds = new Set(posted.map((row) => String(row.user_id)))
  let granted = 0
  for (const referral of pending) {
    const referredUserId = String(referral.referred_user_id)
    const kind = generatedIds.has(referredUserId) ? "generation" : postedIds.has(referredUserId) ? "post" : null
    if (kind === null) continue
    if (await rejectIfSharedIp(db, core, referral)) continue
    // 先に印を付ける（同時に動いても 1 回だけ付く）
    const claimed = await db.executeResult(
      "UPDATE referrals SET action_rewarded_at = $2, action_kind = $3 WHERE id = $1 AND action_rewarded_at IS NULL AND status = 'attached'",
      [referral.id, now, kind]
    )
    if (claimed.rowCount === 0) continue
    try {
      await grantReferralCoins(db, {
        userId: referral.referrer_user_id,
        amount: REFERRAL_REWARDS.action,
        reason: kind === "generation" ? "紹介特典（紹介した人がはじめて生成）" : "紹介特典（紹介した人がはじめて投稿）",
        source: `referral_action:${referral.id}`,
        notify: true
      })
      granted += 1
    } catch (error) {
      // 付けられなかったら印を戻して、次の回でもう一度試す
      await db.execute("UPDATE referrals SET action_rewarded_at = NULL, action_kind = NULL WHERE id = $1", [referral.id])
      console.error("[referrals] failed to grant action reward", { referralId: referral.id, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { checked: pending.length, granted }
}

/**
 * 紹介された人のはじめてのプランの支払い（¥1 以上の請求の成功・自動更新なしのパスの購入）で、紹介した人に特典を付ける。
 * 無料お試しの開始（¥0）では呼ばない
 */
export var grantReferralPaidReward = async (props) => {
  const { db, core } = props
  const referral = await db.queryOne(
    "SELECT * FROM referrals WHERE referred_user_id = $1 AND paid_rewarded_at IS NULL AND status = 'attached' AND referrer_capped = 0",
    [String(props.userId)]
  )
  if (!referral) return { granted: false }
  if (await rejectIfSharedIp(db, core ?? null, referral).catch(() => false)) return { granted: false }
  const now = getNow()
  const claimed = await db.executeResult(
    "UPDATE referrals SET paid_rewarded_at = $2 WHERE id = $1 AND paid_rewarded_at IS NULL AND status = 'attached'",
    [referral.id, now]
  )
  if (claimed.rowCount === 0) return { granted: false }
  try {
    await grantReferralCoins(db, {
      userId: referral.referrer_user_id,
      amount: REFERRAL_REWARDS.paid,
      reason: "紹介特典（紹介した人がプランに加入）",
      source: `referral_paid:${referral.id}`,
      notify: true
    })
  } catch (error) {
    await db.execute("UPDATE referrals SET paid_rewarded_at = NULL WHERE id = $1", [referral.id])
    throw error
  }
  console.log(JSON.stringify({ event: "referral.paid_reward", referrerUserId: referral.referrer_user_id, referredUserId: String(props.userId) }))
  return { granted: true }
}

/** 紹介ページに出す内容（自分のコード・これまでの人数と受け取ったコイン・今月の残り） */
export var getReferralSummary = async (db, userId, code) => {
  const now = getNow()
  const [totals, asReferred] = await Promise.all([
    db.queryOne(
      `SELECT count(*) AS invited,
              count(*) FILTER (WHERE action_rewarded_at IS NOT NULL) AS action_count,
              count(*) FILTER (WHERE paid_rewarded_at IS NOT NULL) AS paid_count,
              count(*) FILTER (WHERE referrer_capped = 0 AND created_at >= $2) AS monthly_used
         FROM referrals WHERE referrer_user_id = $1 AND status = 'attached'`,
      [String(userId), jstMonthStart(now)]
    ),
    // 紹介された側として特典を受け取ったか
    db.queryOne("SELECT signup_rewarded_at FROM referrals WHERE referred_user_id = $1", [String(userId)])
  ])
  const actionCount = Number(totals?.action_count ?? 0)
  const paidCount = Number(totals?.paid_count ?? 0)
  return {
    code,
    rewards: REFERRAL_REWARDS,
    coinTtlDays: REFERRAL_COIN_TTL_SECONDS / 86400,
    monthlyLimit: REFERRAL_MONTHLY_LIMIT,
    monthlyUsed: Number(totals?.monthly_used ?? 0),
    invitedCount: Number(totals?.invited ?? 0),
    actionCount,
    paidCount,
    coinsEarned: actionCount * REFERRAL_REWARDS.action + paidCount * REFERRAL_REWARDS.paid,
    wasReferred: asReferred !== null && getNumber(asReferred, "signup_rewarded_at") !== null
  }
}

/** 運営用: 期間内の紹介の件数と、弾いた件数（理由ごと） */
export var getReferralStats = async (db, sinceSeconds) => {
  const [totals, rejections, topReferrers] = await Promise.all([
    db.queryOne(
      `SELECT count(*) AS attached,
              count(DISTINCT referrer_user_id) AS referrers,
              count(*) FILTER (WHERE action_rewarded_at IS NOT NULL) AS action_rewards,
              count(*) FILTER (WHERE paid_rewarded_at IS NOT NULL) AS paid_rewards,
              count(*) FILTER (WHERE referrer_capped = 1) AS capped,
              count(*) FILTER (WHERE status = 'rejected') AS revoked
         FROM referrals WHERE created_at >= $1`,
      [sinceSeconds]
    ),
    db.query("SELECT reason, count(*) AS count FROM referral_rejections WHERE created_at >= $1 GROUP BY reason ORDER BY count DESC", [sinceSeconds]),
    db.query(
      `SELECT referrer_user_id, count(*) AS invited, count(*) FILTER (WHERE paid_rewarded_at IS NOT NULL) AS paid
         FROM referrals WHERE created_at >= $1 GROUP BY referrer_user_id ORDER BY invited DESC LIMIT 20`,
      [sinceSeconds]
    )
  ])
  return { totals, rejections, topReferrers }
}
