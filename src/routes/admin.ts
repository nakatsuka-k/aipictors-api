// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { Hono as Hono2 } from "hono"
import { number, object, safeParse } from "valibot"
import { requireAdminAuth } from "../lib/auth"
import { getDb } from "../lib/db"
import { json } from "../lib/json"
import { getPricingSettings, upsertPricingSettings } from "../lib/pricing"
export var pricingSchema = object({
  yenPerPoint: number(),
  pointPackages: object({
    "100": number(),
    "300": number(),
    "1000": number()
  }),
  subscriptionPlans: object({
    LITE: number(),
    STANDARD: number(),
    PREMIUM: number()
  })
});
export var adminRoutes = new Hono2();
adminRoutes.use("*", requireAdminAuth);
adminRoutes.get("/pricing", async (c) => {
  const db = await getDb(c.env);
  return json({ error: null, data: await getPricingSettings(db) });
});
adminRoutes.put("/pricing", async (c) => {
  const parsed = safeParse(pricingSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  await upsertPricingSettings(db, parsed.output);
  return json({ error: null, data: await getPricingSettings(db) });
});
