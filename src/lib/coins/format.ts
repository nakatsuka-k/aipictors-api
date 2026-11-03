// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
// コインの定数、日付、お知らせの文
export var initialFreeCoinsByPlan = {
  FREE: 100,
  LITE: 500,
  STANDARD: 1e3,
  PREMIUM: 2e3
};

export var tokyoDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

export var dailyGrantKeyPrefix = "daily_generation_access:";

export var toCoinPlanType = (value) => {
  if (value === "LITE" || value === "STANDARD" || value === "PREMIUM") {
    return value;
  }
  return "FREE";
};

export var getJstExpirationAt = (unixSeconds) => {
  const parts = tokyoDateFormatter.formatToParts(new Date(unixSeconds * 1e3));
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "1970");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "01");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "01");
  const jstDayStartUtc = Date.UTC(year, month - 1, day, 0, 0, 0) / 1e3 - 9 * 60 * 60;
  return jstDayStartUtc + 24 * 60 * 60;
};

export var getJstDateKey = (unixSeconds) => {
  return tokyoDateFormatter.format(new Date(unixSeconds * 1e3));
};

export var formatJstDateTime = (unixSeconds) => {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(unixSeconds * 1e3));
};

export var formatCoinAmount = (freeCoins, premiumCoins) => {
  const parts = [];
  if (freeCoins > 0) {
    parts.push(`\u30D5\u30EA\u30FC\u30B3\u30A4\u30F3${freeCoins}\u679A`);
  }
  if (premiumCoins > 0) {
    parts.push(`\u30D7\u30EC\u30DF\u30A2\u30E0\u30B3\u30A4\u30F3${premiumCoins}\u679A`);
  }
  return parts.join("\u3001");
};

export var createGrantEvent = (freeCoins, premiumCoins, expiresAt) => ({
  kind: "GRANT",
  message: expiresAt === null ? `${formatCoinAmount(freeCoins, premiumCoins)}\u304C\u4ED8\u4E0E\u3055\u308C\u307E\u3057\u305F\u3002` : expiresAt === void 0 ? `${formatCoinAmount(freeCoins, premiumCoins)}\u304C\u4ED8\u4E0E\u3055\u308C\u307E\u3057\u305F\u3002\u6709\u52B9\u671F\u9650\u306F\u672C\u65E524:00\u3067\u3059\u3002` : `${formatCoinAmount(freeCoins, premiumCoins)}\u304C\u4ED8\u4E0E\u3055\u308C\u307E\u3057\u305F\u3002\u6709\u52B9\u671F\u9650\u306F${formatJstDateTime(expiresAt)}\u3067\u3059\u3002`,
  freeCoins,
  premiumCoins
});

export var createConsumeEvent = (freeCoins, premiumCoins) => ({
  kind: "CONSUME",
  message: `${formatCoinAmount(freeCoins, premiumCoins)}\u3092\u6D88\u8CBB\u3057\u307E\u3057\u305F\u3002`,
  freeCoins,
  premiumCoins
});

export var createExpireEvent = (freeCoins, premiumCoins) => ({
  kind: "EXPIRE",
  message: `\u6709\u52B9\u671F\u9650\u3092\u904E\u304E\u305F\u305F\u3081\u3001${formatCoinAmount(freeCoins, premiumCoins)}\u304C\u5931\u52B9\u3057\u307E\u3057\u305F\u3002`,
  freeCoins,
  premiumCoins
});
