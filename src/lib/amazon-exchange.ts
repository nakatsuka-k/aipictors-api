// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { getNow } from "./db"
export var AMAZON_EXCHANGE_MAX_PENDING = 3;
export var listAmazonExchangeRequestsByUser = async (props) => {
  const [requests, pendingCountRow] = await Promise.all([
    props.db.query(
    `SELECT id,
            user_id AS "userId",
            package_id AS "packageId",
            coin_amount AS "coinAmount",
            amazon_point_yen AS "amazonPointYen",
            status,
            amazon_gift_code AS "amazonGiftCode",
            applied_at AS "appliedAt",
            approved_at AS "approvedAt"
       FROM amazon_exchange_requests
      WHERE user_id = $1
      ORDER BY applied_at DESC, id DESC`,
    [props.userId]
    ),
    props.db.queryOne(
    `SELECT COUNT(*) AS count
       FROM amazon_exchange_requests
      WHERE user_id = $1
        AND status = 'PENDING'`,
    [props.userId]
  ),
  ]);
  const pendingCount = pendingCountRow?.count ?? 0;
  return {
    requests,
    pendingCount,
    remainingSlots: Math.max(0, AMAZON_EXCHANGE_MAX_PENDING - pendingCount)
  };
};
export var createAmazonExchangeRequest = async (props) => {
  const now = props.now ?? getNow();
  const requestId = crypto.randomUUID();
  const pendingSql = `(SELECT COUNT(*) FROM amazon_exchange_requests WHERE user_id = $1 AND status = 'PENDING')`;
  const allocationsSql = `SELECT id,
               min(available, max($2 - (cumulative - available), 0)) AS amount
          FROM (
            SELECT id,
                   max(remaining - locked_amount, 0) AS available,
                   SUM(max(remaining - locked_amount, 0)) OVER (ORDER BY expires_at ASC NULLS LAST, id ASC) AS cumulative
              FROM coin_lots
             WHERE user_id = $1
               AND coin_type = 'PREMIUM'
               AND source_kind = 'SUPPORT'
               AND remaining > locked_amount
          )
         WHERE max($2 - (cumulative - available), 0) > 0`;
  const guarded = "EXISTS (SELECT 1 FROM d1_guard)";
  const params = [
    props.userId,
    Math.max(0, Math.floor(props.coinAmount)),
    requestId,
    props.packageId,
    now,
    AMAZON_EXCHANGE_MAX_PENDING,
    Math.max(0, Math.floor(props.amazonPointYen))
  ];
  // 申請数の上限と、確保できる量を「書く前」に判定して d1_guard に入れ、以降の文はその行があるときだけ書く
  const results = await props.db.batch([
    { text: `SELECT ${pendingSql} AS pending_count`, params },
    {
      text: `INSERT INTO d1_guard(ok) SELECT 1
         WHERE ${pendingSql} < $6
           AND (SELECT COALESCE(SUM(amount), 0) FROM (${allocationsSql})) = $2`,
      params
    },
    {
      text: `INSERT INTO amazon_exchange_requests(id, user_id, package_id, coin_amount, amazon_point_yen, status, amazon_gift_code, locked_lot_allocations_json, applied_at, approved_at, approved_by_user_id, created_at, updated_at)
        SELECT $3, $1, $4, $2, $7, 'PENDING', NULL,
               COALESCE((SELECT json_group_array(json_object('lotId', id, 'amount', amount)) FROM (${allocationsSql})), '[]'),
               $5, NULL, NULL, $5, $5
         WHERE ${guarded}`,
      params
    },
    {
      text: `UPDATE coin_lots
           SET locked_amount = coin_lots.locked_amount + allocations.amount,
               updated_at = $5
          FROM (${allocationsSql}) AS allocations
         WHERE coin_lots.id = allocations.id
           AND ${guarded}`,
      params
    },
    { text: `SELECT ${guarded} AS created` },
    { text: "DELETE FROM d1_guard" }
  ]);
  const result = {
    pending_count: results[0].rows[0]?.pending_count ?? 0,
    created: Boolean(results[4].rows[0]?.created)
  };
  const pendingCount = result?.pending_count ?? 0;
  const remainingSlots = Math.max(
    0,
    AMAZON_EXCHANGE_MAX_PENDING - pendingCount - (result?.created ? 1 : 0)
  );
  if (!result?.created) {
    return {
      ok: false,
      code: pendingCount >= AMAZON_EXCHANGE_MAX_PENDING ? "PENDING_LIMIT" : "INSUFFICIENT_SUPPORT_PREMIUM_COINS",
      remainingSlots
    };
  }
  return {
    ok: true,
    requestId,
    pendingCount: pendingCount + 1,
    remainingSlots
  };
};
export var listAmazonExchangeRequestsForAdmin = async (props) => {
  const status = props.status ?? "PENDING";
  const offset = Math.max(0, Math.floor(props.offset ?? 0));
  const limit = Math.min(200, Math.max(1, Math.floor(props.limit ?? 50)));
  const requests = await props.db.query(
    `SELECT id,
            user_id AS "userId",
            package_id AS "packageId",
            coin_amount AS "coinAmount",
            amazon_point_yen AS "amazonPointYen",
            status,
            amazon_gift_code AS "amazonGiftCode",
            applied_at AS "appliedAt",
            approved_at AS "approvedAt"
       FROM amazon_exchange_requests
      WHERE status = $1
      ORDER BY applied_at DESC, id DESC
      LIMIT $2
     OFFSET $3`,
    [status, limit, offset]
  );
  const totalCountRow = await props.db.queryOne(
    `SELECT COUNT(*) AS count
       FROM amazon_exchange_requests
      WHERE status = $1`,
    [status]
  );
  return {
    requests,
    totalCount: totalCountRow?.count ?? 0,
    offset,
    limit
  };
};
export var approveAmazonExchangeRequest = async (props) => {
  const now = props.now ?? getNow();
  const requestSql = `SELECT * FROM amazon_exchange_requests WHERE id = $1 AND status = 'PENDING'`;
  const allocationsSql = `SELECT json_extract(entry.value, '$.lotId') AS lot_id,
               json_extract(entry.value, '$.amount') AS amount
          FROM (${requestSql}) AS request_row,
               json_each(request_row.locked_lot_allocations_json) AS entry`;
  const coinAmountSql = `(SELECT COALESCE(SUM(amount), 0) FROM (${allocationsSql}))`;
  const guarded = "EXISTS (SELECT 1 FROM d1_guard)";
  const params = [props.requestId, props.amazonGiftCode, props.moderatorUserId, now];
  // 申請とロットの確認を「書く前」に行って d1_guard に入れ、以降の文はその行があるときだけ書く。申請の更新は最後
  const results = await props.db.batch([
    {
      text: `INSERT INTO d1_guard(ok) SELECT 1
         WHERE EXISTS (${requestSql})
           AND (SELECT COUNT(*) FROM (${allocationsSql})) = (
             SELECT COUNT(*) FROM (${allocationsSql}) AS a JOIN coin_lots ON coin_lots.id = a.lot_id
           )
           AND COALESCE((
             SELECT min(coin_lots.locked_amount >= a.amount AND coin_lots.remaining >= a.amount)
               FROM (${allocationsSql}) AS a JOIN coin_lots ON coin_lots.id = a.lot_id
           ), 0)`,
      params
    },
    {
      text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        SELECT user_id, 0, 0, $4 FROM (${requestSql}) WHERE true
        ON CONFLICT (user_id) DO NOTHING`,
      params
    },
    {
      text: `UPDATE coin_balances
           SET premium_balance = max(coin_balances.premium_balance - ${coinAmountSql}, 0),
               updated_at = $4
         WHERE user_id = (SELECT user_id FROM (${requestSql}))
           AND ${guarded}`,
      params
    },
    {
      text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT user_id, 'PREMIUM', -${coinAmountSql}, 'CONSUME', 'amazon-exchange', 'amazon_exchange', $4, NULL
          FROM (${requestSql})
         WHERE ${guarded}`,
      params
    },
    {
      text: `UPDATE coin_lots
           SET locked_amount = coin_lots.locked_amount - a.amount,
               remaining = coin_lots.remaining - a.amount,
               updated_at = $4
          FROM (${allocationsSql}) AS a
         WHERE coin_lots.id = a.lot_id
           AND ${guarded}`,
      params
    },
    {
      text: `UPDATE amazon_exchange_requests
           SET status = 'APPROVED',
               amazon_gift_code = $2,
               approved_at = $4,
               approved_by_user_id = $3,
               updated_at = $4
         WHERE id = $1
           AND status = 'PENDING'
           AND ${guarded}
        RETURNING user_id, coin_amount, amazon_point_yen`,
      params
    },
    { text: "DELETE FROM d1_guard" }
  ]);
  const approvedRow = results[5].rows[0];
  const result = approvedRow
    ? { approved: true, user_id: approvedRow.user_id, coin_amount: approvedRow.coin_amount, amazon_point_yen: approvedRow.amazon_point_yen }
    : { approved: false };
  if (!result?.approved) {
    return {
      ok: false,
      code: "REQUEST_NOT_APPROVABLE"
    };
  }
  return {
    ok: true,
    userId: result.user_id ?? "",
    coinAmount: result.coin_amount ?? 0,
    amazonPointYen: result.amazon_point_yen ?? 0
  };
};
