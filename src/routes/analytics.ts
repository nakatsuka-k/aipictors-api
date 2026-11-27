// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { Hono as Hono2 } from "hono"
import { getBearer, getInternalApiToken } from "../lib/auth"
import {
  collectAnalyticsDay,
  collectAnalyticsUsersDay,
  collectAnalyticsUsersMonth,
  getCurrentSubscriptionCounts,
  getLiveProfitAndLoss,
  jstDayBefore,
  listAnalyticsDays,
  recollectCostItems,
} from "../lib/analytics"
import { listUsersMonths, nextMonth } from "../lib/analytics-users"
import { getCostBreakdown } from "../lib/cost-breakdown"
import { getDb, getNow } from "../lib/db"
import { json } from "../lib/json"
import { getLeaveReasonStats } from "../lib/leave-survey"
import { listEventSummary, rollupEventDay } from "../lib/event-log"

/**
 * 分析ページ（/admin/analytics）と運営の分析用の日別の数字
 * 内部トークンのほか、運営の分析用の ANALYTICS_READ_TOKEN でも使える（読む・集め直すだけで、利用者のデータは変えない）
 */
export var analyticsRoutes = new Hono2();

var isInternal = (c) => {
  const token = getBearer(c);
  const expected = getInternalApiToken(c);
  return Boolean(expected) && token === expected;
};

var canRead = (c) => {
  if (isInternal(c)) return true;
  const token = getBearer(c);
  return Boolean(c.env.ANALYTICS_READ_TOKEN) && token === c.env.ANALYTICS_READ_TOKEN;
};

analyticsRoutes.get("/daily", async (c) => {
  if (!canRead(c)) return json({ error: "Unauthorized" }, 401);
  const days = Math.min(Math.max(Number.parseInt(c.req.query("days") ?? "90", 10) || 90, 1), 400);
  const db = await getDb(c.env);
  const [rows, current] = await Promise.all([
    listAnalyticsDays(db, days),
    getCurrentSubscriptionCounts(db, getNow()),
  ]);
  return json({ days: rows, current: { subscriptions: current, at: getNow() } });
});

/** 解約・退会の理由と追加質問の集計（?days=90、最大 365） */
analyticsRoutes.get("/leave-reasons", async (c) => {
  if (!canRead(c)) return json({ error: "Unauthorized" }, 401);
  const days = Math.min(Math.max(Number.parseInt(c.req.query("days") ?? "90", 10) || 90, 1), 365);
  const db = await getDb(c.env);
  return json(await getLeaveReasonStats(db, days));
});

/** 収支（今日のここまで・今月・月末の見込み）。?fresh=1 で 10 分のキャッシュを使わない */
analyticsRoutes.get("/pnl", async (c) => {
  if (!canRead(c)) return json({ error: "Unauthorized" }, 401);
  const db = await getDb(c.env);
  return json(await getLiveProfitAndLoss(c.env, db, getNow(), { fresh: c.req.query("fresh") === "1" }));
});

/** 維持費の内訳（今の RunPod の構成と、ほかのサービスの直近 7 日の平均から月額を出す）。?fresh=1 で 5 分のキャッシュを使わない */
analyticsRoutes.get("/costs/breakdown", async (c) => {
  if (!canRead(c)) return json({ error: "Unauthorized" }, 401);
  const db = await getDb(c.env);
  return json(await getCostBreakdown(c.env, db, getNow(), { fresh: c.req.query("fresh") === "1" }));
});

/**
 * 指定した日を集め直す（毎日の自動集計に加えて、始める前の日を埋めるときに使う）
 * { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }。1 回 31 日まで、古い日から順に
 */
analyticsRoutes.post("/collect", async (c) => {
  if (!canRead(c)) return json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  const to = pattern.test(body.to ?? "") ? body.to : jstDayBefore(getNow(), 1);
  const from = pattern.test(body.from ?? "") ? body.from : to;
  const days = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && days.length < 31; t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  const db = await getDb(c.env);
  const results = [];
  for (const day of days) {
    const { metrics } = await collectAnalyticsDay(c.env, db, day);
    results.push({ day, errors: metrics.errors });
  }
  return json({ results });
});

/**
 * 費用だけを集め直す（数え方を直したとき。生成数・利用者などは読まない）
 * { from: "YYYY-MM-DD", to: "YYYY-MM-DD", only: ["openai"] }。1 回 31 日まで
 */
analyticsRoutes.post("/costs/collect", async (c) => {
  if (!canRead(c)) return json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(body.from ?? "") || !pattern.test(body.to ?? "") || !Array.isArray(body.only)) {
    return json({ error: "Invalid range" }, 400);
  }
  const db = await getDb(c.env);
  const results = [];
  for (let t = Date.parse(`${body.from}T00:00:00Z`); t <= Date.parse(`${body.to}T00:00:00Z`) && results.length < 31; t += 86400000) {
    results.push(await recollectCostItems(c.env, db, new Date(t).toISOString().slice(0, 10), body.only));
  }
  return json({ results });
});

/** 利用者の月別の数字（登録・投稿した人・いいねした人）。サービス開始からの推移 */
analyticsRoutes.get("/users/monthly", async (c) => {
  if (!canRead(c)) return json({ error: "Unauthorized" }, 401);
  const db = await getDb(c.env);
  return json({ months: await listUsersMonths(db) });
});

/**
 * 利用者の数字を集め直す（始める前の期間を埋めるとき）
 * { months: { from: "YYYY-MM", to: "YYYY-MM" } } は月別（1 回 6 か月まで）、{ from: "YYYY-MM-DD", to: "YYYY-MM-DD" } は日別（1 回 31 日まで）
 */
analyticsRoutes.post("/users/collect", async (c) => {
  if (!canRead(c)) return json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const db = await getDb(c.env);
  const results = [];
  if (body.months) {
    const pattern = /^\d{4}-\d{2}$/;
    if (!pattern.test(body.months.from ?? "") || !pattern.test(body.months.to ?? "")) return json({ error: "Invalid months" }, 400);
    for (let month = body.months.from; month <= body.months.to && results.length < 6; month = nextMonth(month)) {
      results.push(await collectAnalyticsUsersMonth(c.env, db, month));
    }
    return json({ results });
  }
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(body.from ?? "") || !pattern.test(body.to ?? "")) return json({ error: "Invalid range" }, 400);
  for (let t = Date.parse(`${body.from}T00:00:00Z`); t <= Date.parse(`${body.to}T00:00:00Z`) && results.length < 31; t += 86400000) {
    results.push(await collectAnalyticsUsersDay(c.env, db, new Date(t).toISOString().slice(0, 10)));
  }
  return json({ results });
});

/**
 * 操作の記録の日別のまとめ（lib/event-log.ts）。?from=YYYY-MM-DD&to=YYYY-MM-DD（既定は直近 30 日）
 * &kind=events（既定。&event= で前方一致）| funnels | pages | paths | entries | sources（流入元ごとのサブスクまでの到達、期間の合計）| runs
 */
analyticsRoutes.get("/events", async (c) => {
  if (!canRead(c)) return json({ error: "Unauthorized" }, 401);
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  const to = pattern.test(c.req.query("to") ?? "") ? c.req.query("to") : jstDayBefore(getNow(), 1);
  const from = pattern.test(c.req.query("from") ?? "") ? c.req.query("from") : jstDayBefore(getNow(), 30);
  const kind = c.req.query("kind") ?? "events";
  if (!["events", "funnels", "pages", "paths", "entries", "sources", "runs"].includes(kind)) return json({ error: "Invalid kind" }, 400);
  const db = await getDb(c.env);
  const rows = await listEventSummary(db, { from, to, kind, event: c.req.query("event") ?? "" });
  return json({ from, to, kind, rows });
});

/** 操作の記録のまとめを作り直す { day: "YYYY-MM-DD" }（既定は前日。生が残っている 90 日まで） */
analyticsRoutes.post("/events/rollup", async (c) => {
  if (!canRead(c)) return json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const day = /^\d{4}-\d{2}-\d{2}$/.test(body.day ?? "") ? body.day : jstDayBefore(getNow(), 1);
  const db = await getDb(c.env);
  try {
    return json(await rollupEventDay(c.env, db, day));
  } catch (error) {
    return json({ error: String(error?.message ?? error).slice(0, 300) }, 502);
  }
});
