// @ts-nocheck
// クリエイター報酬（推しの換金）の数字と設定。設計と根拠: ~/Documents/aipictors-coin-payout-2026-11-16/design.md
// 数字を変えるときは、フロントの app/lib/creator-rewards.ts と規約（/creator-rewards/terms）も直す

/** 報酬規約の版（変えたら参加者に同意し直してもらう） */
export const CREATOR_REWARD_TERMS_VERSION = "2026-11-16"

/** 有料コイン 1 枚あたりの報酬（ミリ円）。500 = 0.5 円（1,000 コイン = 500 円） */
export const CREATOR_REWARD_RATE_MILLIYEN = 500

/** 保留の日数（チャージバック・返金に備える） */
export const CREATOR_REWARD_HOLD_DAYS = 60

/** 振込の最低額（報酬の合計、円）。未満は翌月以降へ繰り越す */
export const CREATOR_PAYOUT_MIN_YEN = 3000

/** 1 人 1 か月の上限（報酬の合計、円）。超えた分は翌月以降へ繰り越す */
export const CREATOR_PAYOUT_MAX_YEN = 100000

/** 振込手数料（円、クリエイター負担）。Stripe の 1 回の費用（月 200 円 + 0.25% + 250 円）をまかなう */
export const CREATOR_PAYOUT_FEE_YEN = 500

/** 源泉徴収の率（100 万分率）。個人のみ。100 万円以下は 10.21%（上限が 10 万円なので超えない） */
export const DEFAULT_WITHHOLDING_PPM = 102100

/** 締めの日（毎月この日の 10:00 JST の cron で前月分を締める） */
export const CREATOR_PAYOUT_CLOSE_DAY = 10

/** 送金の自動やり直しの回数 */
export const CREATOR_PAYOUT_MAX_ATTEMPTS = 3

/** 不正の疑い: 推した人の登録からこの日数未満の推しは確認に回す */
export const SUSPICIOUS_SENDER_ACCOUNT_DAYS = 7

/** 不正の疑い: 1 人からの推しがこの割合以上、かつ報酬がこの額以上なら確認に回す */
export const SUSPICIOUS_SINGLE_SENDER_SHARE = 0.8
export const SUSPICIOUS_SINGLE_SENDER_MIN_YEN = 5000

/** 年齢区分（core の works.ageLimit）: 0 = 全年齢、1 = R18、2 = R18G、3 = R15。報酬にするのは全年齢と R15 */
export const ADULT_AGE_LIMITS = [1, 2]

const parseUserIds = (value) =>
  new Set(
    String(value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )

/** wrangler の var / secret から設定を読む */
export const getCreatorPayoutConfig = (env = {}) => {
  const mode = env.CREATOR_PAYOUT_STRIPE_MODE === "live" ? "live" : "test"
  const withholding = Number.parseInt(String(env.CREATOR_PAYOUT_WITHHOLDING_PPM ?? ""), 10)
  return {
    // 参加と報酬の記録を受け付けるか（"1" で受け付ける。止めても記録済みの報酬は残る）
    enabled: env.CREATOR_PAYOUT_ENABLED === "1",
    // Stripe のモード。test のあいだは口座登録をテスト用の利用者だけに出す
    stripeMode: mode,
    stripeSecretKey: env.STRIPE_CONNECT_SECRET_KEY || (mode === "live" ? env.STRIPE_SECRET_KEY : null) || null,
    testUserIds: parseUserIds(env.CREATOR_PAYOUT_TEST_USER_IDS),
    // all = 全件を承認キューへ、first = 初回だけ
    approvalMode: env.CREATOR_PAYOUT_APPROVAL_MODE === "first" ? "first" : "all",
    withholdingPpm: Number.isFinite(withholding) && withholding >= 0 ? withholding : DEFAULT_WITHHOLDING_PPM,
    adminEmail: env.CREATOR_PAYOUT_ADMIN_EMAIL || null,
    siteOrigin: env.SITE_ORIGIN || "https://www.aipictors.com",
  }
}

/** その人に口座登録（Stripe）を出してよいか */
export const canUseStripeOnboarding = (config, userId) =>
  Boolean(config.stripeSecretKey) && (config.stripeMode === "live" || config.testUserIds.has(String(userId)))

/** 報酬（ミリ円）を円に（切り捨て） */
export const milliyenToYen = (milliyen) => Math.floor(Number(milliyen ?? 0) / 1000)

/** 源泉徴収の額（円、切り捨て）。法人は 0 */
export const calcWithholdingYen = (grossYen, taxKind, withholdingPpm) => {
  if (taxKind === "CORPORATION") return 0
  return Math.floor((Math.max(0, grossYen) * withholdingPpm) / 1000000)
}

/** 振込額の内訳 */
export const calcPayoutAmounts = ({ grossYen, taxKind, withholdingPpm, feeYen = CREATOR_PAYOUT_FEE_YEN }) => {
  const withholdingYen = calcWithholdingYen(grossYen, taxKind, withholdingPpm)
  return { grossYen, withholdingYen, feeYen, netYen: grossYen - withholdingYen - feeYen }
}

const JST_OFFSET = 9 * 3600

/** 日本時間の年・月・日 */
export const jstParts = (unixSeconds) => {
  const d = new Date((unixSeconds + JST_OFFSET) * 1000)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** 日本時間のその月の 1 日 0:00（UNIX 秒） */
export const jstMonthStart = (year, month) => Math.floor(Date.UTC(year, month - 1, 1) / 1000) - JST_OFFSET

/**
 * 締める期間。「今」が属する月の前月を締める（保留が前月末までに明けた分）。
 * period = "YYYY-MM"（前月）、cutoff = 今月 1 日 0:00 JST（この時刻より前に保留が明けた報酬が対象）
 */
export const getClosingPeriod = (now) => {
  const { year, month } = jstParts(now)
  const prevYear = month === 1 ? year - 1 : year
  const prevMonth = month === 1 ? 12 : month - 1
  return { period: `${prevYear}-${String(prevMonth).padStart(2, "0")}`, cutoff: jstMonthStart(year, month) }
}

/** 振込 ID（1 人 1 か月 1 つ。Stripe の transfer_group と冪等性キーにも使う） */
export const payoutIdFor = (period, userId) => `cp_${period.replace("-", "")}_${userId}`

/** 作品コメントの推しの source（work-comment:<作品>:<送った人>:<時刻>）から作品 ID を読む */
export const workIdFromSupportSource = (source) => {
  const m = /^work-comment:(\d+):/.exec(String(source ?? ""))
  return m ? m[1] : null
}
