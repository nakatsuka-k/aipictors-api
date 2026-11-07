// @ts-nocheck -- coins.ts と同じく型は順次付け直す
import { getNow } from "./db"
import { resolveCoinPlanType } from "./daily-coins"

/**
 * Gemini（Nano Banana / Nano Banana 2）に毎日のフリーコインから使える量（1 週間、コイン）
 * 1 枚の原価が他のモデルより高い（約 6〜10 円）ので、上限まで使っても原価がプラン料金の約 25% に収まる量にしている
 * （Nano Banana でライト 5 枚・スタンダード 20 枚・プレミアム 40 枚）。超えた分はプレミアムコインで作れる
 */
export var geminiWeeklyAllowanceByPlan = {
  FREE: 0,
  LITE: 250,
  STANDARD: 1000,
  PREMIUM: 2000
};

/** この時刻（2026-11-03 00:00 JST）から枠を適用する。これより前の分は数えない */
export var geminiAllowanceEnforcedFrom = Date.UTC(2026, 10, 2, 15, 0, 0) / 1e3;

export var geminiCoinReasonPrefix = "image-generation:gemini-";

/** 日本時間の今週（月曜 0 時）の始まり（UNIX 秒） */
export var getJstWeekStart = (now) => {
  const jstOffset = 9 * 60 * 60;
  const day = Math.floor((now + jstOffset) / 86400);
  // 1970-01-01 は木曜なので、月曜からの日数は (day + 3) % 7
  return (day - (day + 3) % 7) * 86400 - jstOffset;
};

export var isGeminiCoinReason = (reason) => {
  return typeof reason === "string" && reason.startsWith(geminiCoinReasonPrefix);
};

/**
 * 今週の Gemini の枠
 */
export var getGeminiAllowance = async (props) => {
  const now = props.now ?? getNow();
  const planType = await resolveCoinPlanType(props.db, props.userId, null, now);
  const weeklyLimit = geminiWeeklyAllowanceByPlan[planType] ?? 0;
  const weekStart = getJstWeekStart(now);
  const row = await props.db.queryOne(
    `SELECT COALESCE(SUM(-delta), 0) AS used
       FROM coin_ledger
      WHERE user_id = $1
        AND coin_type = 'FREE'
        AND kind = 'CONSUME'
        AND reason LIKE $2
        AND created_at >= $3`,
    [props.userId, `${geminiCoinReasonPrefix}%`, Math.max(weekStart, geminiAllowanceEnforcedFrom)]
  );
  const used = row?.used ?? 0;
  return {
    planType,
    weeklyLimit,
    // 読み込み済みの古い画面向け
    dailyLimit: weeklyLimit,
    used,
    remaining: Math.max(0, weeklyLimit - used),
    isEnforced: now >= geminiAllowanceEnforcedFrom,
    enforcedFrom: geminiAllowanceEnforcedFrom,
    resetsAt: weekStart + 7 * 86400
  };
};
