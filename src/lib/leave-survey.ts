// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { getNow } from "./db"

/**
 * 解約・退会の理由の深掘り
 * - 主な理由（解約は retention.ts の CANCEL_REASONS、退会は ACCOUNT_LEAVE_REASONS）に、理由ごとの追加質問（複数選択）と自由記述を付けて残す
 * - 質問の文言と選択肢は画面側（Web: app/utils/leave-survey.ts、アプリ: lib/v2/settings/leave_survey.dart）が持つ。ここでは形だけ確かめる
 * - details の形: {"choices":{"group":["key", ...]},"text":"理由の詳しい説明","improvement":"改善してほしいこと","source":"web|ios|android"}
 */

export var ACCOUNT_LEAVE_REASONS = {
  not_using: "あまり使わなくなった",
  privacy: "身バレ・個人情報が心配",
  harassment: "嫌なコメント・やりとりがあった",
  community: "サイトの雰囲気・ルールが合わない",
  not_popular: "作品を見てもらえない・反応が少ない",
  quality: "生成の品質・不具合が気になった",
  cost: "料金・コインが合わない",
  other_service: "ほかのサービスに移る",
  new_account: "アカウントを作り直したい",
  other: "その他"
};

export var ACCOUNT_LEAVE_OUTCOMES = ["withdraw", "pause"];

var KEY = /^[a-z0-9_]{1,40}$/;
var SOURCES = ["web", "ios", "android", "app"];

var cleanText = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) || null : null);

/** 画面から来た details を、保存してよい形にする（知らない形は捨てる。空なら null） */
export var sanitizeLeaveDetails = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const choices = {};
  let groups = 0;
  if (input.choices && typeof input.choices === "object" && !Array.isArray(input.choices)) {
    for (const [group, keys] of Object.entries(input.choices)) {
      if (!KEY.test(group) || !Array.isArray(keys) || groups >= 6) continue;
      const picked = [...new Set(keys.filter((key) => typeof key === "string" && KEY.test(key)))].slice(0, 12);
      if (picked.length === 0) continue;
      choices[group] = picked;
      groups++;
    }
  }
  const text = cleanText(input.text, 500);
  const improvement = cleanText(input.improvement, 1000);
  const source = SOURCES.includes(input.source) ? input.source : null;
  if (groups === 0 && !text && !improvement) return source ? { source } : null;
  return {
    ...(groups > 0 ? { choices } : {}),
    ...(text ? { text } : {}),
    ...(improvement ? { improvement } : {}),
    ...(source ? { source } : {})
  };
};

export var saveAccountLeaveReason = async (db, props) => {
  const reason = typeof props.reason === "string" && props.reason in ACCOUNT_LEAVE_REASONS ? props.reason : null;
  if (!reason) return false;
  const outcome = ACCOUNT_LEAVE_OUTCOMES.includes(props.outcome) ? props.outcome : null;
  const details = sanitizeLeaveDetails(props.details);
  await db.execute(
    `INSERT INTO account_leave_reasons(user_id, reason, outcome, note, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [String(props.userId), reason, outcome, cleanText(props.note, 500), details ? JSON.stringify(details) : null, getNow()]
  );
  return true;
};

var parseDetails = (value) => {
  if (typeof value !== "string" || value === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/**
 * 理由・追加質問の集計
 * rows: { reason, details, note, created_at, ...extra }
 * 返り値: summary（理由ごとの人数）、choices（理由ごと・質問ごと・選択肢ごとの人数）、texts（自由記述。新しい順に 100 件）
 */
export var summarizeLeaveRows = (rows, extraKeys = []) => {
  const summary = {};
  const choices = {};
  const texts = [];
  for (const row of rows) {
    const reason = row.reason;
    summary[reason] ??= { reason, count: 0, months: [] };
    summary[reason].count++;
    if (typeof row.months === "number") summary[reason].months.push(row.months);
    if (row.outcome) {
      summary[reason].outcomes ??= {};
      summary[reason].outcomes[row.outcome] = (summary[reason].outcomes[row.outcome] ?? 0) + 1;
    }
    const details = parseDetails(row.details);
    for (const [group, keys] of Object.entries(details?.choices ?? {})) {
      if (!Array.isArray(keys)) continue;
      for (const key of keys) {
        const id = `${reason}.${group}.${key}`;
        choices[id] = (choices[id] ?? 0) + 1;
      }
    }
    // 「pause」は 1 か月休止のときに入れていた印なので、自由記述としては出さない
    const note = row.note && row.note !== "pause" ? row.note : null;
    if ((note || details?.text || details?.improvement) && texts.length < 100) {
      const item = {
        reason,
        note,
        text: details?.text ?? null,
        improvement: details?.improvement ?? null,
        source: details?.source ?? null,
        created_at: row.created_at
      };
      for (const key of extraKeys) item[key] = row[key] ?? null;
      texts.push(item);
    }
  }
  return {
    total: rows.length,
    withDetails: rows.filter((row) => row.details).length,
    summary: Object.values(summary)
      .map((item) => ({
        reason: item.reason,
        count: item.count,
        avgMonths: item.months.length > 0 ? Math.round((item.months.reduce((a, b) => a + b, 0) / item.months.length) * 10) / 10 : null,
        ...(item.outcomes ? { outcomes: item.outcomes } : {})
      }))
      .sort((a, b) => b.count - a.count),
    choices: Object.entries(choices)
      .map(([id, count]) => {
        const [reason, group, key] = id.split(".");
        return { reason, group, key, count };
      })
      .sort((a, b) => b.count - a.count),
    texts
  };
};

/** 直近 days 日の解約・退会の理由（/admin/analytics）。期間は created_at の索引で読む */
export var getLeaveReasonStats = async (db, days) => {
  const since = getNow() - days * 86400;
  const [subscription, account] = await Promise.all([
    db.query(
      `SELECT reason, pass_type, months, note, details, created_at FROM subscription_cancel_reasons
        WHERE created_at > $1 ORDER BY created_at DESC LIMIT 5000`,
      [since]
    ),
    db.query(
      `SELECT reason, outcome, note, details, created_at FROM account_leave_reasons
        WHERE created_at > $1 ORDER BY created_at DESC LIMIT 5000`,
      [since]
    )
  ]);
  return {
    days,
    since,
    subscription: summarizeLeaveRows(subscription, ["pass_type", "months"]),
    account: summarizeLeaveRows(account, ["outcome"])
  };
};
