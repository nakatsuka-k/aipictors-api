// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
// 感謝コインの定数と週の計算
import { getNow } from "../db"
export var SUPPORT_PT_MULTIPLIER = {
  FREE: 1,
  PREMIUM: 10
};

export var CONTRIBUTION_RANKING_EXCLUDED_USER_ID = "1";

export var ANONYMOUS_SUPPORT_USER_ID = "__anonymous__";

export var toJstDate = (unixSeconds) => {
  return new Date((unixSeconds + 9 * 60 * 60) * 1e3);
};

export var formatIsoDate = (date) => {
  return date.toISOString().slice(0, 10);
};

export var getSupportWeekStartDate = (unixSeconds = getNow()) => {
  const date = toJstDate(unixSeconds);
  const day = date.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diffToMonday);
  return formatIsoDate(date);
};

export var getBalanceColumn = (coinType) => {
  return coinType === "FREE" ? "free_balance" : "premium_balance";
};
