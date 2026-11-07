// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { getNow } from "./db"
import { oncePerDb } from "./once-per-db"
import { SUPPORT_KNOWLEDGE } from "./support-knowledge"

/**
 * お問い合わせ（サポートチャット）
 * AI がナレッジとその人のアカウントの状況（プラン・コイン・最近の生成）を見て答え、
 * 有人の窓口はないので、AI で答えられないもの（返金・コインの付与・アカウント削除・不具合の調査など）は
 * Discord サーバーでの相談を案内する
 */

/** 1 日に AI が答える回数（1 人あたり） */
export var SUPPORT_AI_DAILY_LIMIT = 40;

/** 1 通の長さ */
export var SUPPORT_MESSAGE_MAX_LENGTH = 4000;

// 安くて日本語が自然なもの。上がだめなら下を使う（1 回あたり 1 円未満）
var DEFAULT_MODELS = ["gemini-3.5-flash", "gemini-3.5-flash-lite"];

// 読むだけのリクエスト（未読の確認など）でも DDL 5 文を流さないよう、isolate ごとに 1 回だけ
export var ensureSupportTables = oncePerDb(async (db) => {
  await db.execute(`CREATE TABLE IF NOT EXISTS support_tickets (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ai',
    category TEXT,
    summary TEXT,
    contact_email TEXT,
    user_name TEXT,
    pass_type TEXT,
    staff_unread BOOLEAN NOT NULL DEFAULT FALSE,
    user_unread BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    escalated_at BIGINT,
    resolved_at BIGINT
  )`);
  await db.execute(
    "CREATE INDEX IF NOT EXISTS support_tickets_user_idx ON support_tickets(user_id, id DESC)"
  );
  await db.execute(
    "CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets(status, updated_at DESC)"
  );
  await db.execute(`CREATE TABLE IF NOT EXISTS support_messages (
    id BIGSERIAL PRIMARY KEY,
    ticket_id BIGINT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    body TEXT NOT NULL,
    staff_user_id TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    helpful SMALLINT,
    created_at BIGINT NOT NULL
  )`);
  await db.execute(
    "CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON support_messages(ticket_id, id)"
  );
});

var toTicket = (row) => {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: row.user_id,
    status: row.status,
    category: row.category,
    summary: row.summary,
    contactEmail: row.contact_email,
    userName: row.user_name,
    passType: row.pass_type,
    staffUnread: row.staff_unread,
    userUnread: row.user_unread,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    escalatedAt: row.escalated_at ? Number(row.escalated_at) : null,
    resolvedAt: row.resolved_at ? Number(row.resolved_at) : null
  };
};

var toMessage = (row) => ({
  id: String(row.id),
  ticketId: String(row.ticket_id),
  role: row.role,
  body: row.body,
  helpful: row.helpful === null || row.helpful === void 0 ? null : Number(row.helpful),
  createdAt: Number(row.created_at)
});

export var getLatestTicket = async (db, userId) => {
  const row = await db.queryOne(
    "SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
    [userId]
  );
  return toTicket(row);
};

export var getTicket = async (db, ticketId) => {
  const row = await db.queryOne("SELECT * FROM support_tickets WHERE id = $1", [ticketId]);
  return toTicket(row);
};

export var getTicketMessages = async (db, ticketId) => {
  const rows = await db.query(
    "SELECT * FROM support_messages WHERE ticket_id = $1 ORDER BY id ASC LIMIT 300",
    [ticketId]
  );
  return rows.map(toMessage);
};

export var createTicket = async (db, props) => {
  const now = getNow();
  const row = await db.queryOne(
    `INSERT INTO support_tickets(user_id, status, user_name, pass_type, contact_email, created_at, updated_at)
     VALUES ($1, 'ai', $2, $3, $4, $5, $5) RETURNING *`,
    [props.userId, props.userName ?? null, props.passType ?? null, props.contactEmail ?? null, now]
  );
  return toTicket(row);
};

export var addMessage = async (db, props) => {
  const row = await db.queryOne(
    `INSERT INTO support_messages(ticket_id, user_id, role, body, staff_user_id, model, input_tokens, output_tokens, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      props.ticketId,
      props.userId,
      props.role,
      props.body,
      props.staffUserId ?? null,
      props.model ?? null,
      props.inputTokens ?? null,
      props.outputTokens ?? null,
      getNow()
    ]
  );
  return toMessage(row);
};

export var countAiRepliesToday = async (db, userId) => {
  const row = await db.queryOne(
    `SELECT count(*) AS n FROM support_messages
      WHERE user_id = $1 AND role = 'ai' AND created_at > $2`,
    [userId, getNow() - 86400]
  );
  return row?.n ?? 0;
};

/**
 * AI に渡すその人のアカウントの状況（本人の情報だけ）
 */
export var getAccountContext = async (db, userId, genlogDb = db) => {
  const now = getNow();
  const subscriptions = await db.query(
    `SELECT type, status, is_disabled, created_at, current_period_end, stripe_subscription_id IS NOT NULL AND stripe_subscription_id <> '' AS is_stripe
       FROM subscriptions WHERE user_id = $1 ORDER BY id DESC LIMIT 4`,
    [userId]
  );
  const balance = await db.queryOne(
    "SELECT free_balance, premium_balance FROM coin_balances WHERE user_id = $1",
    [userId]
  );
  const ledger = await db.query(
    `SELECT coin_type, delta, kind, reason, source, created_at FROM coin_ledger
      WHERE user_id = $1 ORDER BY id DESC LIMIT 20`,
    [userId]
  );
  let tasks = [];
  try {
    tasks = await genlogDb.query(
      `SELECT status, substr(coalesce(error, ''), 1, 160) AS error, request_time, count, cost, is_canceled
         FROM generated_queues WHERE user_id = $1 ORDER BY id DESC LIMIT 10`,
      [userId]
    );
  } catch {
    tasks = [];
  }
  const fmt = (epoch) =>
    new Date(Number(epoch) * 1e3).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const lines = [];
  lines.push(`現在時刻: ${fmt(now)}（日本時間）`);
  if (subscriptions.length === 0) {
    lines.push("プラン: 加入記録なし（無料）");
  } else {
    lines.push("プランの記録（新しい順）:");
    for (const s of subscriptions) {
      const active = Number(s.current_period_end) > now && !s.is_disabled;
      lines.push(
        `- ${s.type} / 状態 ${s.status}${s.is_disabled ? "（解約済み）" : ""} / 開始 ${fmt(s.created_at)} / 期間の終わり ${fmt(s.current_period_end)} / ${active ? "利用中" : "期間外"} / ${s.is_stripe ? "ウェブ（カード）" : "アプリまたはその他"}`
      );
    }
  }
  lines.push(
    `コイン残高: フリーコイン ${balance?.free_balance ?? 0} / プレミアムコイン ${balance?.premium_balance ?? 0}`
  );
  if (ledger.length > 0) {
    lines.push("コインの最近の増減（新しい順・最大20件）:");
    for (const l of ledger) {
      lines.push(
        `- ${fmt(l.created_at)} ${l.coin_type === "PREMIUM" ? "プレミアム" : "フリー"} ${l.delta > 0 ? "+" : ""}${l.delta}（${l.reason ?? l.kind}${l.source?.startsWith("thanks:") ? "・感謝コイン" : ""}${l.source?.startsWith("renewal_bonus:") ? "・継続ボーナス" : ""}）`
      );
    }
  }
  if (tasks.length > 0) {
    lines.push("最近の画像生成（新しい順・最大10件）:");
    for (const t of tasks) {
      const time = t.request_time instanceof Date ? t.request_time.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : String(t.request_time);
      lines.push(
        `- ${time} 状態 ${t.status}${t.is_canceled ? "（キャンセル）" : ""} 枚数 ${t.count ?? 1} コイン ${t.cost ?? "-"}${t.error ? ` エラー: ${t.error}` : ""}`
      );
    }
  }
  return lines.join("\n");
};

var SYSTEM_RULES = `あなたは AI イラスト投稿・生成サイト「Aipictors」（https://www.aipictors.com）のサポート担当 AI です。
サイトの中のお問い合わせチャットで、ログイン中のユーザー本人に答えます。Aipictors には有人のサポート窓口はありません。あなたが最後まで対応します。

# 答え方
- ユーザーが書いた言語で答える（日本語なら自然な日本語。英語で書き始めない）
- まず結論、次に手順。手順は番号付きで短く。全体で 6〜10 行程度まで。挨拶やお詫びの定型文を長々と書かない
- ページを案内するときは、ナレッジにあるフル URL を書く
- 「アカウントの状況」はこのユーザー本人の記録。コイン・プラン・生成・運営からのメッセージ・作品への運営の対応について聞かれたら必ず確認し、記録からわかることを具体的に伝える（例:「11/1 15:54 に作品『○○』の年齢区分が 全年齢 → R-18G に変更されています」）。ほかの人の情報は持っていない
- 運営からのメッセージ（定型文で「詳細:」が空のものが多い）について聞かれたら、「運営の対応」の記録と照らし合わせて、どの作品に何がされたか・ユーザーが何かする必要があるかを説明する
- ナレッジとアカウントの状況に無いことは推測で答えない
- 「キャッシュを消してください」「時間をおいてください」だけで終わらせない
- 個人情報（パスワード・カード番号など）を聞かない。送られてきても繰り返さない
- 「スタッフに引き継ぎます」「担当者からお返事します」とは書かない（有人の対応はない）

# AI で解決できないとき（handoff を true にする）
- ナレッジの「AI で対応できないケース」に当たるもの（返金・二重請求・コインの付与や返却・アカウントの復旧や統合・運営の判断への異議・法的な依頼・調査が必要な不具合など）
- ユーザーがはっきり「人に対応してほしい」と言ったとき、同じことを何度も聞いている・怒っているとき
- このときの answer: わかったことを先に短く伝え、そのうえで「AI では対応できないため、Aipictors の Discord サーバー（https://discord.gg/hcQggQEYfn ）でご相談ください」と案内する。不具合・要望は「🔧欲しい機能・不具合・意見」、使い方の質問は「📋なんでも質問してね」チャンネル。書くとよいこと（ユーザーID・作品の URL・日時・画面のメッセージ）を添え、カード番号・パスワード・メールアドレスは公開のチャンネルに書かないよう伝える。いつ解決するかは約束しない

# 出力
必ず JSON だけを返す: {"answer": "ユーザーへの返事（Markdown 可）", "handoff": true/false, "category": "account|plan|payment|coins|generation|posting|moderation|report|bug|other", "summary": "運営向けの一行要約（日本語、60字以内）"}`;

/**
 * AI に答えてもらう
 */
export var generateSupportAnswer = async (env, props) => {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const models = env.SUPPORT_AI_MODEL ? [env.SUPPORT_AI_MODEL, ...DEFAULT_MODELS] : DEFAULT_MODELS;
  const systemText = `${SYSTEM_RULES}

# ナレッジ（Aipictors の仕様・手順。これに書いてあることだけを事実として扱う）
${SUPPORT_KNOWLEDGE}

# アカウントの状況（このユーザー本人）
ユーザー名: ${props.userName ?? "不明"} / ユーザー ID: ${props.userId}
${props.accountContext}${props.extraContext ? `

# 運営からのメッセージ・作品への運営の対応（このユーザー本人。サイトの記録から）
${props.extraContext}` : ""}`;
  const contents = props.history.slice(-16).map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.role === "staff" ? `（スタッフの返事）${m.body}` : m.role === "system" ? `（お知らせ）${m.body}` : m.body }]
  }));
  let lastError = null;
  for (const model of [...new Set(models)]) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemText }] },
            contents,
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 4096,
              ...(model.includes("lite") ? {} : { thinkingConfig: { thinkingBudget: 1024 } }),
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  answer: { type: "STRING" },
                  handoff: { type: "BOOLEAN" },
                  category: { type: "STRING" },
                  summary: { type: "STRING" }
                },
                required: ["answer", "handoff", "category", "summary"]
              }
            }
          })
        }
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        lastError = new Error(`${model}: ${data?.error?.message ?? response.status}`);
        continue;
      }
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const parsed = JSON.parse(text);
      if (typeof parsed.answer !== "string" || parsed.answer.trim() === "") {
        lastError = new Error(`${model}: empty answer`);
        continue;
      }
      return {
        answer: parsed.answer.trim(),
        escalate: parsed.handoff === true || parsed.escalate === true,
        category: typeof parsed.category === "string" ? parsed.category.slice(0, 32) : "other",
        summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 200) : null,
        model,
        inputTokens: data?.usageMetadata?.promptTokenCount ?? null,
        outputTokens: data?.usageMetadata?.candidatesTokenCount ?? null
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("AI failed");
};

/**
 * スタッフが返事したことをメールで知らせる（メールアドレスがわかる人だけ）
 */
export var sendStaffReplyEmail = async (env, props) => {
  if (!env.RESEND_API_KEY || !props.email) return false;
  const from = env.RESEND_FROM_EMAIL ?? "Aipictors <noreply@aipictors.com>";
  const escape = (s) =>
    String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [props.email],
      subject: "【Aipictors】お問い合わせにお返事しました",
      html: `<p>Aipictors のお問い合わせにスタッフがお返事しました。</p><blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#333;white-space:pre-wrap">${escape(props.body).slice(0, 1500)}</blockquote><p><a href="https://www.aipictors.com/support/chat">お問い合わせのページで見る・返信する</a></p><p style="color:#888;font-size:12px">このメールは送信専用です。返信はお問い合わせのページからお願いします。</p>`
    })
  });
  return response.ok;
};
