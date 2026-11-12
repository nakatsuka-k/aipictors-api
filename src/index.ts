import { runGenerationRetention } from "./lib/generation-retention"
// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { app } from "./app"
import { fillRecommendedSettings } from "./lib/user-model-recommendations";
import { runDailyCoinJob } from "./lib/daily-coins"
import { sendCancelReminders } from "./lib/retention"
import { sendPaymentFailedNotices } from "./lib/payment-failed-notice"
import { sendNewSubscriberNudges } from "./lib/new-subscriber-nudge"
import { getDb, getGenlogDb, getNow } from "./lib/db"
import { grantReferralActionRewards } from "./lib/referrals"
import { collectAnalyticsDay, jstDayBefore } from "./lib/analytics"
import { runDiscordSyncBatch, sendCoinExpiryDms } from "./lib/discord"
import { getStripeCustomerEmail } from "./routes/subscriptions"
import { runWeeklyPickup } from "./lib/user-model-pickups"
import { pickupDepsFromEnv } from "./routes/user-model-pickups"
import { runUserEventDigest } from "./lib/user-event-digest"
// 毎日 00:00 JST（15:00 UTC）に日次コインの失効・付与。00:30 JST に再実行して取りこぼしを拾う（何度実行しても同じ結果）
const scheduled = async (controller, env, ctx) => {
  ctx.waitUntil(
    (async () => {
      const db = await getDb(env);
      // 5 分ごと: おすすめ設定のないチェックポイントに自動で入れる
      if (controller?.cron === "*/5 * * * *") {
        const retention = await runGenerationRetention(env).catch((error) => {
          console.log(JSON.stringify({ event: "generation.retention.failed", message: String(error?.message ?? error) }));
          return null;
        });
        if (retention && retention.expired > 0) {
          console.log(JSON.stringify({ event: "generation.retention.done", ...retention }));
        }
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
        // 紹介特典: 紹介された人のはじめての生成・投稿を確かめて、紹介した人にコインを付ける（確かめる紹介がなければ 1 文読むだけ）
        const referral = await grantReferralActionRewards({
          db,
          genlog: env.GENLOG ? await getGenlogDb(env) : null,
          core: env.SYSTEM_CORE ?? null,
          env,
        }).catch((error) => {
          console.log(JSON.stringify({ event: "referral.action_rewards.failed", message: String(error?.message ?? error) }));
          return null;
        });
        if (referral && referral.granted > 0) console.log(JSON.stringify({ event: "referral.action_rewards.done", ...referral }));
        // 今週のピックアップモデル（週が変わって最初の回で選ぶ。決まっていれば読むだけ。モデルが使えなくなっていたら選び直す）
        const pickup = await runWeeklyPickup(await pickupDepsFromEnv(env)).catch((error) => {
          console.log(JSON.stringify({ event: "user_models.pickup.failed", message: String(error?.message ?? error) }));
          return null;
        });
        if (pickup && pickup.action !== "kept" && pickup.action !== "waiting") console.log(JSON.stringify({ event: "user_models.pickup.done", ...pickup }));
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
        // ユーザー主催のお題の主催者へ前日の参加数（お題ごとに 1 日 1 件）
        if (env.SYSTEM_CORE && env.SYSTEM_ACTIVITY) {
          const digest = await runUserEventDigest({ core: env.SYSTEM_CORE, activity: env.SYSTEM_ACTIVITY }, getNow()).catch((error) => {
            console.log(JSON.stringify({ event: "user_events.digest.failed", message: String(error?.message ?? error) }));
            return null;
          });
          if (digest) console.log(JSON.stringify({ event: "user_events.digest.done", ...digest }));
        }
        // 先に支払いの失敗のお知らせ（解約のリマインドが途中で失敗しても届くように、それぞれ失敗を受け止める）
        const failedNotices = await sendPaymentFailedNotices(env, db).catch((error) => {
          console.log(JSON.stringify({ event: "payment_failed_notice.batch_failed", message: String(error?.message ?? error) }));
          return null;
        });
        if (failedNotices) console.log(JSON.stringify({ event: "payment_failed_notice.done", ...failedNotices }));
        // 入ったばかりで、最初の日のあと生成していない会員への使い方のお知らせ
        const nudges = await sendNewSubscriberNudges(env, db).catch((error) => {
          console.log(JSON.stringify({ event: "new_subscriber_nudge.batch_failed", message: String(error?.message ?? error) }));
          return null;
        });
        if (nudges) console.log(JSON.stringify({ event: "new_subscriber_nudge.done", ...nudges }));
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
