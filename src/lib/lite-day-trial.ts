// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { ensureInitialCoinGrant } from "./coins"
import { jstDateKey, jstEndOfDay, resolveCoinPlanType } from "./daily-coins"

/**
 * カード登録なしの「ライト1日体験」
 * - 無料の上限まで使った人に、1 人 1 回だけ、その日（JST の 24:00 まで）はライトと同じ使い方を開放する
 *   （1 回 4 枚・ライトの優先度は aipictors-system が status を見て決める。日次コインはライトの 500 まで差額を足す）
 * - 対象: 今プランに入っていない人（以前入っていた人も）。使ったかどうかは user_id ごとに 1 行（主キー）で決まる
 * - 翌日以降は status = used・trialDate で、フロントが「昨日の続きを」とプランを案内する
 * wrangler の var LITE_DAY_TRIAL を空か "0" にすると、新しく始められなくなる（体験中の人はその日の終わりまで続く）
 */
export var isLiteDayTrialEnabled = (env) => {
  const value = String(env?.LITE_DAY_TRIAL ?? "")
  return value !== "" && value !== "0"
}

var toTrial = (row) =>
  row
    ? {
        trialDate: row.trial_date,
        startedAt: Number(row.started_at),
        // 体験の終わり（その日の 24:00 JST）
        endsAt: jstEndOfDay(Number(row.started_at))
      }
    : null

/**
 * 今の状態
 * - active: 今日体験中
 * - used: 以前使った（1 人 1 回）
 * - available: 始められる
 * - ineligible: プランに入っている・受け付けを止めている
 */
export var getLiteDayTrial = async (db, env, userId, now) => {
  const row = await db.queryOne("SELECT * FROM lite_day_trials WHERE user_id = $1", [String(userId)])
  const trial = toTrial(row)
  if (trial !== null) {
    return { status: trial.trialDate === jstDateKey(now) ? "active" : "used", ...trial }
  }
  if (!isLiteDayTrialEnabled(env)) {
    return { status: "ineligible", reason: "disabled", trialDate: null, startedAt: null, endsAt: null }
  }
  const planType = await resolveCoinPlanType(db, String(userId), null, now)
  if (planType !== "FREE") {
    return { status: "ineligible", reason: "has_plan", trialDate: null, startedAt: null, endsAt: null }
  }
  return { status: "available", reason: null, trialDate: null, startedAt: null, endsAt: null }
}

/**
 * 体験を始める。始められたら、すぐにライトの日次コインまで差額を足す
 * 同時に押されても主キーで 1 行だけになり、コインの付与も 1 日 1 回のロックで二重にならない
 */
export var startLiteDayTrial = async (props) => {
  const now = props.now
  const userId = String(props.userId)
  const current = await getLiteDayTrial(props.db, props.env, userId, now)
  if (current.status === "used") {
    return { error: "ALREADY_USED", trial: current }
  }
  if (current.status === "ineligible") {
    return { error: current.reason === "has_plan" ? "HAS_PLAN" : "DISABLED", trial: current }
  }
  if (current.status === "available") {
    await props.db.execute(
      `INSERT INTO lite_day_trials(user_id, trial_date, started_at, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, jstDateKey(now), now, props.source ?? null]
    )
  }
  const trial = await getLiteDayTrial(props.db, props.env, userId, now)
  if (trial.status !== "active") {
    // 別のリクエストが先に始めて日付が変わった、など
    return { error: "ALREADY_USED", trial }
  }
  const summary = await ensureInitialCoinGrant({ db: props.db, userId, planType: "LITE" })
  return { error: null, trial, summary }
}
