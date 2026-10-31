// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { Hono as Hono2 } from "hono"
import { getInternalApiToken, requireInternalAuth, toHex } from "../lib/auth"
import { getDb, getNow } from "../lib/db"
import { json } from "../lib/json"
import { grantThanksCoins } from "../lib/loyalty"

/**
 * お知らせメール・感謝コインなどのキャンペーン（運営が内部トークンで呼ぶ）
 */
export var campaignRoutes = new Hono2();

/**
 * 配信停止を受け付ける（メールのリンクから開く。ログイン不要）
 */
export var emailPublicRoutes = new Hono2();

var ensureTables = async (db) => {
  await db.execute(`CREATE TABLE IF NOT EXISTS email_optouts (
    user_id TEXT PRIMARY KEY,
    created_at BIGINT NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS email_campaign_sends (
    campaign TEXT NOT NULL,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    sent_at BIGINT NOT NULL,
    resend_id TEXT,
    PRIMARY KEY (campaign, user_id)
  )`);
};

var sign = async (secret, userId) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`unsubscribe:${userId}`));
  return toHex(new Uint8Array(signature)).slice(0, 32);
};

var unsubscribeUrl = async (c, userId) => {
  const origin = new URL(c.req.url).origin;
  const s = await sign(getInternalApiToken(c), userId);
  return `${origin}/email/unsubscribe?u=${encodeURIComponent(userId)}&s=${s}`;
};

campaignRoutes.use("*", requireInternalAuth);

/**
 * 今の会員に感謝コインを付ける（同じキャンペーンで 2 回は付けない）
 */
campaignRoutes.post("/thanks-coins", async (c) => {
  const body = await c.req.json();
  const campaign = typeof body.campaign === "string" ? body.campaign : null;
  if (!campaign) return json({ error: "campaign is required" }, 400);
  // 付ける人を必ず指定する（最近使っていない会員には付けないため、全員には付けない）
  const onlyUserIds = Array.isArray(body.userIds) ? body.userIds.map(String) : null;
  if (!onlyUserIds || onlyUserIds.length === 0) return json({ error: "userIds is required" }, 400);
  const db = await getDb(c.env);
  const rows = await db.query(
    `SELECT DISTINCT ON (user_id) user_id, type
       FROM subscriptions
      WHERE is_disabled = FALSE
        AND type IN ('LITE', 'STANDARD', 'PREMIUM')
        AND current_period_end > EXTRACT(EPOCH FROM NOW())::bigint
        AND user_id = ANY($1::text[])
      ORDER BY user_id,
               CASE type WHEN 'PREMIUM' THEN 3 WHEN 'STANDARD' THEN 2 ELSE 1 END DESC`,
    [onlyUserIds]
  );
  const results = [];
  for (const row of rows) {
    if (body.dryRun) {
      results.push({ userId: row.user_id, passType: row.type, dryRun: true });
      continue;
    }
    const result = await grantThanksCoins({ db, userId: row.user_id, passType: row.type, campaign });
    results.push({ userId: row.user_id, passType: row.type, ...result });
  }
  return json({ error: null, data: { count: results.length, results } });
});

/**
 * メールを送る（配信停止した人・同じキャンペーンで送った人には送らない）
 * html・text の {{unsubscribe}} は配信停止 URL に置き換える
 */
campaignRoutes.post("/send-email", async (c) => {
  const body = await c.req.json();
  const { campaign, subject, html, text, recipients } = body;
  if (!campaign || !subject || !html || !Array.isArray(recipients)) {
    return json({ error: "campaign, subject, html, recipients are required" }, 400);
  }
  if (!c.env.RESEND_API_KEY) return json({ error: "RESEND_API_KEY is not configured" }, 500);
  const db = await getDb(c.env);
  await ensureTables(db);
  const userIds = recipients.map((r) => String(r.userId));
  const optouts = new Set(
    (await db.query("SELECT user_id FROM email_optouts WHERE user_id = ANY($1::text[])", [userIds])).map((r) => r.user_id)
  );
  const sent = new Set(
    (await db.query(
      "SELECT user_id FROM email_campaign_sends WHERE campaign = $1 AND user_id = ANY($2::text[])",
      [campaign, userIds]
    )).map((r) => r.user_id)
  );
  const targets = recipients.filter(
    (r) => r.email && r.userId && !optouts.has(String(r.userId)) && !sent.has(String(r.userId))
  );
  if (body.dryRun) {
    return json({ error: null, data: { targets: targets.length, optouts: optouts.size, alreadySent: sent.size } });
  }
  const from = `Aipictors <${c.env.RESEND_FROM_EMAIL ?? "noreply@info.aipictors.com"}>`;
  const results = [];
  // Resend のまとめて送る API は 1 回 100 件まで
  for (let i = 0; i < targets.length; i += 100) {
    const chunk = targets.slice(i, i + 100);
    const payload = [];
    for (const r of chunk) {
      const url = await unsubscribeUrl(c, String(r.userId));
      const fill = (value) => String(value ?? "").replaceAll("{{unsubscribe}}", url).replaceAll("{{name}}", r.name ?? "");
      payload.push({
        from,
        to: [r.email],
        subject,
        html: fill(html),
        text: text ? fill(text) : void 0,
        headers: {
          "List-Unsubscribe": `<${url}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
        }
      });
    }
    const response = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const resJson = await response.json().catch(() => null);
    if (!response.ok) {
      results.push({ from: i, error: resJson?.message ?? `HTTP ${response.status}` });
      break;
    }
    const ids = Array.isArray(resJson?.data) ? resJson.data : [];
    const now = getNow();
    for (let k = 0; k < chunk.length; k++) {
      await db.execute(
        `INSERT INTO email_campaign_sends(campaign, user_id, email, sent_at, resend_id)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (campaign, user_id) DO NOTHING`,
        [campaign, String(chunk[k].userId), chunk[k].email, now, ids[k]?.id ?? null]
      );
    }
    results.push({ from: i, sent: chunk.length });
  }
  return json({ error: null, data: { targets: targets.length, results } });
});

var unsubscribePage = (message) =>
  new Response(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>配信停止 - Aipictors</title></head><body style="font-family:sans-serif;max-width:480px;margin:48px auto;padding:0 16px;line-height:1.7"><h1 style="font-size:20px">Aipictors</h1><p>${message}</p><p><a href="https://www.aipictors.com/">Aipictors を開く</a></p></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );

var handleUnsubscribe = async (c) => {
  const userId = c.req.query("u") ?? "";
  const s = c.req.query("s") ?? "";
  if (!userId || s !== (await sign(getInternalApiToken(c), userId))) {
    return unsubscribePage("リンクが正しくありません。お手数ですが、お問い合わせからご連絡ください。");
  }
  const db = await getDb(c.env);
  await ensureTables(db);
  await db.execute(
    "INSERT INTO email_optouts(user_id, created_at) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
    [userId, getNow()]
  );
  return unsubscribePage("お知らせメールの配信を停止しました。今後はお知らせメールをお送りしません（お支払い・解約など、ご契約に関するメールは届きます）。");
};

emailPublicRoutes.get("/unsubscribe", handleUnsubscribe);
emailPublicRoutes.post("/unsubscribe", handleUnsubscribe);
