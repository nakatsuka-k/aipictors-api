// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { Hono as Hono2 } from "hono"
import { runDailyCoinJob } from "./lib/daily-coins"
import { getDb, getNow } from "./lib/db"
import { json } from "./lib/json"
import { adminRoutes } from "./routes/admin"
import { coinsRoutes, publicCoinsRoutes } from "./routes/coins"
import { imageGenerationRoutes } from "./routes/image-generation"
import { pointsRoutes } from "./routes/points"
import { stripeRoutes } from "./routes/stripe"
import { subscriptionRoutes } from "./routes/subscriptions"
import { userModelsRoutes } from "./routes/user-models"
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
app.route("/internal/user-models", userModelsRoutes);
app.route("/admin", adminRoutes);
app.route("/stripe", stripeRoutes);
app.route("/webhooks", webhookRoutes);
app.notFound(() => json({ error: "Not found" }, 404));
app.onError((error) => json({ error: error.message }, 500));

// 毎日 00:00 JST（15:00 UTC）に日次コインの失効・付与。00:30 JST に再実行して取りこぼしを拾う（何度実行しても同じ結果）
const scheduled = async (_controller, env, ctx) => {
  ctx.waitUntil(
    (async () => {
      const db = await getDb(env);
      const result = await runDailyCoinJob(db, getNow());
      console.log(JSON.stringify({ event: "coins.daily_job.done", ...result }));
    })()
  );
};

export default { fetch: app.fetch, scheduled }

// URL からのモデル取り込み（wrangler.toml の [[workflows]]）
export { UserModelImportWorkflow } from "./workflows/user-model-import"
