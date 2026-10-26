// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
export var formatJstDate = (unixSeconds) => {
  if (!unixSeconds) {
    return null;
  }
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date(unixSeconds * 1e3));
};
export var escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
export var sendSubscriptionCancellationEmail = async (props) => {
  if (!props.apiKey || !props.toEmail) {
    return;
  }
  const endDateText = formatJstDate(props.currentPeriodEnd);
  const subject = props.status === "canceled" ? "Aipictors \u30B5\u30D6\u30B9\u30AF\u30EA\u30D7\u30B7\u30E7\u30F3\u89E3\u7D04\u5B8C\u4E86\u306E\u304A\u77E5\u3089\u305B" : "Aipictors \u30B5\u30D6\u30B9\u30AF\u30EA\u30D7\u30B7\u30E7\u30F3\u89E3\u7D04\u53D7\u4ED8\u5B8C\u4E86\u306E\u304A\u77E5\u3089\u305B";
  const headline = props.status === "canceled" ? "\u30B5\u30D6\u30B9\u30AF\u30EA\u30D7\u30B7\u30E7\u30F3\u306E\u89E3\u7D04\u306F\u5B8C\u4E86\u3057\u3066\u3044\u307E\u3059\u3002" : "\u30B5\u30D6\u30B9\u30AF\u30EA\u30D7\u30B7\u30E7\u30F3\u306E\u89E3\u7D04\u624B\u7D9A\u304D\u304C\u5B8C\u4E86\u3057\u307E\u3057\u305F\u3002";
  const scheduleText = endDateText ? `\u3054\u5229\u7528\u306F ${escapeHtml(endDateText)} \u307E\u3067\u7D99\u7D9A\u3055\u308C\u3001\u305D\u306E\u5F8C\u81EA\u52D5\u7684\u306B\u89E3\u7D04\u3055\u308C\u307E\u3059\u3002` : "\u73FE\u5728\u306E\u5951\u7D04\u72B6\u6CC1\u306F\u30DE\u30A4\u30DA\u30FC\u30B8\u306E Plus \u753B\u9762\u304B\u3089\u3054\u78BA\u8A8D\u3044\u305F\u3060\u3051\u307E\u3059\u3002";
  const html = [
    '<div style="font-family: -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif; line-height: 1.7; color: #111827;">',
    "<p>Aipictors \u3092\u3054\u5229\u7528\u3044\u305F\u3060\u304D\u3042\u308A\u304C\u3068\u3046\u3054\u3056\u3044\u307E\u3059\u3002</p>",
    `<p>${headline}</p>`,
    `<p>${scheduleText}</p>`,
    "<p>\u89E3\u7D04\u5B8C\u4E86\u30E1\u30FC\u30EB\u304C\u898B\u5F53\u305F\u3089\u306A\u3044\u5834\u5408\u3067\u3082\u3001Plus \u753B\u9762\u306B\u300C\u89E3\u7D04\u4E88\u5B9A\u65E5\u300D\u304C\u8868\u793A\u3055\u308C\u3066\u3044\u308C\u3070\u624B\u7D9A\u304D\u306F\u5B8C\u4E86\u3057\u3066\u3044\u307E\u3059\u3002</p>",
    '<p><a href="https://www.aipictors.com/plus">Plus \u753B\u9762\u3092\u958B\u304F</a></p>',
    "<p>\u4ECA\u5F8C\u3068\u3082 Aipictors \u3092\u3088\u308D\u3057\u304F\u304A\u9858\u3044\u3044\u305F\u3057\u307E\u3059\u3002</p>",
    "</div>"
  ].join("");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${props.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: `Aipictors <${props.fromEmail ?? "noreply@info.aipictors.com"}>`,
      to: [props.toEmail],
      subject,
      html
    })
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Failed to send cancellation email: ${response.status} ${bodyText}`);
  }
};
