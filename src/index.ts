// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { Hono as Hono2 } from "hono"
import { json } from "./lib/json"
import { adminRoutes } from "./routes/admin"
import { coinsRoutes, publicCoinsRoutes } from "./routes/coins"
import { imageGenerationRoutes } from "./routes/image-generation"
import { pointsRoutes } from "./routes/points"
import { stripeRoutes } from "./routes/stripe"
import { subscriptionRoutes } from "./routes/subscriptions"
import { webhookRoutes } from "./routes/webhooks"
const app = new Hono2();
app.get("/healthz", (c) => {
  return json({ ok: true, service: "aipictors-api" });
});
app.route("/internal/coins", coinsRoutes);
app.route("/api/coins", publicCoinsRoutes);
app.route("/internal/image-generation", imageGenerationRoutes);
app.route("/internal/points", pointsRoutes);
app.route("/internal/subscriptions", subscriptionRoutes);
app.route("/admin", adminRoutes);
app.route("/stripe", stripeRoutes);
app.route("/webhooks", webhookRoutes);
app.notFound(() => json({ error: "Not found" }, 404));
app.onError((error) => json({ error: error.message }, 500));

export default app
