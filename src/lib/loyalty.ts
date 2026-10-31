// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { applyCoinDelta } from "./coins"

/**
 * 継続ボーナス（更新のたびに付けるプレミアムコイン、期限なし）
 * 新しく入る人の初月半額だけでなく、続けている人ほど得になるように
 */
export var RENEWAL_BONUS_COINS = {
  LITE: 100,
  STANDARD: 300,
  PREMIUM: 600
};

/**
 * 今の会員への感謝コイン（初月半額を始めたときに 1 回だけ）
 */
export var THANKS_COINS = {
  LITE: 1000,
  STANDARD: 2000,
  PREMIUM: 4000
};

export var grantRenewalBonus = async (props) => {
  const amount = RENEWAL_BONUS_COINS[props.passType] ?? 0;
  if (!props.userId || amount <= 0 || !props.invoiceId) return null;
  // 最近使っていない会員には何もしない（コインの付与で使っていないことに気づいて解約するきっかけにならないように）
  const recent = await props.db.queryOne(
    `SELECT 1 FROM generated_queues
      WHERE user_id = $1::bigint AND request_time > NOW() - INTERVAL '30 days' LIMIT 1`,
    [props.userId]
  );
  if (!recent) return null;
  const source = `renewal_bonus:${props.invoiceId}`;
  const existing = await props.db.queryOne(
    "SELECT id FROM coin_ledger WHERE user_id = $1 AND source = $2 LIMIT 1",
    [props.userId, source]
  );
  if (existing) return null;
  return applyCoinDelta({
    db: props.db,
    userId: props.userId,
    freeDelta: 0,
    premiumDelta: amount,
    kind: "GRANT",
    reason: `継続ボーナス（${props.passType}）`,
    source
  });
};

/**
 * 感謝コインを付ける（同じ人に 2 回は付けない）
 */
export var grantThanksCoins = async (props) => {
  const amount = THANKS_COINS[props.passType] ?? 0;
  if (!props.userId || amount <= 0) return null;
  const source = `thanks:${props.campaign}`;
  const existing = await props.db.queryOne(
    "SELECT id FROM coin_ledger WHERE user_id = $1 AND source = $2 LIMIT 1",
    [props.userId, source]
  );
  if (existing) return { skipped: true, amount: 0 };
  await applyCoinDelta({
    db: props.db,
    userId: props.userId,
    freeDelta: 0,
    premiumDelta: amount,
    kind: "GRANT",
    reason: `いつもありがとうございます（${props.passType}）`,
    source
  });
  return { skipped: false, amount };
};
