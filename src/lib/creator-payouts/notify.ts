// @ts-nocheck
// 振込のお知らせ（Resend）。本人には送金したとき・送金できなかったとき、運営には失敗と承認待ちを送る。同じ知らせは 1 回だけ
import { getNow } from "../db"
import { getCreatorPayoutConfig } from "./config"

const yen = (n) => `${Number(n ?? 0).toLocaleString("ja-JP")}円`

const sendOnce = async ({ env, db, campaign, userId, to, subject, html }) => {
  if (!env.RESEND_API_KEY || !to) return false
  const already = await db.queryOne("SELECT 1 AS ok FROM email_campaign_sends WHERE campaign = $1 LIMIT 1", [campaign])
  if (already) return false
  const from = `Aipictors <${env.RESEND_FROM_EMAIL ?? "noreply@info.aipictors.com"}>`
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html }),
  })
  const json = await response.json().catch(() => null)
  if (!response.ok) {
    console.error(JSON.stringify({ event: "creator_payouts.notify_failed", campaign, message: json?.message ?? response.status }))
    return false
  }
  await db.execute(
    `INSERT INTO email_campaign_sends(campaign, user_id, email, sent_at, resend_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [campaign, String(userId ?? ""), to, getNow(), json?.id ?? null],
  )
  return true
}

/** sendReadyPayouts の notify に渡す関数を作る */
export const createPayoutNotifier = (env, db) => {
  const config = getCreatorPayoutConfig(env)
  const page = `${config.siteOrigin}/settings/creator-rewards`
  return async (event) => {
    try {
      if (event.type === "sent") {
        await sendOnce({
          env,
          db,
          campaign: `creator-payout:${event.payoutId}:sent`,
          userId: event.userId,
          to: event.email,
          subject: `【Aipictors】${event.period} 分のクリエイター報酬 ${yen(event.netYen)} を送金しました`,
          html: `<p>Aipictors をご利用いただきありがとうございます。</p>
<p>${event.period} 分のクリエイター報酬 <strong>${yen(event.netYen)}</strong>（源泉徴収税と振込手数料を差し引いた額）を Stripe へ送金しました。登録された銀行口座へは Stripe から数営業日で入金されます。</p>
<p>明細は <a href="${page}">クリエイター報酬のページ</a> で確認できます。</p>`,
        })
      }
      if (event.type === "failed") {
        await sendOnce({
          env,
          db,
          campaign: `creator-payout:${event.payoutId}:failed:user`,
          userId: event.userId,
          to: event.email,
          subject: `【Aipictors】${event.period} 分のクリエイター報酬を送金できませんでした`,
          html: `<p>${event.period} 分のクリエイター報酬（${yen(event.netYen)}）の送金ができませんでした。運営が確認し、あらためてご連絡します。口座の登録内容に不備がある場合は <a href="${page}">クリエイター報酬のページ</a> から口座情報をご確認ください。</p>`,
        })
        if (config.adminEmail) {
          await sendOnce({
            env,
            db,
            campaign: `creator-payout:${event.payoutId}:failed:admin`,
            userId: event.userId,
            to: config.adminEmail,
            subject: `[Aipictors 運営] クリエイター報酬の送金失敗 ${event.payoutId}`,
            html: `<p>${event.payoutId}（user ${event.userId}、${yen(event.netYen)}）の送金に失敗しました。</p><pre>${String(event.message ?? "").replace(/[<>&]/g, "")}</pre><p>${config.siteOrigin}/admin/creator-payouts</p>`,
          })
        }
      }
      if (event.type === "awaiting_approval" && config.adminEmail) {
        await sendOnce({
          env,
          db,
          campaign: `creator-payout-approval:${event.period}`,
          userId: "",
          to: config.adminEmail,
          subject: `[Aipictors 運営] ${event.period} のクリエイター報酬: 承認待ち ${event.count} 件`,
          html: `<p>${event.period} の締めで承認待ちの振込が ${event.count} 件（合計 ${yen(event.netYen)}）あります。</p><p>${config.siteOrigin}/admin/creator-payouts</p>`,
        })
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "creator_payouts.notify_error", message: String(error?.message ?? error) }))
    }
  }
}
