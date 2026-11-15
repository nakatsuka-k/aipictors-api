// @ts-nocheck
// クリエイター報酬（推しの換金）。設計: ~/Documents/aipictors-coin-payout-2026-11-16/design.md
import { getNow } from "../db"
import { CREATOR_PAYOUT_CLOSE_DAY, jstParts } from "./config"
import { createPayoutNotifier } from "./notify"
import { closeMonthlyPayouts, sendReadyPayouts } from "./payouts"

export * from "./config"
export * from "./eligibility"
export * from "./notify"
export * from "./payouts"
export * from "./profiles"
export * from "./summary"

/**
 * 毎日 10:00 JST の cron から呼ぶ。締めの日（10 日）は前月分を締め、毎日、承認済みの振込を送る（失敗のやり直しを含む）
 */
export const runCreatorPayoutJob = async (env, db, now = getNow()) => {
  const notify = createPayoutNotifier(env, db)
  let close = null
  if (jstParts(now).day === CREATOR_PAYOUT_CLOSE_DAY) {
    close = await closeMonthlyPayouts({ db, core: env.SYSTEM_CORE ?? null, env, now })
    const waiting = close.results.filter((r) => r.action === "created" && r.status === "AWAITING_APPROVAL")
    if (waiting.length > 0) {
      await notify({
        type: "awaiting_approval",
        period: close.period,
        count: waiting.length,
        netYen: waiting.reduce((s, r) => s + (r.netYen ?? 0), 0),
      })
    }
  }
  const send = await sendReadyPayouts({ db, env, now, notify })
  return {
    closed: close ? { period: close.period, created: close.results.filter((r) => r.action === "created").length } : null,
    sent: send.sent,
    failed: send.failed,
    skipped: send.skipped ?? null,
  }
}
