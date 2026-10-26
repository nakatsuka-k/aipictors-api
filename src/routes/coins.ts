// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { Hono as Hono2 } from "hono"
import { array, boolean, literal, nullable, number, object, optional, safeParse, string, union } from "valibot"
import { approveAmazonExchangeRequest, createAmazonExchangeRequest, listAmazonExchangeRequestsByUser, listAmazonExchangeRequestsForAdmin } from "../lib/amazon-exchange"
import { requireInternalAuth } from "../lib/auth"
import { getSupportAvailableWeekStartDates, getSupportPeriodRanking, getSupportSummary, getSupportWeeklyRanking, grantSupportCoinsAdmin, revertSupportTransferBySource, transferSupportCoins } from "../lib/coin-support"
import { adminAdjustCoins, applyCoinDelta, consumeCoins, ensureInitialCoinGrant, getAdminCoinHistory, getCoinSummary, getConsumedCoinBreakdownBySource } from "../lib/coins"
import { getDb } from "../lib/db"
import { json } from "../lib/json"
export var planTypeSchema = union([
  literal("FREE"),
  literal("LITE"),
  literal("STANDARD"),
  literal("PREMIUM")
]);
export var ensureGrantSchema = object({
  userId: string(),
  planType: optional(planTypeSchema),
  includeLedger: optional(boolean()),
  includeExpiringLots: optional(boolean()),
  includeLedgerLimit: optional(number()),
  includeLedgerOffset: optional(number())
});
export var consumeSchema = object({
  userId: string(),
  amount: number(),
  reason: optional(nullable(string())),
  source: optional(nullable(string()))
});
export var consumeBreakdownSchema = object({
  userId: string(),
  source: string()
});
export var grantSchema = object({
  userId: string(),
  freeCoins: optional(number()),
  premiumCoins: optional(number()),
  reason: optional(nullable(string())),
  source: optional(nullable(string()))
});
export var bulkAdjustSchema = object({
  userIds: array(string()),
  freeDelta: optional(number()),
  premiumDelta: optional(number()),
  expiresAt: optional(nullable(number())),
  reason: optional(nullable(string())),
  source: optional(nullable(string()))
});
export var supportSchema = object({
  senderUserId: string(),
  recipientUserId: string(),
  coinType: union([literal("FREE"), literal("PREMIUM")]),
  amount: number(),
  isAnonymous: optional(boolean()),
  planType: optional(nullable(planTypeSchema)),
  reason: optional(nullable(string())),
  source: optional(nullable(string()))
});
export var revertSupportSchema = object({
  senderUserId: string(),
  recipientUserId: string(),
  source: string()
});
export var amazonExchangeCreateSchema = object({
  userId: string(),
  packageId: string(),
  coinAmount: number(),
  amazonPointYen: number()
});
export var amazonExchangeApproveSchema = object({
  amazonGiftCode: string(),
  moderatorUserId: string()
});
export var coinsRoutes = new Hono2();
coinsRoutes.use("*", requireInternalAuth);
coinsRoutes.get("/admin-history", async (c) => {
  const db = await getDb(c.env);
  const userId = c.req.query("userId")?.trim() || null;
  const fromRaw = c.req.query("from");
  const toRaw = c.req.query("to");
  const offsetRaw = c.req.query("offset");
  const limitRaw = c.req.query("limit");
  const from = fromRaw ? Number.parseInt(fromRaw, 10) : null;
  const to = toRaw ? Number.parseInt(toRaw, 10) : null;
  const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : 0;
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 100;
  if (fromRaw && !Number.isFinite(from) || toRaw && !Number.isFinite(to)) {
    return json({ error: "Invalid range" }, 400);
  }
  if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(limit) || limit <= 0) {
    return json({ error: "Invalid paging" }, 400);
  }
  const result = await getAdminCoinHistory({
    db,
    userId,
    from,
    to,
    offset,
    limit
  });
  return json({ error: null, data: result });
});
coinsRoutes.get("/:userId", async (c) => {
  const db = await getDb(c.env);
  const includeLedger = c.req.query("includeLedger") === "1";
  const includeExpiringLots = c.req.query("includeExpiringLots") === "1";
  const includeLedgerLimitRaw = c.req.query("includeLedgerLimit");
  const includeLedgerOffsetRaw = c.req.query("includeLedgerOffset");
  const includeLedgerLimit = includeLedgerLimitRaw ? Number.parseInt(includeLedgerLimitRaw, 10) : void 0;
  const includeLedgerOffset = includeLedgerOffsetRaw ? Number.parseInt(includeLedgerOffsetRaw, 10) : void 0;
  if (includeLedgerLimitRaw && !Number.isFinite(includeLedgerLimit) || includeLedgerOffsetRaw && !Number.isFinite(includeLedgerOffset)) {
    return json({ error: "Invalid ledger paging" }, 400);
  }
  const summary = await getCoinSummary(db, c.req.param("userId"), {
    includeLedger,
    includeExpiringLots,
    includeLedgerLimit,
    includeLedgerOffset
  });
  return json({ error: null, data: summary });
});
coinsRoutes.post("/ensure-initial-grant", async (c) => {
  const parsed = safeParse(ensureGrantSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  const summary = await ensureInitialCoinGrant({
    db,
    userId: parsed.output.userId,
    planType: parsed.output.planType,
    includeLedger: parsed.output.includeLedger,
    includeExpiringLots: parsed.output.includeExpiringLots,
    includeLedgerLimit: parsed.output.includeLedgerLimit,
    includeLedgerOffset: parsed.output.includeLedgerOffset
  });
  return json({ error: null, data: summary });
});
coinsRoutes.post("/consume", async (c) => {
  const parsed = safeParse(consumeSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  const result = await consumeCoins({
    db,
    userId: parsed.output.userId,
    amount: parsed.output.amount,
    reason: parsed.output.reason ?? null,
    source: parsed.output.source ?? null
  });
  if (!result.ok) {
    const error = result.code === "INSUFFICIENT_COINS" ? "Insufficient coins" : "Invalid amount";
    const status = result.code === "INSUFFICIENT_COINS" ? 409 : 400;
    return json({ error }, status);
  }
  return json({
    error: null,
    data: {
      freeSpent: result.freeSpent,
      premiumSpent: result.premiumSpent,
      ...result.summary
    }
  });
});
coinsRoutes.post("/consume-breakdown", async (c) => {
  const parsed = safeParse(consumeBreakdownSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  const result = await getConsumedCoinBreakdownBySource({
    db,
    userId: parsed.output.userId,
    source: parsed.output.source
  });
  return json({ error: null, data: result });
});
coinsRoutes.post("/grant", async (c) => {
  const parsed = safeParse(grantSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const freeCoins = Math.floor(parsed.output.freeCoins ?? 0);
  const premiumCoins = Math.floor(parsed.output.premiumCoins ?? 0);
  if (freeCoins === 0 && premiumCoins === 0) {
    return json({ error: "No coins to grant" }, 400);
  }
  const db = await getDb(c.env);
  const summary = await applyCoinDelta({
    db,
    userId: parsed.output.userId,
    freeDelta: freeCoins,
    premiumDelta: premiumCoins,
    kind: "GRANT",
    reason: parsed.output.reason ?? null,
    source: parsed.output.source ?? null
  });
  return json({ error: null, data: summary });
});
coinsRoutes.post("/bulk-adjust", async (c) => {
  const parsed = safeParse(bulkAdjustSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const freeDelta = Math.floor(parsed.output.freeDelta ?? 0);
  const premiumDelta = Math.floor(parsed.output.premiumDelta ?? 0);
  if (freeDelta === 0 && premiumDelta === 0) {
    return json({ error: "No coins to adjust" }, 400);
  }
  const userIds = Array.from(new Set(parsed.output.userIds.map((userId) => userId.trim()).filter(Boolean)));
  if (userIds.length === 0) {
    return json({ error: "No target users" }, 400);
  }
  const db = await getDb(c.env);
  const results = [];
  for (const userId of userIds) {
    const result = await adminAdjustCoins({
      db,
      userId,
      freeDelta,
      premiumDelta,
      expiresAt: parsed.output.expiresAt ?? void 0,
      reason: parsed.output.reason ?? null,
      source: parsed.output.source ?? null
    });
    results.push({
      userId,
      freeGranted: result.freeGranted,
      premiumGranted: result.premiumGranted,
      freeReduced: result.freeReduced,
      premiumReduced: result.premiumReduced
    });
  }
  return json({
    error: null,
    data: {
      results,
      targetCount: userIds.length
    }
  });
});
coinsRoutes.post("/support", async (c) => {
  const parsed = safeParse(supportSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  await ensureInitialCoinGrant({
    db,
    userId: parsed.output.senderUserId,
    planType: parsed.output.planType ?? "FREE"
  });
  const result = await transferSupportCoins({
    db,
    senderUserId: parsed.output.senderUserId,
    recipientUserId: parsed.output.recipientUserId,
    coinType: parsed.output.coinType,
    amount: parsed.output.amount,
    isAnonymous: parsed.output.isAnonymous ?? false,
    reason: parsed.output.reason ?? null,
    source: parsed.output.source ?? null
  });
  if (!result.ok) {
    const status = result.code === "INSUFFICIENT_COINS" ? 409 : 400;
    const error = result.code === "INVALID_AMOUNT" ? "Invalid amount" : result.code === "INVALID_RECIPIENT" ? "Cannot support yourself" : "Insufficient coins";
    return json({ error }, status);
  }
  return json({
    error: null,
    data: {
      transferredAmount: result.transferredAmount,
      senderPtAdded: result.senderPtAdded,
      recipientPtAdded: result.recipientPtAdded,
      weekStartDate: result.weekStartDate
    }
  });
});
coinsRoutes.post("/support/revert", async (c) => {
  const parsed = safeParse(revertSupportSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  const result = await revertSupportTransferBySource({
    db,
    senderUserId: parsed.output.senderUserId,
    recipientUserId: parsed.output.recipientUserId,
    source: parsed.output.source
  });
  return json({
    error: null,
    data: result
  });
});
coinsRoutes.get("/support/rankings", async (c) => {
  const db = await getDb(c.env);
  const kindRaw = c.req.query("kind")?.trim() ?? "received";
  const weekStartDate = c.req.query("weekStartDate")?.trim() || void 0;
  const recipientUserId = c.req.query("recipientUserId")?.trim() || void 0;
  const offsetRaw = c.req.query("offset");
  const limitRaw = c.req.query("limit");
  const kind = kindRaw === "sent" ? "sent" : "received";
  const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : 0;
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
  if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(limit) || limit <= 0) {
    return json({ error: "Invalid paging" }, 400);
  }
  const ranking = await getSupportWeeklyRanking({
    db,
    kind,
    weekStartDate,
    offset,
    limit,
    recipientUserId
  });
  return json({
    error: null,
    data: ranking
  });
});
coinsRoutes.get("/support/rankings-period", async (c) => {
  const db = await getDb(c.env);
  const kindRaw = c.req.query("kind")?.trim() ?? "received";
  const periodRaw = c.req.query("period")?.trim() ?? "daily";
  const periodKey = c.req.query("periodKey")?.trim() || void 0;
  const offsetRaw = c.req.query("offset");
  const limitRaw = c.req.query("limit");
  const kind = kindRaw === "sent" ? "sent" : "received";
  const period = periodRaw === "monthly" ? "monthly" : periodRaw === "weekly" ? "weekly" : "daily";
  const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : 0;
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
  if (!periodKey) {
    return json({ error: "periodKey is required" }, 400);
  }
  if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(limit) || limit <= 0) {
    return json({ error: "Invalid paging" }, 400);
  }
  const ranking = await getSupportPeriodRanking({
    db,
    kind,
    period,
    periodKey,
    offset,
    limit
  });
  return json({
    error: null,
    data: ranking
  });
});
coinsRoutes.get("/support/weeks", async (c) => {
  const db = await getDb(c.env);
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 8;
  if (!Number.isFinite(limit) || limit <= 0) {
    return json({ error: "Invalid paging" }, 400);
  }
  const weekStartDates = await getSupportAvailableWeekStartDates(db, limit);
  return json({
    error: null,
    data: { weekStartDates }
  });
});
coinsRoutes.get("/support/recent", async (c) => {
  const db = await getDb(c.env);
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 3;
  if (!Number.isFinite(limit) || limit <= 0) {
    return json({ error: "Invalid limit" }, 400);
  }
  const recentTransfers = await db.query(
    `SELECT sender_user_id,
            recipient_user_id,
            coin_type,
            coin_amount,
            pt_amount,
            is_anonymous,
            created_at
       FROM coin_support_transfers
      WHERE sender_user_id <> '1'
        AND recipient_user_id <> '1'
      ORDER BY created_at DESC, id DESC
      LIMIT $1`,
    [Math.min(limit, 100)]
  );
  const items = recentTransfers.map((transfer) => ({
    senderUser: {
      id: transfer.is_anonymous ? "__anonymous__" : transfer.sender_user_id,
      login: null,
      name: null,
      iconUrl: null
    },
    recipientUser: {
      id: transfer.recipient_user_id,
      login: null,
      name: null,
      iconUrl: null
    },
    coinType: transfer.coin_type,
    coinAmount: transfer.coin_amount,
    ptAmount: transfer.pt_amount,
    isAnonymous: transfer.is_anonymous,
    createdAt: transfer.created_at
  }));
  return json({ error: null, data: { items } });
});
coinsRoutes.get("/support/summary", async (c) => {
  const db = await getDb(c.env);
  const viewerUserId = c.req.header("x-viewer-user-id");
  const weekStartDate = c.req.query("weekStartDate")?.trim() || void 0;
  if (!viewerUserId) {
    return json({ error: "Not authenticated" }, 401);
  }
  const summary = await getSupportSummary({
    db,
    userId: viewerUserId,
    weekStartDate
  });
  return json({
    error: null,
    data: {
      weeklySentCoinAmount: summary.weeklySentCoinAmount,
      weeklyReceivedCoinAmount: summary.weeklyReceivedCoinAmount,
      cumulativeSentCoins: summary.cumulativeSentCoins,
      cumulativeReceivedCoins: summary.cumulativeReceivedCoins
    }
  });
});
coinsRoutes.get("/support/summary/:userId", async (c) => {
  const db = await getDb(c.env);
  const weekStartDate = c.req.query("weekStartDate")?.trim() || void 0;
  const summary = await getSupportSummary({
    db,
    userId: c.req.param("userId"),
    weekStartDate
  });
  return json({
    error: null,
    data: summary
  });
});
coinsRoutes.get("/amazon-exchange", async (c) => {
  const db = await getDb(c.env);
  const userId = c.req.query("userId")?.trim();
  if (!userId) {
    return json({ error: "userId is required" }, 400);
  }
  const result = await listAmazonExchangeRequestsByUser({ db, userId });
  return json({ error: null, data: result });
});
coinsRoutes.post("/amazon-exchange", async (c) => {
  const parsed = safeParse(amazonExchangeCreateSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const db = await getDb(c.env);
  const result = await createAmazonExchangeRequest({
    db,
    userId: parsed.output.userId,
    packageId: parsed.output.packageId,
    coinAmount: parsed.output.coinAmount,
    amazonPointYen: parsed.output.amazonPointYen
  });
  if (!result.ok) {
    return json(
      {
        error: result.code === "PENDING_LIMIT" ? "Too many pending requests" : "Insufficient support premium coins",
        data: {
          remainingSlots: result.remainingSlots
        }
      },
      result.code === "PENDING_LIMIT" ? 409 : 400
    );
  }
  return json({
    error: null,
    data: {
      requestId: result.requestId,
      pendingCount: result.pendingCount,
      remainingSlots: result.remainingSlots
    }
  });
});
coinsRoutes.get("/amazon-exchange/admin", async (c) => {
  const db = await getDb(c.env);
  const statusRaw = c.req.query("status")?.trim();
  const status = statusRaw === "APPROVED" ? "APPROVED" : "PENDING";
  const offsetRaw = c.req.query("offset");
  const limitRaw = c.req.query("limit");
  const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : 0;
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
  if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(limit) || limit <= 0) {
    return json({ error: "Invalid paging" }, 400);
  }
  const result = await listAmazonExchangeRequestsForAdmin({
    db,
    status,
    offset,
    limit
  });
  return json({ error: null, data: result });
});
coinsRoutes.post("/amazon-exchange/:requestId/approve", async (c) => {
  const parsed = safeParse(amazonExchangeApproveSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const amazonGiftCode = parsed.output.amazonGiftCode.trim();
  if (!amazonGiftCode) {
    return json({ error: "amazonGiftCode is required" }, 400);
  }
  const db = await getDb(c.env);
  const result = await approveAmazonExchangeRequest({
    db,
    requestId: c.req.param("requestId"),
    amazonGiftCode,
    moderatorUserId: parsed.output.moderatorUserId
  });
  if (!result.ok) {
    return json({ error: "Request is not approvable" }, 409);
  }
  return json({
    error: null,
    data: {
      userId: result.userId,
      coinAmount: result.coinAmount,
      amazonPointYen: result.amazonPointYen
    }
  });
});
export var grantSupportSchema = object({
  recipientUserId: string(),
  coinType: union([literal("FREE"), literal("PREMIUM")]),
  amount: number(),
  reason: optional(nullable(string()))
});
coinsRoutes.post("/grant-support", async (c) => {
  const parsed = safeParse(grantSupportSchema, await c.req.json());
  if (!parsed.success) {
    return json({ error: "Invalid body" }, 400);
  }
  const amount = Math.floor(parsed.output.amount);
  if (amount <= 0) {
    return json({ error: "amount must be a positive integer" }, 400);
  }
  const db = await getDb(c.env);
  const result = await grantSupportCoinsAdmin({
    db,
    recipientUserId: parsed.output.recipientUserId,
    coinType: parsed.output.coinType,
    amount,
    reason: parsed.output.reason ?? "admin grant support coins"
  });
  return json({ error: null, data: result });
});
export var publicCoinsRoutes = new Hono2();
publicCoinsRoutes.get("/support/rankings/public", async (c) => {
  const db = await getDb(c.env);
  const kindRaw = c.req.query("kind")?.trim() ?? "received";
  const weekStartDate = c.req.query("weekStartDate")?.trim() || void 0;
  const recipientUserId = c.req.query("recipientUserId")?.trim() || void 0;
  const limitRaw = c.req.query("limit");
  const kind = kindRaw === "sent" ? "sent" : "received";
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 5;
  if (!Number.isFinite(limit) || limit <= 0) {
    return json({ error: "Invalid limit" }, 400);
  }
  const ranking = await getSupportWeeklyRanking({
    db,
    kind,
    weekStartDate,
    offset: 0,
    limit: Math.min(limit, 100),
    recipientUserId
  });
  return json({
    error: null,
    data: ranking
  });
});
