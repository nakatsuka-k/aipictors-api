// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { toHex } from "./auth"
import { getNow } from "./db"
import { escapeHtml, formatJstDate } from "./subscription-cancellation-email"
import { RENEWAL_BONUS_COINS } from "./loyalty"
import { getStripe } from "./subscription-stripe"

/**
 * 解約を減らすための仕組み
 * - 解約の理由を残す（何が足りなかったかを知るため。加入 1 か月以内の解約が半分近い）
 * - 解約予約中の人に、終わる 3 日前に「続けるなら取り消せます」と知らせる（加入直後に解約予約だけして、使い続けたかった人が戻れるように）
 */

export var CANCEL_REASONS = {
  not_using: "あまり使わなかった",
  coins: "コインが足りなかった",
  price: "料金が高い",
  quality: "生成の品質・不具合が気になった",
  slow: "生成が遅い・待ち時間が長い",
  one_month: "1か月だけ使うつもりだった",
  other_service: "ほかのサービスに移る",
  other: "その他"
};

export var ensureRetentionTables = async (db) => {
};

export var saveCancelReason = async (db, props) => {
  const reason = typeof props.reason === "string" && props.reason in CANCEL_REASONS ? props.reason : null;
  if (!reason) return;
  await ensureRetentionTables(db);
  const months = props.current?.created_at
    ? Math.round(((getNow() - Number(props.current.created_at)) / 86400 / 30) * 10) / 10
    : null;
  await db.execute(
    `INSERT INTO subscription_cancel_reasons(user_id, pass_type, reason, note, months, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      String(props.userId),
      props.current?.type ?? null,
      reason,
      typeof props.note === "string" ? props.note.trim().slice(0, 500) || null : null,
      months,
      getNow()
    ]
  );
};

export var unsubscribeUrl = async (secret, userId) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`unsubscribe:${userId}`));
  const s = toHex(new Uint8Array(signature)).slice(0, 32);
  return `https://backend.aipictors.com/email/unsubscribe?u=${encodeURIComponent(userId)}&s=${s}`;
};

var PLAN_NAME = { LITE: "ライト", STANDARD: "スタンダード", PREMIUM: "プレミアム" };
var DAILY_COINS = { LITE: 500, STANDARD: 1000, PREMIUM: 2000 };

var PLAN_NAME_EN = { LITE: "Lite", STANDARD: "Standard", PREMIUM: "Premium" };

/**
 * 解約のリマインドのメール。言語が分かっていれば（locale が "en" / "ja"）その言語だけ、分からなければ日本語と英語の両方
 */
export var buildCancelReminderEmail = (props) => {
  const plan = PLAN_NAME[props.passType] ?? props.passType;
  const planEn = PLAN_NAME_EN[props.passType] ?? props.passType;
  const endText = formatJstDate(props.periodEnd) ?? "";
  const endTextEn = props.periodEnd
    ? new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric", month: "short", day: "numeric" }).format(new Date(props.periodEnd * 1e3))
    : "";
  const bonus = RENEWAL_BONUS_COINS[props.passType] ?? 0;
  const daily = DAILY_COINS[props.passType] ?? 0;
  const button = (href, label) =>
    `<p><a href="${href}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${label}</a></p>`;
  const japanese = [
    "<p>Aipictors をご利用いただきありがとうございます。</p>",
    `<p>Aipictors+（${escapeHtml(plan)}）は <b>${escapeHtml(endText)}</b> で終了します。</p>`,
    `<p>終了後は、毎日もらえるフリーコインが ${daily} から 100 に減り、1回にまとめて生成できる枚数や広告なしなどの特典もなくなります。</p>`,
    `<p>続ける場合は、プランのページで「解約を取り消す」を押すだけで、今と同じ内容で続けられます。続けると、更新のたびに<b>継続ボーナス ${bonus} プレミアムコイン（期限なし）</b>もお届けします。</p>`,
    button("https://www.aipictors.com/plus", "プランのページを開く"),
    "<p>このまま終了する場合は、何もしなくて大丈夫です（料金はかかりません）。困っていることがあれば、<a href=\"https://www.aipictors.com/support/chat\">お問い合わせ</a>からお気軽にどうぞ。</p>",
    props.optout ? `<p style="color:#9ca3af;font-size:12px"><a href="${props.optout}" style="color:#9ca3af">このようなお知らせを受け取らない</a></p>` : ""
  ];
  const english = [
    "<p>Thank you for using Aipictors.</p>",
    `<p>Your Aipictors+ (${escapeHtml(planEn)}) plan ends on <b>${escapeHtml(endTextEn)}</b> (Japan time).</p>`,
    `<p>After it ends, your daily free coins go from ${daily} down to 100, and you lose plan benefits such as generating several images per click and no ads.</p>`,
    `<p>To keep your plan, just press "Undo cancellation" on the plan page. If you continue, you also get a <b>renewal bonus of ${bonus} premium coins (no expiry)</b> every time the plan renews.</p>`,
    button("https://www.aipictors.com/en/plus", "Open the plan page"),
    "<p>If you'd rather let it end, you don't need to do anything (you won't be charged). If you need help, <a href=\"https://www.aipictors.com/en/support/chat\">contact us</a> anytime.</p>",
    props.optout ? `<p style="color:#9ca3af;font-size:12px"><a href="${props.optout}" style="color:#9ca3af">Stop receiving emails like this</a></p>` : ""
  ];
  const divider = '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">';
  const body = props.locale === "en" ? english : props.locale === "ja" ? japanese : [...japanese, divider, ...english];
  const subjectJa = `【Aipictors】Aipictors+ は ${endText} で終了します`;
  const subjectEn = `[Aipictors] Your Aipictors+ plan ends on ${endTextEn}`;
  return {
    endText,
    subject: props.locale === "en" ? subjectEn : props.locale === "ja" ? subjectJa : `${subjectJa} / Your plan ends on ${endTextEn}`,
    html: ['<div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;line-height:1.8;color:#111827">', ...body, "</div>"].join("")
  };
};

/**
 * 解約予約中で、あと 2〜3 日で終わる人に一度だけ知らせる（毎日の定期処理から呼ぶ）
 */
export var sendCancelReminders = async (env, db, getStripeCustomerEmail) => {
  if (!env.RESEND_API_KEY || !env.STRIPE_SECRET_KEY) return { sent: 0, skipped: "not configured" };
  await ensureRetentionTables(db);
  const now = getNow();
  const rows = await db.query(
    `SELECT s.user_id, s.type, s.current_period_end, s.stripe_subscription_id
       FROM subscriptions s
      WHERE s.status = 'cancellation_requested' AND s.is_disabled = FALSE
        AND s.type IN ('LITE', 'STANDARD', 'PREMIUM')
        AND coalesce(s.stripe_subscription_id, '') <> ''
        AND s.current_period_end BETWEEN $1 AND $2
        AND NOT EXISTS (SELECT 1 FROM email_optouts o WHERE o.user_id = s.user_id)
        AND NOT EXISTS (SELECT 1 FROM email_campaign_sends e WHERE e.campaign = 'cancel-reminder:' || s.stripe_subscription_id)
      LIMIT 50`,
    [now + 36 * 3600, now + 72 * 3600]
  );
  const secret = env.INTERNAL_API_TOKEN ?? env.AIPICTORS_API_INTERNAL_TOKEN;
  const from = `Aipictors <${env.RESEND_FROM_EMAIL ?? "noreply@info.aipictors.com"}>`;
  let sent = 0;
  for (const row of rows) {
    // 契約を 1 回読んで、送り先（顧客）と、決済のときの表示言語（metadata.locale）を得る
    const stripeSubscription = await getStripe(env.STRIPE_SECRET_KEY, `/subscriptions/${row.stripe_subscription_id}`).catch(() => null);
    const customerId = typeof stripeSubscription?.customer === "string" ? stripeSubscription.customer : null;
    const email = await getStripeCustomerEmail(env.STRIPE_SECRET_KEY, customerId, row.stripe_subscription_id).catch(() => null);
    if (!email) continue;
    const optout = secret ? await unsubscribeUrl(secret, String(row.user_id)) : null;
    const message = buildCancelReminderEmail({
      passType: row.type,
      periodEnd: Number(row.current_period_end),
      locale: stripeSubscription?.metadata?.locale ?? null,
      optout
    });
    const endText = message.endText;
    const html = message.html;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [email],
        subject: message.subject,
        html,
        headers: optout ? { "List-Unsubscribe": `<${optout}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined
      })
    });
    const resJson = await response.json().catch(() => null);
    if (!response.ok) {
      console.error(JSON.stringify({ event: "retention.reminder_failed", message: resJson?.message ?? response.status }));
      break;
    }
    await db.execute(
      `INSERT INTO email_campaign_sends(campaign, user_id, email, sent_at, resend_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [`cancel-reminder:${row.stripe_subscription_id}`, String(row.user_id), email, getNow(), resJson?.id ?? null]
    );
    sent += 1;
  }
  return { sent, candidates: rows.length };
};
