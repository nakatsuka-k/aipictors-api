// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { getNow } from "./db"
import { escapeHtml, formatJstDate } from "./subscription-cancellation-email"
import { getStripe, getStripeCustomerEmail } from "./subscription-stripe"

/**
 * 更新の支払いに失敗した人へのお知らせ
 * - 解約の 4 件に 1 件ほどが、本人の意思ではなく支払いの失敗（プリペイド・デビットの残高不足など）で終わっている
 * - 支払い直す画面は /plus にあるが、失敗したことを本人が知る手段がなかった
 * - 請求書ごとに 1 回だけ送る（Stripe の自動の再試行は止めない）
 */

var PLAN_NAME = { LITE: "ライト", STANDARD: "スタンダード", PREMIUM: "プレミアム" };
var PLAN_NAME_EN = { LITE: "Lite", STANDARD: "Standard", PREMIUM: "Premium" };

/**
 * 言語が分かっていれば（locale が "en" / "ja"）その言語だけ、分からなければ日本語と英語の両方
 */
export var buildPaymentFailedEmail = (props) => {
  const plan = PLAN_NAME[props.passType] ?? props.passType;
  const planEn = PLAN_NAME_EN[props.passType] ?? props.passType;
  const amount = `¥${Number(props.amount ?? 0).toLocaleString("ja-JP")}`;
  const retryText = formatJstDate(props.nextAttempt);
  const retryTextEn = props.nextAttempt
    ? new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric", month: "short", day: "numeric" }).format(new Date(props.nextAttempt * 1e3))
    : null;
  const button = (href, label) =>
    `<p><a href="${escapeHtml(href)}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${label}</a></p>`;
  const japanese = [
    "<p>Aipictors をご利用いただきありがとうございます。</p>",
    `<p>Aipictors+（${escapeHtml(plan)}）の更新のお支払い（<b>${amount}</b>）が完了していません。ご登録のカードで決済できませんでした（残高不足・有効期限切れ・カード会社による保留などが考えられます）。</p>`,
    "<p>下のボタンから、別のカードなどでお支払いいただけます。お支払いが完了すると、プランは今のまま続きます。</p>",
    button(props.invoiceUrl, "お支払いの画面を開く"),
    retryText
      ? `<p>何もしない場合は、${escapeHtml(retryText)} ごろに同じカードでもう一度決済を試みます。決済できないままのときは、プランは終了します。</p>`
      : "<p>決済できないままのときは、プランは終了します。</p>",
    "<p>新しく申し込み直す必要はありません（二重のご請求を避けるため、上のボタンからお支払いください）。困っていることがあれば、<a href=\"https://www.aipictors.com/support/chat\">お問い合わせ</a>からお気軽にどうぞ。</p>"
  ];
  const english = [
    "<p>Thank you for using Aipictors.</p>",
    `<p>We couldn't take the renewal payment (<b>${amount}</b>) for your Aipictors+ (${escapeHtml(planEn)}) plan. Your card was declined (for example: insufficient funds, an expired card, or a hold by the card issuer).</p>`,
    "<p>You can pay with another card using the button below. Once the payment goes through, your plan continues as it is.</p>",
    button(props.invoiceUrl, "Open the payment page"),
    retryTextEn
      ? `<p>If you do nothing, we will try the same card again around ${escapeHtml(retryTextEn)} (Japan time). If the payment still can't be taken, your plan will end.</p>`
      : "<p>If the payment still can't be taken, your plan will end.</p>",
    "<p>You don't need to subscribe again (please use the button above to avoid being charged twice). If you need help, <a href=\"https://www.aipictors.com/en/support/chat\">contact us</a> anytime.</p>"
  ];
  const divider = '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">';
  const body = props.locale === "en" ? english : props.locale === "ja" ? japanese : [...japanese, divider, ...english];
  const subjectJa = "【Aipictors】Aipictors+ の更新のお支払いが完了していません";
  const subjectEn = "[Aipictors] We couldn't take your Aipictors+ renewal payment";
  return {
    subject: props.locale === "en" ? subjectEn : props.locale === "ja" ? subjectJa : `${subjectJa} / Payment failed`,
    html: ['<div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;line-height:1.8;color:#111827">', ...body, "</div>"].join("")
  };
};

/**
 * 支払いに失敗したままの契約（Stripe 上で past_due）の人に、請求書ごとに一度だけ知らせる（毎日の定期処理から呼ぶ）
 */
export var sendPaymentFailedNotices = async (env, db) => {
  if (!env.RESEND_API_KEY || !env.STRIPE_SECRET_KEY) return { sent: 0, skipped: "not configured" };
  const list = await getStripe(env.STRIPE_SECRET_KEY, "/subscriptions?status=past_due&limit=50&expand[]=data.latest_invoice");
  const subscriptions = Array.isArray(list?.data) ? list.data : [];
  const from = `Aipictors <${env.RESEND_FROM_EMAIL ?? "noreply@info.aipictors.com"}>`;
  let sent = 0;
  for (const subscription of subscriptions) {
    const invoice = subscription?.latest_invoice;
    if (!invoice || typeof invoice !== "object" || invoice.status !== "open" || !invoice.hosted_invoice_url || !invoice.id) continue;
    // 休止中（請求を止めている）の契約には送らない
    if (subscription.pause_collection) continue;
    const row = await db.queryOne(
      `SELECT user_id, type FROM subscriptions
        WHERE stripe_subscription_id = $1 AND is_disabled = FALSE AND type IN ('LITE', 'STANDARD', 'PREMIUM') LIMIT 1`,
      [subscription.id]
    );
    if (!row) continue;
    const campaign = `payment-failed:${invoice.id}`;
    const already = await db.queryOne("SELECT 1 AS ok FROM email_campaign_sends WHERE campaign = $1 LIMIT 1", [campaign]);
    if (already) continue;
    const customerId = typeof subscription.customer === "string" ? subscription.customer : null;
    const email = await getStripeCustomerEmail(env.STRIPE_SECRET_KEY, customerId, subscription.id).catch(() => null);
    if (!email) continue;
    const message = buildPaymentFailedEmail({
      passType: row.type,
      amount: invoice.amount_due,
      invoiceUrl: invoice.hosted_invoice_url,
      nextAttempt: Number(invoice.next_payment_attempt) || null,
      locale: subscription.metadata?.locale ?? null
    });
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email], subject: message.subject, html: message.html })
    });
    const resJson = await response.json().catch(() => null);
    if (!response.ok) {
      console.error(JSON.stringify({ event: "payment_failed_notice.send_failed", message: resJson?.message ?? response.status }));
      break;
    }
    await db.execute(
      `INSERT INTO email_campaign_sends(campaign, user_id, email, sent_at, resend_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [campaign, String(row.user_id), email, getNow(), resJson?.id ?? null]
    );
    sent += 1;
  }
  return { sent, candidates: subscriptions.length };
};
