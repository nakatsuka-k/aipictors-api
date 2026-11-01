// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
import { Hono as Hono2 } from "hono"
import { requireInternalAuth } from "../lib/auth"
import { getDb, getNow } from "../lib/db"
import { json } from "../lib/json"
import {
  SUPPORT_AI_DAILY_LIMIT,
  SUPPORT_MESSAGE_MAX_LENGTH,
  addMessage,
  countAiRepliesToday,
  createTicket,
  ensureSupportTables,
  generateSupportAnswer,
  getAccountContext,
  getLatestTicket,
  getTicket,
  getTicketMessages,
  sendStaffReplyEmail
} from "../lib/support"

/**
 * お問い合わせ（サイトの API がログイン中の本人を確かめてから内部トークンで呼ぶ）
 */
export var supportRoutes = new Hono2();
supportRoutes.use("*", requireInternalAuth);

// 有人のサポートはないので、AI で解決できないときは Discord を案内する
var DISCORD_NOTICE =
  "AI で解決できないご相談は、Aipictors の Discord サーバー（https://discord.gg/hcQggQEYfn ）でご相談ください。不具合・要望は「🔧欲しい機能・不具合・意見」、使い方の質問は「📋なんでも質問してね」チャンネルへ。ユーザーID・作品の URL・日時・画面のメッセージを書くと早く解決します（カード番号・パスワード・メールアドレスは書かないでください）。";

var loadDb = async (c) => {
  const db = await getDb(c.env);
  await ensureSupportTables(db);
  return db;
};

var markEscalated = async (db, ticketId, props) => {
  await db.execute(
    `UPDATE support_tickets
        SET status = 'waiting_staff', staff_unread = TRUE,
            escalated_at = COALESCE(escalated_at, $2), updated_at = $2,
            category = COALESCE($3, category), summary = COALESCE($4, summary)
      WHERE id = $1::bigint`,
    [ticketId, getNow(), props.category ?? null, props.summary ?? null]
  );
};

/**
 * 本人の今のお問い合わせ（なければ null）
 */
supportRoutes.post("/thread", async (c) => {
  const body = await c.req.json();
  const userId = body.userId ? String(body.userId) : null;
  if (!userId) return json({ error: "userId is required" }, 400);
  const db = await loadDb(c);
  const ticket = body.ticketId ? await getTicket(db, String(body.ticketId)) : await getLatestTicket(db, userId);
  if (!ticket || ticket.userId !== userId) {
    return json({ error: null, data: { ticket: null, messages: [] } });
  }
  if (ticket.userUnread) {
    await db.execute("UPDATE support_tickets SET user_unread = FALSE WHERE id = $1::bigint", [ticket.id]);
  }
  const messages = await getTicketMessages(db, ticket.id);
  const history = await db.query(
    `SELECT id, status, summary, created_at, updated_at FROM support_tickets
      WHERE user_id = $1 ORDER BY id DESC LIMIT 10`,
    [userId]
  );
  return json({
    error: null,
    data: {
      ticket: { ...ticket, userUnread: false },
      messages,
      tickets: history.map((t) => ({ id: String(t.id), status: t.status, summary: t.summary, createdAt: Number(t.created_at), updatedAt: Number(t.updated_at) }))
    }
  });
});

/**
 * 本人に未読のスタッフの返事があるか（ヘッダーの印などに使う）
 */
supportRoutes.post("/unread", async (c) => {
  const body = await c.req.json();
  const userId = body.userId ? String(body.userId) : null;
  if (!userId) return json({ error: "userId is required" }, 400);
  const db = await loadDb(c);
  const row = await db.queryOne(
    "SELECT count(*)::INTEGER AS n FROM support_tickets WHERE user_id = $1 AND user_unread = TRUE",
    [userId]
  );
  return json({ error: null, data: { unread: row?.n ?? 0 } });
});

/**
 * 本人のメッセージを受け付けて、AI が答える（スタッフ対応中は AI は答えずスタッフに知らせる）
 */
supportRoutes.post("/messages", async (c) => {
  const body = await c.req.json();
  const userId = body.userId ? String(body.userId) : null;
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!userId) return json({ error: "userId is required" }, 400);
  if (text.length === 0) return json({ error: "メッセージを入力してください" }, 400);
  if (text.length > SUPPORT_MESSAGE_MAX_LENGTH) {
    return json({ error: `メッセージは${SUPPORT_MESSAGE_MAX_LENGTH}文字以内にしてください` }, 400);
  }
  const db = await loadDb(c);
  let ticket = body.ticketId ? await getTicket(db, String(body.ticketId)) : null;
  if (ticket && ticket.userId !== userId) return json({ error: "Not found" }, 404);
  if (!ticket || ticket.status === "resolved" || body.newTicket === true) {
    ticket = await createTicket(db, {
      userId,
      userName: body.userName ?? null,
      passType: body.passType ?? null,
      contactEmail: body.contactEmail ?? null
    });
  } else if (body.contactEmail && !ticket.contactEmail) {
    await db.execute("UPDATE support_tickets SET contact_email = $2 WHERE id = $1::bigint", [ticket.id, body.contactEmail]);
  }
  const userMessage = await addMessage(db, { ticketId: ticket.id, userId, role: "user", body: text });
  await db.execute("UPDATE support_tickets SET updated_at = $2 WHERE id = $1::bigint", [ticket.id, getNow()]);
  const created = [userMessage];

  // 以前「スタッフ対応中」になったお問い合わせも、AI が答える（有人の対応はない）
  if (ticket.status === "waiting_staff" || ticket.status === "staff_replied") {
    await db.execute("UPDATE support_tickets SET status = 'ai', staff_unread = FALSE WHERE id = $1::bigint", [ticket.id]);
  }

  const used = await countAiRepliesToday(db, userId);
  if (used >= SUPPORT_AI_DAILY_LIMIT) {
    const notice = await addMessage(db, {
      ticketId: ticket.id,
      userId,
      role: "system",
      body: `今日の自動回答の上限に達しました。明日またお試しいただくか、${DISCORD_NOTICE}`
    });
    created.push(notice);
    return json({ error: null, data: { ticket: await getTicket(db, ticket.id), messages: created } });
  }

  try {
    const history = await getTicketMessages(db, ticket.id);
    const accountContext = await getAccountContext(db, userId);
    const result = await generateSupportAnswer(c.env, {
      userId,
      userName: body.userName ?? ticket.userName,
      accountContext,
      extraContext: typeof body.extraContext === "string" ? body.extraContext.slice(0, 6000) : null,
      history
    });
    const aiMessage = await addMessage(db, {
      ticketId: ticket.id,
      userId,
      role: "ai",
      body: result.answer,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens
    });
    created.push(aiMessage);
    await db.execute(
      `UPDATE support_tickets SET category = COALESCE($2, category), summary = COALESCE(summary, $3), updated_at = $4 WHERE id = $1::bigint`,
      [ticket.id, result.category, result.summary, getNow()]
    );
    // Discord を案内したお問い合わせは、管理画面で見られるように印だけ付ける（状態は変えない）
    if (result.escalate) {
      await db.execute(
        "UPDATE support_tickets SET escalated_at = COALESCE(escalated_at, $2) WHERE id = $1::bigint",
        [ticket.id, getNow()]
      );
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "support.ai_failed", message: error instanceof Error ? error.message : String(error) }));
    const notice = await addMessage(db, {
      ticketId: ticket.id,
      userId,
      role: "system",
      body: `自動回答がうまく動きませんでした。少し時間をおいてもう一度送ってください。解決しないときは、${DISCORD_NOTICE}`
    });
    created.push(notice);
  }
  return json({ error: null, data: { ticket: await getTicket(db, ticket.id), messages: created } });
});

/**
 * 「人に相談したい」（以前の画面のボタン）: 有人の窓口はないので Discord を案内する
 */
supportRoutes.post("/escalate", async (c) => {
  const body = await c.req.json();
  const userId = body.userId ? String(body.userId) : null;
  const ticketId = body.ticketId ? String(body.ticketId) : null;
  if (!userId || !ticketId) return json({ error: "userId and ticketId are required" }, 400);
  const db = await loadDb(c);
  const ticket = await getTicket(db, ticketId);
  if (!ticket || ticket.userId !== userId) return json({ error: "Not found" }, 404);
  const created = [await addMessage(db, { ticketId, userId, role: "system", body: DISCORD_NOTICE })];
  await db.execute(
    "UPDATE support_tickets SET escalated_at = COALESCE(escalated_at, $2) WHERE id = $1::bigint",
    [ticketId, getNow()]
  );
  return json({ error: null, data: { ticket: await getTicket(db, ticketId), messages: created } });
});

/**
 * AI の答えが役に立ったか
 */
supportRoutes.post("/feedback", async (c) => {
  const body = await c.req.json();
  const userId = body.userId ? String(body.userId) : null;
  const messageId = body.messageId ? String(body.messageId) : null;
  if (!userId || !messageId) return json({ error: "userId and messageId are required" }, 400);
  const db = await loadDb(c);
  await db.execute(
    "UPDATE support_messages SET helpful = $3 WHERE id = $1::bigint AND user_id = $2 AND role = 'ai'",
    [messageId, userId, body.helpful === true ? 1 : -1]
  );
  return json({ error: null, data: { ok: true } });
});

/**
 * 本人が「解決した」
 */
supportRoutes.post("/resolve", async (c) => {
  const body = await c.req.json();
  const userId = body.userId ? String(body.userId) : null;
  const ticketId = body.ticketId ? String(body.ticketId) : null;
  if (!userId || !ticketId) return json({ error: "userId and ticketId are required" }, 400);
  const db = await loadDb(c);
  await db.execute(
    "UPDATE support_tickets SET status = 'resolved', resolved_at = $3, updated_at = $3, staff_unread = FALSE WHERE id = $1::bigint AND user_id = $2",
    [ticketId, userId, getNow()]
  );
  return json({ error: null, data: { ticket: await getTicket(db, ticketId) } });
});

/**
 * スタッフ用: 一覧
 */
supportRoutes.post("/admin/tickets", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const status = typeof body.status === "string" ? body.status : "waiting_staff";
  const db = await loadDb(c);
  const rows = await db.query(
    `SELECT t.*, (SELECT body FROM support_messages m WHERE m.ticket_id = t.id AND m.role = 'user' ORDER BY m.id DESC LIMIT 1) AS last_user_message,
            (SELECT count(*)::INTEGER FROM support_messages m WHERE m.ticket_id = t.id) AS message_count
       FROM support_tickets t
      WHERE ($1 = 'all' OR t.status = $1)
      ORDER BY t.updated_at DESC LIMIT 100`,
    [status]
  );
  const counts = await db.query("SELECT status, count(*)::INTEGER AS n FROM support_tickets GROUP BY status");
  const stats = await db.queryOne(
    `SELECT count(*) FILTER (WHERE role = 'ai')::INTEGER AS ai_replies,
            count(*) FILTER (WHERE role = 'ai' AND helpful = 1)::INTEGER AS helpful,
            count(*) FILTER (WHERE role = 'ai' AND helpful = -1)::INTEGER AS not_helpful,
            COALESCE(sum(input_tokens), 0)::BIGINT AS input_tokens,
            COALESCE(sum(output_tokens), 0)::BIGINT AS output_tokens
       FROM support_messages WHERE created_at > $1`,
    [getNow() - 30 * 86400]
  );
  return json({
    error: null,
    data: {
      tickets: rows.map((r) => ({
        id: String(r.id),
        userId: r.user_id,
        userName: r.user_name,
        passType: r.pass_type,
        status: r.status,
        category: r.category,
        summary: r.summary,
        staffUnread: r.staff_unread,
        lastUserMessage: r.last_user_message,
        messageCount: r.message_count,
        updatedAt: Number(r.updated_at),
        createdAt: Number(r.created_at)
      })),
      counts: Object.fromEntries(counts.map((r) => [r.status, r.n])),
      stats: {
        aiReplies: stats?.ai_replies ?? 0,
        helpful: stats?.helpful ?? 0,
        notHelpful: stats?.not_helpful ?? 0,
        inputTokens: Number(stats?.input_tokens ?? 0),
        outputTokens: Number(stats?.output_tokens ?? 0)
      }
    }
  });
});

/**
 * スタッフ用: 1 件（アカウントの状況つき）
 */
supportRoutes.post("/admin/ticket", async (c) => {
  const body = await c.req.json();
  const ticketId = body.ticketId ? String(body.ticketId) : null;
  if (!ticketId) return json({ error: "ticketId is required" }, 400);
  const db = await loadDb(c);
  const ticket = await getTicket(db, ticketId);
  if (!ticket) return json({ error: "Not found" }, 404);
  if (ticket.staffUnread) {
    await db.execute("UPDATE support_tickets SET staff_unread = FALSE WHERE id = $1::bigint", [ticketId]);
  }
  const messages = await getTicketMessages(db, ticketId);
  const accountContext = await getAccountContext(db, ticket.userId);
  return json({ error: null, data: { ticket, messages, accountContext } });
});

/**
 * スタッフ用: 返事・状態の変更
 */
supportRoutes.post("/admin/reply", async (c) => {
  const body = await c.req.json();
  const ticketId = body.ticketId ? String(body.ticketId) : null;
  const text = typeof body.body === "string" ? body.body.trim() : "";
  const nextStatus = typeof body.status === "string" ? body.status : null;
  if (!ticketId) return json({ error: "ticketId is required" }, 400);
  const db = await loadDb(c);
  const ticket = await getTicket(db, ticketId);
  if (!ticket) return json({ error: "Not found" }, 404);
  let message = null;
  let emailed = false;
  if (text.length > 0) {
    message = await addMessage(db, {
      ticketId,
      userId: ticket.userId,
      role: "staff",
      body: text,
      staffUserId: body.staffUserId ? String(body.staffUserId) : null
    });
    await db.execute(
      "UPDATE support_tickets SET status = $2, user_unread = TRUE, staff_unread = FALSE, updated_at = $3 WHERE id = $1::bigint",
      [ticketId, nextStatus ?? "staff_replied", getNow()]
    );
    emailed = await sendStaffReplyEmail(c.env, { email: ticket.contactEmail, body: text }).catch(() => false);
  } else if (nextStatus) {
    await db.execute(
      `UPDATE support_tickets SET status = $2, staff_unread = FALSE, updated_at = $3,
              resolved_at = CASE WHEN $2 = 'resolved' THEN $3 ELSE resolved_at END
        WHERE id = $1::bigint`,
      [ticketId, nextStatus, getNow()]
    );
  }
  return json({ error: null, data: { ticket: await getTicket(db, ticketId), message, emailed } });
});
