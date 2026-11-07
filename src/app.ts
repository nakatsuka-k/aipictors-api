// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
// ルートの組み立て（index.ts は Worker の入口だけ。テストはここを直接呼ぶ）
import { Hono as Hono2 } from "hono"
import { json } from "./lib/json"
import { adminRoutes } from "./routes/admin"
import { analyticsRoutes } from "./routes/analytics"
import { campaignRoutes, emailPublicRoutes } from "./routes/campaigns"
import { coinsRoutes, publicCoinsRoutes } from "./routes/coins"
import { discordBotRoutes, discordRoutes } from "./routes/discord"
import { imageGenerationRoutes } from "./routes/image-generation"
import { pointsRoutes } from "./routes/points"
import { stripeRoutes } from "./routes/stripe"
import { subscriptionRoutes } from "./routes/subscriptions"
import { supportRoutes } from "./routes/support"
import { userModelsRoutes } from "./routes/user-models"
import { webhookRoutes } from "./routes/webhooks"
export const app = new Hono2();
// 移行中の読み取り専用（wrangler の vars か secret で READ_ONLY=1）。読むだけのリクエストは通し、書き込みは 503 で断る。
// Stripe の Webhook は 503 だと後で再送してくれる
const isReadRequest = (method, path) =>
  method === "GET" || method === "HEAD" || /\/query\//.test(path);
app.use("*", async (c, next) => {
  if (c.env?.READ_ONLY === "1" && !isReadRequest(c.req.method, c.req.path)) {
    return json({ error: "メンテナンス中のため、しばらくしてからもう一度お試しください", code: "MAINTENANCE" }, 503);
  }
  await next();
});
app.get("/healthz", (c) => {
  return json({ ok: true, service: "aipictors-api" });
});
app.route("/internal/coins", coinsRoutes);
app.route("/api/coins", publicCoinsRoutes);
app.route("/internal/image-generation", imageGenerationRoutes);
app.route("/internal/points", pointsRoutes);
app.route("/internal/subscriptions", subscriptionRoutes);
app.route("/internal/user-models", userModelsRoutes);
app.route("/admin", adminRoutes);
app.route("/internal/campaigns", campaignRoutes);
app.route("/internal/analytics", analyticsRoutes);
app.route("/internal/support", supportRoutes);
app.route("/internal/discord", discordRoutes);
app.route("/discord-bot", discordBotRoutes);
app.route("/email", emailPublicRoutes);
app.route("/stripe", stripeRoutes);
app.route("/webhooks", webhookRoutes);
app.notFound(() => json({ error: "Not found" }, 404));
app.onError((error) => json({ error: error.message }, 500));
