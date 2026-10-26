// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { getNow } from "./db"
export var AMAZON_EXCHANGE_MAX_PENDING = 3;
export var listAmazonExchangeRequestsByUser = async (props) => {
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
      WHERE user_id = $1
      ORDER BY applied_at DESC, id DESC`,
    [props.userId]
  );
  const pendingCountRow = await props.db.queryOne(
    `SELECT COUNT(*)::INTEGER AS count
       FROM amazon_exchange_requests
      WHERE user_id = $1
        AND status = 'PENDING'`,
    [props.userId]
  );
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
  const result = await props.db.queryOne(
    `WITH pending_count AS (
        SELECT COUNT(*)::INTEGER AS pending_count
          FROM amazon_exchange_requests
         WHERE user_id = $1
           AND status = 'PENDING'
      ),
      candidate_lots AS (
        SELECT id,
               GREATEST(remaining - locked_amount, 0) AS available,
               SUM(GREATEST(remaining - locked_amount, 0)) OVER (
                 ORDER BY expires_at ASC NULLS LAST, id ASC
               ) AS cumulative
          FROM coin_lots
         WHERE user_id = $1
           AND coin_type = 'PREMIUM'
           AND source_kind = 'SUPPORT'
           AND remaining > locked_amount
      ),
      allocations AS (
        SELECT id,
               LEAST(available, GREATEST($2 - (cumulative - available), 0))::INTEGER AS amount
          FROM candidate_lots
         WHERE GREATEST($2 - (cumulative - available), 0) > 0
      ),
      allocation_sum AS (
        SELECT COALESCE(SUM(amount), 0)::INTEGER AS locked_amount
          FROM allocations
      ),
      eligible AS (
        SELECT 1 AS ok
         WHERE (SELECT pending_count FROM pending_count) < $6
           AND (SELECT locked_amount FROM allocation_sum) = $2
      ),
      updated_lots AS (
        UPDATE coin_lots
           SET locked_amount = coin_lots.locked_amount + allocations.amount,
               updated_at = $5
          FROM allocations, eligible
         WHERE coin_lots.id = allocations.id
        RETURNING coin_lots.id
      ),
      request_row AS (
        INSERT INTO amazon_exchange_requests(
          id,
          user_id,
          package_id,
          coin_amount,
          amazon_point_yen,
          status,
          amazon_gift_code,
          locked_lot_allocations_json,
          applied_at,
          approved_at,
          approved_by_user_id,
          created_at,
          updated_at
        )
        SELECT $3,
               $1,
               $4,
               $2,
               $7,
               'PENDING',
               NULL,
               COALESCE(
                 (SELECT jsonb_agg(jsonb_build_object('lotId', id, 'amount', amount))::text FROM allocations),
                 '[]'
               ),
               $5,
               NULL,
               NULL,
               $5,
               $5
          FROM eligible
        RETURNING id
      )
      SELECT (SELECT pending_count FROM pending_count) AS pending_count,
             EXISTS(SELECT 1 FROM request_row) AS created`,
    [
      props.userId,
      Math.max(0, Math.floor(props.coinAmount)),
      requestId,
      props.packageId,
      now,
      AMAZON_EXCHANGE_MAX_PENDING,
      Math.max(0, Math.floor(props.amazonPointYen))
    ]
  );
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
    `SELECT COUNT(*)::INTEGER AS count
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
  const result = await props.db.queryOne(
    `WITH request_row AS (
        SELECT *
          FROM amazon_exchange_requests
         WHERE id = $1
           AND status = 'PENDING'
      ),
      allocations AS (
        SELECT (entry->>'lotId')::BIGINT AS lot_id,
               (entry->>'amount')::INTEGER AS amount
          FROM request_row,
               jsonb_array_elements(locked_lot_allocations_json::jsonb) AS entry
      ),
      allocation_totals AS (
        SELECT COUNT(*)::INTEGER AS allocation_count,
               COALESCE(SUM(amount), 0)::INTEGER AS coin_amount
          FROM allocations
      ),
      lot_check AS (
        SELECT COUNT(*)::INTEGER AS matched_count,
               COALESCE(BOOL_AND(coin_lots.locked_amount >= allocations.amount AND coin_lots.remaining >= allocations.amount), FALSE) AS valid
          FROM allocations
          JOIN coin_lots ON coin_lots.id = allocations.lot_id
      ),
      eligible AS (
        SELECT 1 AS ok
         WHERE EXISTS (SELECT 1 FROM request_row)
           AND (SELECT allocation_count FROM allocation_totals) = (SELECT matched_count FROM lot_check)
           AND (SELECT valid FROM lot_check)
      ),
      updated_lots AS (
        UPDATE coin_lots
           SET locked_amount = coin_lots.locked_amount - allocations.amount,
               remaining = coin_lots.remaining - allocations.amount,
               updated_at = $4
          FROM allocations, eligible
         WHERE coin_lots.id = allocations.lot_id
        RETURNING coin_lots.id
      ),
      ensured_balance AS (
        INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        SELECT user_id, 0, 0, $4
          FROM request_row
        ON CONFLICT (user_id) DO NOTHING
      ),
      updated_balance AS (
        UPDATE coin_balances
           SET premium_balance = GREATEST(
                 coin_balances.premium_balance - (SELECT coin_amount FROM allocation_totals),
                 0
               ),
               updated_at = $4
         WHERE user_id = (SELECT user_id FROM request_row)
           AND EXISTS (SELECT 1 FROM eligible)
        RETURNING user_id
      ),
      ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT user_id,
               'PREMIUM',
               -(SELECT coin_amount FROM allocation_totals),
               'CONSUME',
               'amazon-exchange',
               'amazon_exchange',
               $4,
               NULL
          FROM request_row
         WHERE EXISTS (SELECT 1 FROM updated_balance)
      ),
      updated_request AS (
        UPDATE amazon_exchange_requests
           SET status = 'APPROVED',
               amazon_gift_code = $2,
               approved_at = $4,
               approved_by_user_id = $3,
               updated_at = $4
         WHERE id = $1
           AND EXISTS (SELECT 1 FROM updated_balance)
        RETURNING user_id, coin_amount, amazon_point_yen
      )
      SELECT EXISTS(SELECT 1 FROM updated_request) AS approved,
             (SELECT user_id FROM updated_request) AS user_id,
             (SELECT coin_amount FROM updated_request) AS coin_amount,
             (SELECT amazon_point_yen FROM updated_request) AS amazon_point_yen`,
    [
      props.requestId,
      props.amazonGiftCode,
      props.moderatorUserId,
      now
    ]
  );
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
