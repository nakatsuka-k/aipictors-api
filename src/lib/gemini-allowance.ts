// @ts-nocheck -- coins.ts と同じく型は順次付け直す
import { getNow } from "./db"
import { resolveCoinPlanType } from "./daily-coins"

/**
 * Gemini（Nano Banana / Nano Banana 2）に毎日のフリーコインから使える量（1 日、コイン）
 * 1 枚の原価が他のモデルより高い（約 6〜10 円）ので、プラン料金の 3 割強に収まる量にしている。
 * 超えた分はプレミアムコインで作れる
 */
export var geminiDailyAllowanceByPlan = {
  FREE: 0,
  LITE: 50,
  STANDARD: 200,
  PREMIUM: 400
};

/** この時刻（2026-11-03 00:00 JST）から枠を適用する */
export var geminiAllowanceEnforcedFrom = Date.UTC(2026, 10, 2, 15, 0, 0) / 1e3;

export var geminiCoinReasonPrefix = "image-generation:gemini-";

/** 日本時間の今日の始まり（UNIX 秒） */
export var getJstDayStart = (now) => {
  const jstOffset = 9 * 60 * 60;
  return Math.floor((now + jstOffset) / 86400) * 86400 - jstOffset;
};

export var isGeminiCoinReason = (reason) => {
  return typeof reason === "string" && reason.startsWith(geminiCoinReasonPrefix);
};

/**
 * 今日の Gemini の枠
 */
export var getGeminiAllowance = async (props) => {
  const now = props.now ?? getNow();
  const planType = await resolveCoinPlanType(props.db, props.userId, null, now);
  const dailyLimit = geminiDailyAllowanceByPlan[planType] ?? 0;
  const dayStart = getJstDayStart(now);
  const row = await props.db.queryOne(
    `SELECT COALESCE(SUM(-delta), 0)::INTEGER AS used
       FROM coin_ledger
      WHERE user_id = $1
        AND coin_type = 'FREE'
        AND kind = 'CONSUME'
        AND reason LIKE $2
        AND created_at >= $3`,
    [props.userId, `${geminiCoinReasonPrefix}%`, dayStart]
  );
  const used = row?.used ?? 0;
  return {
    planType,
    dailyLimit,
    used,
    remaining: Math.max(0, dailyLimit - used),
    isEnforced: now >= geminiAllowanceEnforcedFrom,
    enforcedFrom: geminiAllowanceEnforcedFrom,
    resetsAt: dayStart + 86400
  };
};
