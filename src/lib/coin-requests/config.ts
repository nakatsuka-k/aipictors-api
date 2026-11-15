// @ts-nocheck
// 有料リクエストとプランの決まり。設計: ~/Documents/aipictors-requests-2026-11-16/design.md

/** 手数料（運営の取り分、100 万分率）。確定のときだけ差し引く */
export const DEFAULT_REQUEST_FEE_PPM = 100000
export const REQUEST_MIN_COINS = 100
export const REQUEST_MAX_COINS = 100000
/** 承諾待ちの期限 */
export const RESPOND_DAYS = 3
/** 納品から自動で確定するまで */
export const AUTO_COMPLETE_DAYS = 7
/** 納期を過ぎてから自動でキャンセルするまで */
export const OVERDUE_GRACE_DAYS = 3
/** 修正依頼で延びる納期 */
export const REVISION_EXTEND_DAYS = 3
/** クリエイター全体の同時受付（承諾待ち＋制作中） */
export const CREATOR_ACTIVE_MAX = 10
/** 1 人の依頼者が同じクリエイターに出せる承諾待ち */
export const REQUESTER_PENDING_MAX = 3
/** 返却・受け取りの無料コインの期限 */
export const FREE_COIN_EXPIRE_DAYS = 90
export const MAX_REFERENCE_IMAGES = 4
export const MAX_SAMPLE_IMAGES = 6
export const MAX_DELIVERY_IMAGES = 10
export const MAX_BODY_LENGTH = 3000
export const MAX_TITLE_LENGTH = 60
export const MAX_MESSAGE_LENGTH = 2000

export const PLAN_CATEGORIES = ["ILLUSTRATION", "ICON", "CHARACTER", "BACKGROUND", "WALLPAPER", "OTHER"]

/** 受け付け中の依頼（同時受付数に数える） */
export const ACTIVE_STATUSES = ["PENDING", "ACCEPTED"]
/** 終わっていない依頼 */
export const OPEN_STATUSES = ["PENDING", "ACCEPTED", "DELIVERED"]
/** コインを全額返す終わり方 */
export const REFUND_STATUSES = ["DECLINED", "CANCELED", "EXPIRED", "ADMIN_CANCELED"]

export const DAY = 86400

export const getRequestConfig = (env = {}) => {
  const fee = Number(env.COIN_REQUEST_FEE_PPM ?? DEFAULT_REQUEST_FEE_PPM)
  return {
    enabled: String(env.COIN_REQUESTS_ENABLED ?? "1") === "1",
    feePpm: Number.isFinite(fee) && fee >= 0 && fee < 1000000 ? Math.floor(fee) : DEFAULT_REQUEST_FEE_PPM,
    siteOrigin: env.SITE_ORIGIN ?? "https://www.aipictors.com",
  }
}

/**
 * 確定のときの内訳。手数料は合計から切り上げで取り、無料・プレミアムの割合で分ける。
 * 報酬にするのはプレミアムのうち有料（おまけでない）分の割合（eligible のときだけ）
 */
export const calcSettlement = ({ freeSpent, premiumSpent, paidCoins, feePpm, eligible }) => {
  const free = Math.max(0, Math.floor(Number(freeSpent) || 0))
  const premium = Math.max(0, Math.floor(Number(premiumSpent) || 0))
  const paid = Math.min(premium, Math.max(0, Math.floor(Number(paidCoins) || 0)))
  const total = free + premium
  if (total <= 0) return { feeCoins: 0, settleFreeCoins: 0, settlePremiumCoins: 0, earnedCoins: 0 }
  const feeCoins = Math.min(total, Math.ceil((total * feePpm) / 1000000))
  const feeFree = Math.floor((feeCoins * free) / total)
  const feePremium = feeCoins - feeFree
  const settleFreeCoins = free - feeFree
  const premiumNet = premium - feePremium
  const earnedCoins = eligible && premium > 0 ? Math.min(premiumNet, Math.floor((paid * premiumNet) / premium)) : 0
  return { feeCoins, settleFreeCoins, settlePremiumCoins: premiumNet - earnedCoins, earnedCoins }
}

export const parseJsonArray = (value) => {
  try {
    const parsed = JSON.parse(value ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []
  } catch {
    return []
  }
}

/** 画像の URL はサイトの画像の置き場だけ（外のサイトを埋め込ませない） */
export const isAllowedImageUrl = (url) =>
  typeof url === "string" &&
  url.length < 600 &&
  /^https:\/\/([a-z0-9-]+\.)*(aipictors\.com|aipictors\.net|r2\.dev|imagedelivery\.net|googleapis\.com|appspot\.com)\//.test(url)

export const cleanImageUrls = (urls, max) =>
  (Array.isArray(urls) ? urls : []).filter(isAllowedImageUrl).slice(0, max)
