// @ts-nocheck
// 月の締め・送金・承認・取り消し・返金時の差し戻し
import { getNow } from "../db"
import {
  CREATOR_PAYOUT_FEE_YEN,
  CREATOR_PAYOUT_MAX_ATTEMPTS,
  CREATOR_PAYOUT_MAX_YEN,
  CREATOR_PAYOUT_MIN_YEN,
  CREATOR_PAYOUT_NEW_ACCOUNT_DAYS,
  CREATOR_PAYOUT_NEW_ACCOUNT_MAX_YEN,
  SUSPICIOUS_SENDER_ACCOUNT_DAYS,
  SUSPICIOUS_SINGLE_SENDER_MIN_YEN,
  SUSPICIOUS_SINGLE_SENDER_SHARE,
  calcPayoutAmounts,
  getClosingPeriod,
  getCreatorPayoutConfig,
  payoutIdFor,
} from "./config"
import { getProfile, isPayoutReady } from "./profiles"
import { createStripeClient, isRetryableTransferError } from "./stripe-connect"

const toNum = (v) => Number(v ?? 0)

/**
 * 1 人分の報酬の行から、今回の振込に入れる行を選ぶ（古い順、上限まで。マイナスの行は必ず入れる）
 * 返す grossMilliyen は選んだ行の合計
 */
export const selectEarningsForPayout = (rows, maxYen = CREATOR_PAYOUT_MAX_YEN) => {
  const limit = maxYen * 1000
  const negatives = rows.filter((r) => toNum(r.amount_milliyen) < 0)
  let total = negatives.reduce((sum, r) => sum + toNum(r.amount_milliyen), 0)
  const selected = [...negatives]
  for (const row of rows) {
    const amount = toNum(row.amount_milliyen)
    if (amount < 0) continue
    if (total + amount > limit) break
    total += amount
    selected.push(row)
  }
  return { selected, grossMilliyen: total }
}

/**
 * 不正の疑い（当たれば承認キューへ）。core が無いときは IP と登録日は見ない
 * - 推した人と受け取る人が同じ IP を使ったことがある
 * - 推した人の登録から 7 日未満の推し
 * - 1 人からの推しが 8 割以上で、報酬が 5,000 円以上
 */
export const detectPayoutFlags = async ({ core, userId, rows, grossYen }) => {
  const flags = []
  const bySender = new Map()
  for (const row of rows) {
    if (toNum(row.amount_milliyen) <= 0 || !row.sender_user_id) continue
    const key = String(row.sender_user_id)
    const prev = bySender.get(key) ?? { amount: 0, firstAt: Number.POSITIVE_INFINITY }
    bySender.set(key, { amount: prev.amount + toNum(row.amount_milliyen), firstAt: Math.min(prev.firstAt, toNum(row.created_at)) })
  }
  const positiveTotal = [...bySender.values()].reduce((s, v) => s + v.amount, 0)
  const top = [...bySender.entries()].sort((a, b) => b[1].amount - a[1].amount)[0]
  if (top && positiveTotal > 0 && top[1].amount / positiveTotal >= SUSPICIOUS_SINGLE_SENDER_SHARE && grossYen >= SUSPICIOUS_SINGLE_SENDER_MIN_YEN) {
    flags.push({ code: "single_sender", senderUserId: top[0], share: Math.round((top[1].amount / positiveTotal) * 100) })
  }
  if (core) {
    // 多い順に 20 人まで（読み取りを増やしすぎない）
    const senders = [...bySender.entries()].sort((a, b) => b[1].amount - a[1].amount).slice(0, 20)
    for (const [senderUserId, info] of senders) {
      try {
        const shared = await core
          .prepare("SELECT 1 AS hit FROM ip_bindings a JOIN ip_bindings b ON b.ip = a.ip WHERE a.user_id = ? AND b.user_id = ? LIMIT 1")
          .bind(Number(userId), Number(senderUserId))
          .first()
        if (shared) flags.push({ code: "shared_ip", senderUserId })
        const user = await core.prepare("SELECT user_registered FROM wp_users WHERE ID = ?").bind(Number(senderUserId)).first()
        const registeredAt = user?.user_registered ? Math.floor(Date.parse(String(user.user_registered)) / 1000) : Number.NaN
        if (Number.isFinite(registeredAt) && info.firstAt - registeredAt < SUSPICIOUS_SENDER_ACCOUNT_DAYS * 86400) {
          flags.push({ code: "new_sender_account", senderUserId })
        }
      } catch (error) {
        flags.push({ code: "check_failed", senderUserId, message: String(error?.message ?? error).slice(0, 120) })
      }
    }
  }
  return flags
}

/**
 * 今回の振込の上限（円）。月の上限からその月にすでに締めた分を引き、本人確認から 30 日以内の口座は 1 回の上限を低くする
 */
export const payoutLimitYen = ({ monthUsedYen = 0, payoutsEnabledAt = null, now }) => {
  const monthLeft = Math.max(0, CREATOR_PAYOUT_MAX_YEN - monthUsedYen)
  const isNewAccount = !payoutsEnabledAt || now - payoutsEnabledAt < CREATOR_PAYOUT_NEW_ACCOUNT_DAYS * 86400
  return isNewAccount ? Math.min(monthLeft, CREATOR_PAYOUT_NEW_ACCOUNT_MAX_YEN) : monthLeft
}

/**
 * 締め（何度実行しても同じ。10 日・25 日）。締めの日の 0:00 までに保留が明けた報酬を集めて、1 人 1 回 1 つの振込を作る。
 * dryRun のときは書かずに結果だけ返す
 */
export const closeMonthlyPayouts = async ({ db, core, env, now = getNow(), period: forcedPeriod, dryRun = false }) => {
  const config = getCreatorPayoutConfig(env)
  const closing = getClosingPeriod(now)
  const period = forcedPeriod ?? closing.period
  const cutoff = closing.cutoff
  const rows = await db.query(
    `SELECT id AS earning_id, user_id, sender_user_id, amount_milliyen, created_at AS earned_at
       FROM creator_earnings
      WHERE status = 'HELD' AND available_at < $1
      ORDER BY user_id, id`,
    [cutoff],
  )
  const byUser = new Map()
  for (const row of rows) {
    const list = byUser.get(String(row.user_id)) ?? []
    list.push({ ...row, id: toNum(row.earning_id), created_at: toNum(row.earned_at) })
    byUser.set(String(row.user_id), list)
  }
  const livemode = Boolean(config.stripeSecretKey?.startsWith("sk_live_"))
  const results = []
  for (const [userId, userRows] of byUser) {
    const profile = await getProfile(db, userId)
    // 同じ月のほかの締め（取り消し以外）の合計。古い "YYYY-MM" の期間も同じ月に数える
    const used = await db.queryOne(
      `SELECT COALESCE(SUM(gross_yen), 0) AS yen FROM creator_payouts
        WHERE user_id = $1 AND substr(period, 1, 7) = $2 AND period <> $3 AND status <> 'CANCELED'`,
      [userId, period.slice(0, 7), period],
    )
    const limitYen = payoutLimitYen({ monthUsedYen: toNum(used?.yen), payoutsEnabledAt: profile?.payoutsEnabledAt ?? null, now })
    const { selected, grossMilliyen } = selectEarningsForPayout(userRows, limitYen)
    const grossYen = Math.floor(grossMilliyen / 1000)
    if (grossYen < CREATOR_PAYOUT_MIN_YEN) {
      // 保留明けの合計は最低額以上なのに上限で選べなかったときは、上限による繰り越し
      const availableYen = Math.floor(userRows.reduce((sum, r) => sum + toNum(r.amount_milliyen), 0) / 1000)
      results.push({ userId, action: availableYen >= CREATOR_PAYOUT_MIN_YEN ? "monthly_limit_reached" : "below_minimum", grossYen, limitYen })
      continue
    }
    if (!profile || profile.status === "SUSPENDED") {
      results.push({ userId, action: "suspended_or_missing", grossYen })
      continue
    }
    if (!isPayoutReady(profile, livemode)) {
      results.push({ userId, action: "account_not_ready", grossYen })
      continue
    }
    const amounts = calcPayoutAmounts({ grossYen, taxKind: profile.taxKind, withholdingPpm: config.withholdingPpm })
    if (amounts.netYen <= 0) {
      results.push({ userId, action: "net_not_positive", grossYen })
      continue
    }
    const flags = await detectPayoutFlags({ core, userId, rows: selected, grossYen })
    const needsApproval = config.approvalMode === "all" || !profile.approvedAt || flags.length > 0
    const status = needsApproval ? "AWAITING_APPROVAL" : "READY"
    const payoutId = payoutIdFor(period, userId)
    if (dryRun) {
      results.push({ userId, action: "would_create", payoutId, status, ...amounts, earnings: selected.length, flags })
      continue
    }
    const ids = selected.map((r) => r.id)
    const idList = ids.join(",")
    const guarded = "EXISTS (SELECT 1 FROM d1_guard)"
    // 振込の行を入れられた（＝この期間の振込がまだ無い）ときだけ、報酬の行をこの振込に付ける。
    // 金額は付けられた行から計算し直す（読んだあとで取り消された行があっても合う）
    const batch = await db.batch([
      {
        text: `INSERT INTO creator_payouts(id, user_id, period, status, gross_yen, withholding_yen, fee_yen, net_yen, earnings_count,
                 flags_json, stripe_account_id, stripe_livemode, created_at, updated_at)
               VALUES ($1, $2, $3, $4, 0, 0, $5, 0, 0, $6, $7, $8, $9, $9)
               ON CONFLICT (user_id, period) DO NOTHING`,
        params: [payoutId, userId, period, status, CREATOR_PAYOUT_FEE_YEN, flags.length ? JSON.stringify(flags) : null, profile.stripeAccountId, livemode ? 1 : 0, now],
      },
      { text: `INSERT INTO d1_guard(ok) SELECT 1 WHERE changes() = 1` },
      {
        text: `UPDATE creator_earnings SET status = 'IN_PAYOUT', payout_id = $1, updated_at = $2
                WHERE id IN (${idList}) AND status = 'HELD' AND ${guarded}`,
        params: [payoutId, now],
      },
      {
        text: `UPDATE creator_payouts
                  SET gross_yen = (SELECT COALESCE(SUM(amount_milliyen), 0) / 1000 FROM creator_earnings WHERE payout_id = $1),
                      earnings_count = (SELECT COUNT(*) FROM creator_earnings WHERE payout_id = $1)
                WHERE id = $1 AND ${guarded}`,
        params: [payoutId],
      },
      { text: `SELECT ${guarded} AS created` },
      { text: "DELETE FROM d1_guard" },
    ])
    if (!batch[4].rows[0]?.created) {
      results.push({ userId, action: "already_closed", payoutId })
      continue
    }
    const saved = await db.queryOne(`SELECT gross_yen FROM creator_payouts WHERE id = $1`, [payoutId])
    const final = calcPayoutAmounts({ grossYen: toNum(saved?.gross_yen), taxKind: profile.taxKind, withholdingPpm: config.withholdingPpm })
    if (final.grossYen < CREATOR_PAYOUT_MIN_YEN || final.netYen <= 0) {
      await cancelPayout({ db, payoutId, mode: "release", reason: "below_minimum_after_recount", now })
      results.push({ userId, action: "below_minimum", grossYen: final.grossYen })
      continue
    }
    await db.execute(
      `UPDATE creator_payouts SET withholding_yen = $2, net_yen = $3, updated_at = $4 WHERE id = $1`,
      [payoutId, final.withholdingYen, final.netYen, now],
    )
    results.push({ userId, action: "created", payoutId, status, ...final, earnings: ids.length, flags })
  }
  return { period, cutoff, results }
}

/** 承認キューの振込を承認する（初回の承認は、その人の以後の振込にも効く） */
export const approvePayout = async ({ db, payoutId, moderatorUserId, now = getNow() }) => {
  const results = await db.batch([
    {
      text: `UPDATE creator_payouts SET status = 'READY', approved_at = $2, approved_by_user_id = $3, updated_at = $2
              WHERE id = $1 AND status = 'AWAITING_APPROVAL'`,
      params: [payoutId, now, String(moderatorUserId)],
    },
    {
      text: `UPDATE creator_payout_profiles SET approved_at = COALESCE(approved_at, $2), approved_by_user_id = COALESCE(approved_by_user_id, $3), updated_at = $2
              WHERE user_id = (SELECT user_id FROM creator_payouts WHERE id = $1 AND status = 'READY' AND approved_at = $2)`,
      params: [payoutId, now, String(moderatorUserId)],
    },
  ])
  return { ok: results[0].changes > 0 }
}

/**
 * 振込をやめる。mode = release（報酬を保留明けに戻して翌月以降へ）/ reverse（報酬を取り消す）
 * 送金中・送金済みはやめられない
 */
export const cancelPayout = async ({ db, payoutId, mode = "release", reason = null, now = getNow() }) => {
  const guarded = "EXISTS (SELECT 1 FROM d1_guard)"
  const results = await db.batch([
    {
      text: `UPDATE creator_payouts SET status = 'CANCELED', last_error = $2, updated_at = $3
              WHERE id = $1 AND status IN ('AWAITING_APPROVAL', 'READY', 'FAILED')`,
      params: [payoutId, reason, now],
    },
    { text: `INSERT INTO d1_guard(ok) SELECT 1 WHERE changes() = 1` },
    mode === "reverse"
      ? {
          text: `UPDATE creator_earnings SET status = 'REVERSED', reversed_reason = COALESCE($2, 'admin_rejected'), reversed_at = $3, updated_at = $3
                  WHERE payout_id = $1 AND status = 'IN_PAYOUT' AND ${guarded}`,
          params: [payoutId, reason, now],
        }
      : {
          text: `UPDATE creator_earnings SET status = 'HELD', payout_id = NULL, updated_at = $2
                  WHERE payout_id = $1 AND status = 'IN_PAYOUT' AND ${guarded}`,
          params: [payoutId, now],
        },
    { text: `SELECT ${guarded} AS ok` },
    { text: "DELETE FROM d1_guard" },
  ])
  return { ok: Boolean(results[3].rows[0]?.ok) }
}

const markSent = async (db, payoutId, transferId, now) => {
  await db.batch([
    {
      text: `UPDATE creator_payouts SET status = 'SENT', stripe_transfer_id = $2, sent_at = $3, last_error = NULL, updated_at = $3
              WHERE id = $1 AND status = 'SENDING'`,
      params: [payoutId, transferId, now],
    },
    {
      text: `UPDATE creator_earnings SET status = 'PAID', updated_at = $2 WHERE payout_id = $1 AND status = 'IN_PAYOUT'`,
      params: [payoutId, now],
    },
  ])
}

/**
 * 送金（READY と、やり直してよい FAILED）。1 件ずつ SENDING に変えられたものだけ送る＝同時に動いても 1 回だけ。
 * 送る前に transfer_group で既に送ったものが無いか確かめる（冪等性キーの 24 時間を過ぎても二重にならない）
 */
export const sendReadyPayouts = async ({ db, env, fetchImpl, now = getNow(), payoutId = null, notify = null, limit = 20 }) => {
  const config = getCreatorPayoutConfig(env)
  if (!config.stripeSecretKey) return { sent: 0, failed: 0, skipped: "no_stripe_key", results: [] }
  const stripe = createStripeClient({ secretKey: config.stripeSecretKey, fetchImpl })
  // 1 時間以上 SENDING のまま（途中で落ちた）は、Stripe を見て SENT か READY に戻す
  const stuck = await db.query(
    `SELECT id FROM creator_payouts WHERE status = 'SENDING' AND updated_at < $1 ${payoutId ? "AND id = $2" : ""} LIMIT 20`,
    payoutId ? [now - 3600, payoutId] : [now - 3600],
  )
  for (const row of stuck) {
    const existing = await stripe.listTransfersByGroup(String(row.id))
    const transfer = existing?.data?.find((t) => !t.reversed)
    if (transfer) await markSent(db, String(row.id), transfer.id, now)
    else await db.execute(`UPDATE creator_payouts SET status = 'READY', updated_at = $2 WHERE id = $1 AND status = 'SENDING'`, [String(row.id), now])
  }
  const candidates = await db.query(
    `SELECT id AS payout_id, user_id, net_yen, period, attempts, status, stripe_livemode
       FROM creator_payouts
      WHERE (status = 'READY' OR (status = 'FAILED' AND attempts < $1 AND last_error LIKE 'retryable:%' AND updated_at < $2))
        ${payoutId ? "AND id = $3" : ""}
      ORDER BY created_at
      LIMIT ${Math.max(1, Math.min(100, limit))}`,
    payoutId ? [CREATOR_PAYOUT_MAX_ATTEMPTS, now - 20 * 3600, payoutId] : [CREATOR_PAYOUT_MAX_ATTEMPTS, now - 20 * 3600],
  )
  const results = []
  for (const row of candidates) {
    const id = String(row.payout_id)
    const userId = String(row.user_id)
    const profile = await getProfile(db, userId)
    if (Number(row.stripe_livemode) !== (stripe.livemode ? 1 : 0) || !isPayoutReady(profile, stripe.livemode)) {
      await db.execute(`UPDATE creator_payouts SET last_error = 'account_not_ready', updated_at = $2 WHERE id = $1 AND status = 'READY'`, [id, now])
      results.push({ payoutId: id, action: "account_not_ready" })
      continue
    }
    const lock = await db.executeResult(
      `UPDATE creator_payouts SET status = 'SENDING', attempts = attempts + 1, stripe_account_id = $2, updated_at = $3
        WHERE id = $1 AND status IN ('READY', 'FAILED')`,
      [id, profile.stripeAccountId, now],
    )
    if (lock.rowCount !== 1) {
      results.push({ payoutId: id, action: "locked_by_other" })
      continue
    }
    const attempt = toNum(row.attempts) + 1
    try {
      const existing = await stripe.listTransfersByGroup(id)
      let transfer = existing?.data?.find((t) => !t.reversed)
      if (!transfer) {
        transfer = await stripe.createTransfer({
          amount: toNum(row.net_yen),
          destination: profile.stripeAccountId,
          transferGroup: id,
          description: `Aipictors クリエイター報酬 ${row.period}`,
          metadata: { payout_id: id, aipictors_user_id: userId, period: String(row.period) },
          idempotencyKey: `creator-payout:${id}:${attempt}`,
        })
      }
      await markSent(db, id, transfer.id, now)
      results.push({ payoutId: id, action: "sent", transferId: transfer.id })
      await notify?.({ type: "sent", payoutId: id, userId, netYen: toNum(row.net_yen), email: profile.email, period: row.period })
    } catch (error) {
      const retryable = isRetryableTransferError(error)
      const message = `${retryable ? "retryable" : "fatal"}:${String(error?.code ?? "")}:${String(error?.message ?? error).slice(0, 300)}`
      await db.execute(`UPDATE creator_payouts SET status = 'FAILED', last_error = $2, updated_at = $3 WHERE id = $1 AND status = 'SENDING'`, [id, message, now])
      results.push({ payoutId: id, action: "failed", retryable, message })
      if (!retryable || attempt >= CREATOR_PAYOUT_MAX_ATTEMPTS) {
        await notify?.({ type: "failed", payoutId: id, userId, netYen: toNum(row.net_yen), email: profile.email, period: row.period, message })
      }
    }
  }
  return {
    sent: results.filter((r) => r.action === "sent").length,
    failed: results.filter((r) => r.action === "failed").length,
    results,
  }
}

/**
 * コイン購入の返金・チャージバック。その購入者が購入のあとに送った推しの報酬を、購入した有料コインの枚数まで取り消す。
 * 保留中・締め前は REVERSED、締めた（振込待ち）ものは振込から外して REVERSED、振込済みは次回から差し引くマイナスの行を足す
 */
export const reverseEarningsForSenderRefund = async ({ db, senderUserId, since, maxCoins, reason, now = getNow() }) => {
  let remaining = Math.max(0, Math.floor(maxCoins ?? Number.MAX_SAFE_INTEGER))
  const rows = await db.query(
    `SELECT id AS earning_id, user_id, coins, rate_milliyen, amount_milliyen, status, payout_id, work_id, source
       FROM creator_earnings
      WHERE sender_user_id = $1 AND kind IN ('SUPPORT', 'REQUEST') AND created_at >= $2 AND status IN ('HELD', 'IN_PAYOUT', 'PAID')
      ORDER BY id DESC`,
    [String(senderUserId), Math.floor(since ?? 0)],
  )
  let reversedCoins = 0
  let clawbackCoins = 0
  const touchedPayouts = new Set()
  for (const row of rows) {
    if (remaining <= 0) break
    const coins = Math.min(remaining, toNum(row.coins))
    remaining -= coins
    const earningId = toNum(row.earning_id)
    if (row.status === "PAID") {
      // 振込済み: 次回の振込から差し引く
      await db.execute(
        `INSERT INTO creator_earnings(user_id, kind, source, sender_user_id, work_id, coins, rate_milliyen, amount_milliyen, status, available_at, created_at, updated_at)
         VALUES ($1, 'CLAWBACK', $2, $3, $4, $5, $6, $7, 'HELD', $8, $8, $8)`,
        [String(row.user_id), `clawback:${earningId}:${reason}`, String(senderUserId), row.work_id ?? null, -coins, toNum(row.rate_milliyen), -coins * toNum(row.rate_milliyen), now],
      )
      clawbackCoins += coins
      continue
    }
    if (row.status === "IN_PAYOUT") {
      // 送金前の振込からは外す（金額を計算し直す）。送金中・送金済みならマイナスの行にする
      const payout = await db.queryOne(`SELECT status FROM creator_payouts WHERE id = $1`, [String(row.payout_id)])
      if (!payout || !["AWAITING_APPROVAL", "READY", "FAILED"].includes(payout.status)) {
        await db.execute(
          `INSERT INTO creator_earnings(user_id, kind, source, sender_user_id, work_id, coins, rate_milliyen, amount_milliyen, status, available_at, created_at, updated_at)
           VALUES ($1, 'CLAWBACK', $2, $3, $4, $5, $6, $7, 'HELD', $8, $8, $8)`,
          [String(row.user_id), `clawback:${earningId}:${reason}`, String(senderUserId), row.work_id ?? null, -coins, toNum(row.rate_milliyen), -coins * toNum(row.rate_milliyen), now],
        )
        clawbackCoins += coins
        continue
      }
      touchedPayouts.add(String(row.payout_id))
    }
    if (coins === toNum(row.coins)) {
      await db.execute(
        `UPDATE creator_earnings SET status = 'REVERSED', reversed_reason = $2, reversed_at = $3, updated_at = $3, payout_id = NULL
          WHERE id = $1 AND status IN ('HELD', 'IN_PAYOUT')`,
        [earningId, reason, now],
      )
    } else {
      // 一部だけ取り消す: 行を減らして、取り消した分を別の行で残す
      await db.batch([
        {
          text: `UPDATE creator_earnings SET coins = coins - $2, amount_milliyen = (coins - $2) * rate_milliyen, updated_at = $3 WHERE id = $1`,
          params: [earningId, coins, now],
        },
        {
          text: `INSERT INTO creator_earnings(user_id, kind, source, sender_user_id, work_id, coins, rate_milliyen, amount_milliyen, status, available_at, reversed_reason, reversed_at, created_at, updated_at)
                 SELECT user_id, kind, source, sender_user_id, work_id, $2, rate_milliyen, $2 * rate_milliyen, 'REVERSED', available_at, $3, $4, $4, $4
                   FROM creator_earnings WHERE id = $1`,
          params: [earningId, coins, reason, now],
        },
      ])
    }
    reversedCoins += coins
  }
  // 外した振込の金額を計算し直す（最低額を下回ったら振込をやめて残りを保留明けに戻す）
  for (const payoutId of touchedPayouts) {
    await recalcPayout({ db, payoutId, now })
  }
  return { reversedCoins, clawbackCoins }
}

/** 送金前の振込の金額を報酬の行から計算し直す */
export const recalcPayout = async ({ db, env = {}, payoutId, now = getNow() }) => {
  const config = getCreatorPayoutConfig(env)
  const payout = await db.queryOne(`SELECT user_id, status FROM creator_payouts WHERE id = $1`, [payoutId])
  if (!payout || !["AWAITING_APPROVAL", "READY", "FAILED"].includes(payout.status)) return { ok: false }
  const sum = await db.queryOne(
    `SELECT COALESCE(SUM(amount_milliyen), 0) AS total, COUNT(*) AS n FROM creator_earnings WHERE payout_id = $1 AND status = 'IN_PAYOUT'`,
    [payoutId],
  )
  const profile = await getProfile(db, String(payout.user_id))
  const amounts = calcPayoutAmounts({ grossYen: Math.floor(toNum(sum?.total) / 1000), taxKind: profile?.taxKind, withholdingPpm: config.withholdingPpm })
  if (amounts.grossYen < CREATOR_PAYOUT_MIN_YEN || amounts.netYen <= 0) {
    await cancelPayout({ db, payoutId, mode: "release", reason: "below_minimum_after_refund", now })
    return { ok: true, canceled: true }
  }
  await db.execute(
    `UPDATE creator_payouts SET gross_yen = $2, withholding_yen = $3, net_yen = $4, earnings_count = $5, updated_at = $6
      WHERE id = $1 AND status IN ('AWAITING_APPROVAL', 'READY', 'FAILED')`,
    [payoutId, amounts.grossYen, amounts.withholdingYen, amounts.netYen, toNum(sum?.n), now],
  )
  return { ok: true, canceled: false, ...amounts }
}
