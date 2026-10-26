// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { Hono as Hono2 } from "hono"
import { number, object, safeParse, string } from "valibot"
import { requireInternalAuth } from "../lib/auth"
import { getDb } from "../lib/db"
import { json } from "../lib/json"
import { applyPointDelta, getPointSummary } from "../lib/points"
export var transactionSchema = object({
  userId: string(),
  points: number(),
  reason: string()
});
export var pointsRoutes = new Hono2();
pointsRoutes.use("*", requireInternalAuth);
pointsRoutes.get("/:userId", async (c) => {
  const db = await getDb(c.env);
  const summary = await getPointSummary(db, c.req.param("userId"));
  return json({ error: null, data: summary });
});
pointsRoutes.post("/grant", async (c) => {
  const parsed = safeParse(transactionSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  await applyPointDelta({
    db,
    userId: parsed.output.userId,
    delta: Math.floor(parsed.output.points),
    kind: "GRANT",
    reason: parsed.output.reason
  });
  return json({ error: null, data: await getPointSummary(db, parsed.output.userId) });
});
pointsRoutes.post("/consume", async (c) => {
  const parsed = safeParse(transactionSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  const result = await applyPointDelta({
    db,
    userId: parsed.output.userId,
    delta: -Math.floor(parsed.output.points),
    kind: "CONSUME",
    reason: parsed.output.reason
  });
  if (!result.ok) {
    return json({ error: "Insufficient points" }, 409);
  }
  return json({ error: null, data: await getPointSummary(db, parsed.output.userId) });
});
