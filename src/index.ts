// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { app } from "./app"
import { fillRecommendedSettings } from "./lib/user-model-recommendations";
import { runDailyCoinJob } from "./lib/daily-coins"
import { sendCancelReminders } from "./lib/retention"
import { getDb, getNow } from "./lib/db"
import { collectAnalyticsDay, jstDayBefore } from "./lib/analytics"
import { runDiscordSyncBatch, sendCoinExpiryDms } from "./lib/discord"
import { getStripeCustomerEmail } from "./routes/subscriptions"
// 毎日 00:00 JST（15:00 UTC）に日次コインの失効・付与。00:30 JST に再実行して取りこぼしを拾う（何度実行しても同じ結果）
const scheduled = async (controller, env, ctx) => {
  // 移行中の読み取り専用のときは定期処理も止める（00:30 の再実行で取りこぼしは拾える）
  if (env.READ_ONLY === "1") return;
  ctx.waitUntil(
    (async () => {
      const db = await getDb(env);
      // 5 分ごと: おすすめ設定のないチェックポイントに自動で入れる
      if (controller?.cron === "*/5 * * * *") {
        // Discord 連携の反映（準備が済むまでは何もしない）
        if (env.DISCORD_BOT_TOKEN) {
          const discordResult = await runDiscordSyncBatch(env, db, 25).catch((error) => {
            console.log(JSON.stringify({ event: "discord.sync.batch_failed", message: String(error?.message ?? error) }));
            return null;
          });
          if (discordResult && discordResult.synced + discordResult.failed > 0) {
            console.log(JSON.stringify({ event: "discord.sync.done", ...discordResult }));
          }
        }
        const result = await fillRecommendedSettings({
          db,
          fetch: (input, init) => fetch(input, init),
          limit: 5,
          now: Math.floor(Date.now() / 1000),
        });
        if (result.checked > 0) {
          console.log(JSON.stringify({ event: "user_models.recommend.done", ...result }));
        }
        return;
      }
      // 10:00 JST: 解約予約中であと 2〜3 日で終わる人へのお知らせ
      if (controller?.cron === "0 1 * * *") {
        const result = await sendCancelReminders(env, db, getStripeCustomerEmail);
        console.log(JSON.stringify({ event: "retention.cancel_reminders.done", ...result }));
        if (env.DISCORD_BOT_TOKEN) {
          const expiryResult = await sendCoinExpiryDms(env, db).catch((error) => {
            console.log(JSON.stringify({ event: "discord.expiry_dm.batch_failed", message: String(error?.message ?? error) }));
            return null;
          });
          if (expiryResult) console.log(JSON.stringify({ event: "discord.expiry_dm.done", ...expiryResult }));
        }
        return;
      }
      const result = await runDailyCoinJob(db, getNow());
      console.log(JSON.stringify({ event: "coins.daily_job.done", ...result }));
      // 00:30 JST: 前日の分析用の数字を保存する（00:00 の回は日付が変わった直後なので 00:30 だけ）
      if (controller?.cron === "30 15 * * *") {
        const day = jstDayBefore(getNow(), 1);
        const analytics = await collectAnalyticsDay(env, db, day).catch((error) => {
          console.log(JSON.stringify({ event: "analytics.daily.failed", day, message: String(error?.message ?? error) }));
          return null;
        });
        if (analytics) console.log(JSON.stringify({ event: "analytics.daily.done", day, errors: analytics.metrics.errors }));
      }
    })()
  );
};

export default { fetch: app.fetch, scheduled }

// URL からのモデル取り込み（wrangler.toml の [[workflows]]）
export { UserModelImportWorkflow } from "./workflows/user-model-import"
