// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { getNow } from "./db"
import { escapeHtml } from "./subscription-cancellation-email"
import { unsubscribeUrl } from "./retention"
import { getStripe, getStripeCustomerEmail } from "./subscription-stripe"

/**
 * 入ったばかりの会員で、最初の日のあと生成していない人に 1 回だけ使い方を知らせる
 * - 加入 1 か月以内の解約が解約全体の半分を超える。その多くは加入した日に数枚作っただけで、その後 1 度も生成していない
 *   （続いている人との違いは、加入 1 週間より後にも生成しているかどうか）
 * - 対象は加入から 2〜10 日の人だけ。長く続けている人には送らない
 */

var DAY = 86400;
var PLAN_NAME = { LITE: "ライト", STANDARD: "スタンダード", PREMIUM: "プレミアム" };
var PLAN_NAME_EN = { LITE: "Lite", STANDARD: "Standard", PREMIUM: "Premium" };
var DAILY_COINS = { LITE: 500, STANDARD: 1000, PREMIUM: 2000 };

/**
 * 言語が分かっていれば（locale が "en" / "ja"）その言語だけ、分からなければ日本語と英語の両方
 */
export var buildNewSubscriberNudgeEmail = (props) => {
  const plan = PLAN_NAME[props.passType] ?? props.passType;
  const planEn = PLAN_NAME_EN[props.passType] ?? props.passType;
  const daily = DAILY_COINS[props.passType] ?? 0;
  const images = daily / 10;
  const isStandardOrAbove = props.passType === "STANDARD" || props.passType === "PREMIUM";
  const button = (href, label) =>
    `<p><a href="${href}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${label}</a></p>`;
  const japanese = [
    `<p>Aipictors+（${escapeHtml(plan)}）にご加入いただきありがとうございます。</p>`,
    `<p>${escapeHtml(plan)}では、<b>毎日 ${daily.toLocaleString("ja-JP")} コイン（ふつうの生成で約 ${images} 枚分）</b>が届いています。その日に使わなかった分は翌日に持ち越せないので、少しずつでも使うのがおすすめです。</p>`,
    "<p>このプランでできること:</p>",
    "<ul>",
    "<li>1 回の生成で 4 枚まとめて作る（気に入った 1 枚を選べます）</li>",
    "<li>画像から画像を作る（img2img）、Nano Banana での生成</li>",
    isStandardOrAbove ? "<li>優先生成（混んでいても先に作られます）、予約生成（寝ている間にまとめて作る）</li>" : "",
    "<li>ほかの人が公開している「みんなのモデル」を使う</li>",
    "<li>広告なし、プラン限定のアイコン枠</li>",
    "</ul>",
    button("https://www.aipictors.com/generation", "画像を生成する"),
    "<p>使い方が分からない・思ったように作れないときは、<a href=\"https://www.aipictors.com/support/chat\">お問い合わせ</a>からお気軽にどうぞ。</p>",
    props.optout ? `<p style="color:#9ca3af;font-size:12px"><a href="${props.optout}" style="color:#9ca3af">このようなお知らせを受け取らない</a></p>` : ""
  ];
  const english = [
    `<p>Thank you for joining Aipictors+ (${escapeHtml(planEn)}).</p>`,
    `<p>With ${escapeHtml(planEn)}, you receive <b>${daily.toLocaleString("en-US")} coins every day (about ${images} standard images)</b>. Coins you don't use that day don't carry over, so it's worth using a few each day.</p>`,
    "<p>What your plan includes:</p>",
    "<ul>",
    "<li>4 images per generation (pick the one you like)</li>",
    "<li>Image-to-image and Nano Banana generation</li>",
    isStandardOrAbove ? "<li>Priority generation (you go first when it's busy) and scheduled generation</li>" : "",
    "<li>Community models shared by other users</li>",
    "<li>No ads, and plan-only avatar frames</li>",
    "</ul>",
    button("https://www.aipictors.com/en/generation", "Generate images"),
    "<p>If something isn't working the way you expected, <a href=\"https://www.aipictors.com/en/support/chat\">contact us</a> anytime.</p>",
    props.optout ? `<p style="color:#9ca3af;font-size:12px"><a href="${props.optout}" style="color:#9ca3af">Stop receiving emails like this</a></p>` : ""
  ];
  const divider = '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">';
  const body = props.locale === "en" ? english : props.locale === "ja" ? japanese : [...japanese, divider, ...english];
  const subjectJa = `【Aipictors】毎日 ${daily.toLocaleString("ja-JP")} コインが届いています`;
  const subjectEn = `[Aipictors] Your ${daily.toLocaleString("en-US")} daily coins are waiting`;
  return {
    subject: props.locale === "en" ? subjectEn : props.locale === "ja" ? subjectJa : `${subjectJa} / Your daily coins are waiting`,
    html: ['<div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;line-height:1.8;color:#111827">', ...body, "</div>"].join("")
  };
};

/**
 * 加入から 2〜10 日で、加入の 24 時間後から 1 度も生成していない人に、契約ごとに一度だけ知らせる（毎日の定期処理から呼ぶ）
 */
export var sendNewSubscriberNudges = async (env, db) => {
  if (!env.RESEND_API_KEY || !env.STRIPE_SECRET_KEY) return { sent: 0, skipped: "not configured" };
  const now = getNow();
  const rows = await db.query(
    `SELECT s.user_id, s.type, s.stripe_subscription_id
       FROM subscriptions s
      WHERE s.status IN ('paid', 'active', 'trialing', 'cancellation_requested') AND s.is_disabled = FALSE
        AND s.type IN ('LITE', 'STANDARD', 'PREMIUM')
        AND s.stripe_subscription_id LIKE 'sub_%'
        AND s.created_at BETWEEN $1 AND $2
        AND s.current_period_end > $3
        AND NOT EXISTS (SELECT 1 FROM subscriptions p WHERE p.user_id = s.user_id AND p.id <> s.id AND p.current_period_end > s.created_at - 30 * 86400)
        AND NOT EXISTS (SELECT 1 FROM coin_ledger l WHERE l.user_id = s.user_id AND l.kind = 'CONSUME'
                           AND l.reason LIKE 'image-generation%' AND l.created_at > s.created_at + 86400)
        AND NOT EXISTS (SELECT 1 FROM email_optouts o WHERE o.user_id = s.user_id)
        AND NOT EXISTS (SELECT 1 FROM email_campaign_sends e WHERE e.campaign = 'new-subscriber-nudge:' || s.stripe_subscription_id)
      LIMIT 50`,
    [now - 10 * DAY, now - 2 * DAY, now + DAY]
  );
  const secret = env.INTERNAL_API_TOKEN ?? env.AIPICTORS_API_INTERNAL_TOKEN;
  const from = `Aipictors <${env.RESEND_FROM_EMAIL ?? "noreply@info.aipictors.com"}>`;
  let sent = 0;
  for (const row of rows) {
    const stripeSubscription = await getStripe(env.STRIPE_SECRET_KEY, `/subscriptions/${row.stripe_subscription_id}`).catch(() => null);
    // 支払いが止まっている・すでに終わった契約には送らない
    if (!["active", "trialing"].includes(stripeSubscription?.status ?? "")) continue;
    const customerId = typeof stripeSubscription?.customer === "string" ? stripeSubscription.customer : null;
    const email = await getStripeCustomerEmail(env.STRIPE_SECRET_KEY, customerId, row.stripe_subscription_id).catch(() => null);
    if (!email) continue;
    const optout = secret ? await unsubscribeUrl(secret, String(row.user_id)) : null;
    const message = buildNewSubscriberNudgeEmail({
      passType: row.type,
      locale: stripeSubscription?.metadata?.locale ?? null,
      optout
    });
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [email],
        subject: message.subject,
        html: message.html,
        headers: optout ? { "List-Unsubscribe": `<${optout}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined
      })
    });
    const resJson = await response.json().catch(() => null);
    if (!response.ok) {
      console.error(JSON.stringify({ event: "new_subscriber_nudge.send_failed", message: resJson?.message ?? response.status }));
      break;
    }
    await db.execute(
      `INSERT INTO email_campaign_sends(campaign, user_id, email, sent_at, resend_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [`new-subscriber-nudge:${row.stripe_subscription_id}`, String(row.user_id), email, getNow(), resJson?.id ?? null]
    );
    sent += 1;
  }
  return { sent, candidates: rows.length };
};
