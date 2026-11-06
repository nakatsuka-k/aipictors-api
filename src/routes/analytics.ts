// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { Hono as Hono2 } from "hono"
import { getBearer, getInternalApiToken } from "../lib/auth"
import {
  collectAnalyticsDay,
  getCurrentSubscriptionCounts,
  jstDayBefore,
  listAnalyticsDays,
} from "../lib/analytics"
import { getDb, getNow } from "../lib/db"
import { json } from "../lib/json"

/**
 * 分析ページ（/admin/analytics）と運営の分析用の日別の数字
 * 内部トークンのほか、読むだけの ANALYTICS_READ_TOKEN でも見られる（集め直しは内部トークンだけ）
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

/**
 * 指定した日を集め直す（毎日の自動集計に加えて、始める前の日を埋めるときに使う）
 * { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }。1 回 31 日まで、古い日から順に
 */
analyticsRoutes.post("/collect", async (c) => {
  if (!isInternal(c)) return json({ error: "Unauthorized" }, 401);
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
