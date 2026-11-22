// @ts-nocheck
// 募集リクエスト（コンペ型）の決まり。migrations/gen/0021_open_requests.sql

export const OPEN_REQUEST_MIN_COINS = 100
export const OPEN_REQUEST_MAX_COINS = 100000
/** 締切（募集を出してから）の範囲と既定 */
export const DEADLINE_MIN_DAYS = 3
export const DEADLINE_MAX_DAYS = 14
export const DEADLINE_DEFAULT_DAYS = 7
/** 1 人が 1 つの募集に出せる提案（取り下げたものは数えない） */
export const PROPOSALS_PER_USER = 3
/** 1 人が同時に出せる募集 */
export const REQUESTER_OPEN_MAX = 5
export const MAX_REFERENCE_IMAGES = 4
export const MAX_PROPOSAL_IMAGES = 4
export const MAX_TITLE_LENGTH = 60
export const MAX_BODY_LENGTH = 3000
export const MAX_PROPOSAL_MESSAGE_LENGTH = 500
export const MAX_COMMENT_LENGTH = 500
/** 提案 1 件のコメントの上限（荒れないように） */
export const MAX_COMMENTS_PER_PROPOSAL = 200

export const AWARDED_STATUSES = ["AWARDED", "AUTO_AWARDED", "ADMIN_AWARDED"]
export const REFUND_STATUSES = ["EXPIRED", "CANCELED", "ADMIN_CANCELED"]

export const DAY = 86400

export const getOpenRequestConfig = (env = {}) => ({
  enabled: String(env.OPEN_REQUESTS_ENABLED ?? "1") === "1",
})
