// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { getNow } from "./db"
export var SUPPORT_PT_MULTIPLIER = {
  FREE: 1,
  PREMIUM: 10
};
export var CONTRIBUTION_RANKING_EXCLUDED_USER_ID = "1";
export var ANONYMOUS_SUPPORT_USER_ID = "__anonymous__";
export var toJstDate = (unixSeconds) => {
  return new Date((unixSeconds + 9 * 60 * 60) * 1e3);
};
export var formatIsoDate = (date) => {
  return date.toISOString().slice(0, 10);
};
export var getSupportWeekStartDate = (unixSeconds = getNow()) => {
  const date = toJstDate(unixSeconds);
  const day = date.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diffToMonday);
  return formatIsoDate(date);
};
export var getBalanceColumn = (coinType) => {
  return coinType === "FREE" ? "free_balance" : "premium_balance";
};
export var transferSupportCoins = async (props) => {
  const now = props.now ?? getNow();
  const amount = Math.floor(Math.max(0, props.amount));
  if (amount <= 0) {
    return { ok: false, code: "INVALID_AMOUNT" };
  }
  if (props.senderUserId === props.recipientUserId) {
    return { ok: false, code: "INVALID_RECIPIENT" };
  }
  const ptAmount = amount * SUPPORT_PT_MULTIPLIER[props.coinType];
  const weekStartDate = getSupportWeekStartDate(now);
  const balanceColumn = getBalanceColumn(props.coinType);
  const isAnonymous = props.isAnonymous === true;
  if (props.source) {
    const existingTransfer = await props.db.queryOne(
      `SELECT COALESCE(SUM(coin_amount), 0)::INTEGER AS transferred_amount,
              COALESCE(SUM(pt_amount), 0)::INTEGER AS sender_pt_added,
              COALESCE(SUM(pt_amount), 0)::INTEGER AS recipient_pt_added,
              MIN(week_start_date)::text AS week_start_date,
              BOOL_OR(is_anonymous) AS is_anonymous
         FROM coin_support_transfers
        WHERE source = $1
          AND sender_user_id = $2
          AND recipient_user_id = $3
          AND coin_type = $4`,
      [
        props.source,
        props.senderUserId,
        props.recipientUserId,
        props.coinType
      ]
    );
    if (existingTransfer && (existingTransfer.transferred_amount ?? 0) > 0 && existingTransfer.transferred_amount === amount && existingTransfer.sender_pt_added === ptAmount && existingTransfer.recipient_pt_added === ptAmount && existingTransfer.week_start_date === weekStartDate && (existingTransfer.is_anonymous ?? false) === isAnonymous) {
      return {
        ok: true,
        transferredAmount: amount,
        senderPtAdded: ptAmount,
        recipientPtAdded: ptAmount,
        weekStartDate
      };
    }
  }
  const result = await props.db.queryOne(
    `WITH request_claim AS (
        INSERT INTO coin_support_request_claims(
          source,
          sender_user_id,
          recipient_user_id,
          coin_type,
          coin_amount,
          pt_amount,
          week_start_date,
          created_at
        )
        SELECT $6::TEXT, $1, $2, $4, $3, $8, $9::DATE, $7
         WHERE $6::TEXT IS NOT NULL
        ON CONFLICT (source) DO NOTHING
        RETURNING source
      ),
      request_gate AS (
        SELECT TRUE AS allowed
         WHERE $6::TEXT IS NULL
        UNION ALL
        SELECT TRUE AS allowed
          FROM request_claim
      ),
      ensured AS (
        INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        VALUES ($1, 0, 0, $7), ($2, 0, 0, $7)
        ON CONFLICT (user_id) DO NOTHING
      ),
      candidate_lots AS (
        SELECT id,
               remaining,
               SUM(remaining) OVER (
                 ORDER BY expires_at ASC NULLS LAST, id ASC
               ) AS cumulative
          FROM coin_lots
         WHERE user_id = $1
           AND coin_type = $4
           AND remaining > 0
             AND EXISTS (SELECT 1 FROM request_gate)
      ),
      updates AS (
        SELECT id,
               LEAST(remaining, GREATEST($3 - (cumulative - remaining), 0))::INTEGER AS spend
          FROM candidate_lots
         WHERE GREATEST($3 - (cumulative - remaining), 0) > 0
      ),
      spent_sum AS (
        SELECT COALESCE(SUM(spend), 0)::INTEGER AS spent
          FROM updates
      ),
      applied_lots AS (
        UPDATE coin_lots
           SET remaining = coin_lots.remaining - updates.spend,
               updated_at = $7
          FROM updates, spent_sum
         WHERE coin_lots.id = updates.id
           AND updates.spend > 0
           AND spent_sum.spent = $3
        RETURNING updates.spend
      ),
      applied_sum AS (
        SELECT COALESCE(SUM(spend), 0)::INTEGER AS spent
          FROM applied_lots
      ),
      updated_balance AS (
        UPDATE coin_balances
           SET ${balanceColumn} = GREATEST(coin_balances.${balanceColumn} - (SELECT spent FROM applied_sum), 0),
               updated_at = $7
         WHERE user_id = $1
           AND (SELECT spent FROM applied_sum) = $3
      ),
      sender_ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, $4, -(SELECT spent FROM applied_sum), 'CONSUME', $5, $6, $7, NULL
         WHERE (SELECT spent FROM applied_sum) = $3
      ),
      transfer AS (
        INSERT INTO coin_support_transfers(
          sender_user_id,
          recipient_user_id,
          coin_type,
          coin_amount,
          pt_amount,
          is_anonymous,
          source,
          week_start_date,
          created_at
        )
        SELECT $1, $2, $4, (SELECT spent FROM applied_sum), $8, $10, $6, $9, $7
         WHERE (SELECT spent FROM applied_sum) = $3
        RETURNING sender_user_id, recipient_user_id, coin_type, coin_amount, pt_amount, source, week_start_date, created_at
      ),
      sender_weekly AS (
        INSERT INTO coin_support_weekly_sent_points(
          week_start_date,
          user_id,
          coin_amount,
          pt_amount,
          transfer_count,
          updated_at
        )
        SELECT week_start_date, sender_user_id, coin_amount, pt_amount, 1, created_at
          FROM transfer
        ON CONFLICT (week_start_date, user_id) DO UPDATE SET
          coin_amount = coin_support_weekly_sent_points.coin_amount + EXCLUDED.coin_amount,
          pt_amount = coin_support_weekly_sent_points.pt_amount + EXCLUDED.pt_amount,
          transfer_count = coin_support_weekly_sent_points.transfer_count + EXCLUDED.transfer_count,
          updated_at = EXCLUDED.updated_at
      ),
      recipient_weekly AS (
        INSERT INTO coin_support_weekly_received_points(
          week_start_date,
          user_id,
          coin_amount,
          pt_amount,
          transfer_count,
          updated_at
        )
        SELECT week_start_date, recipient_user_id, coin_amount, pt_amount, 1, created_at
          FROM transfer
        ON CONFLICT (week_start_date, user_id) DO UPDATE SET
          coin_amount = coin_support_weekly_received_points.coin_amount + EXCLUDED.coin_amount,
          pt_amount = coin_support_weekly_received_points.pt_amount + EXCLUDED.pt_amount,
          transfer_count = coin_support_weekly_received_points.transfer_count + EXCLUDED.transfer_count,
          updated_at = EXCLUDED.updated_at
      ),
      sender_totals AS (
        INSERT INTO coin_support_totals(
          user_id,
          sent_pt_total,
          received_pt_total,
          sent_coin_total,
          received_coin_total,
          updated_at
        )
        SELECT sender_user_id, pt_amount, 0, coin_amount, 0, created_at
          FROM transfer
        ON CONFLICT (user_id) DO UPDATE SET
          sent_pt_total = coin_support_totals.sent_pt_total + EXCLUDED.sent_pt_total,
          sent_coin_total = coin_support_totals.sent_coin_total + EXCLUDED.sent_coin_total,
          updated_at = EXCLUDED.updated_at
      ),
      recipient_totals AS (
        INSERT INTO coin_support_totals(
          user_id,
          sent_pt_total,
          received_pt_total,
          sent_coin_total,
          received_coin_total,
          updated_at
        )
        SELECT recipient_user_id, 0, pt_amount, 0, coin_amount, created_at
          FROM transfer
        ON CONFLICT (user_id) DO UPDATE SET
          received_pt_total = coin_support_totals.received_pt_total + EXCLUDED.received_pt_total,
          received_coin_total = coin_support_totals.received_coin_total + EXCLUDED.received_coin_total,
          updated_at = EXCLUDED.updated_at
      ),
      recipient_premium_balance AS (
        UPDATE coin_balances
           SET premium_balance = coin_balances.premium_balance + (SELECT coin_amount FROM transfer),
               updated_at = $7
         WHERE user_id = $2
           AND $4 = 'PREMIUM'
           AND EXISTS (SELECT 1 FROM transfer)
      ),
      recipient_premium_lot AS (
        INSERT INTO coin_lots(
          user_id,
          coin_type,
          remaining,
          locked_amount,
          source_kind,
          source_ref_id,
          granted_by_user_id,
          expires_at,
          created_at,
          updated_at
        )
        SELECT $2,
               'PREMIUM',
               coin_amount,
               0,
               'SUPPORT',
               source,
               sender_user_id,
               NULL,
               created_at,
               created_at
          FROM transfer
         WHERE $4 = 'PREMIUM'
      ),
      recipient_premium_ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $2,
               'PREMIUM',
               coin_amount,
               'GRANT',
               COALESCE($5, 'coin support received'),
              source,
               created_at,
               NULL
          FROM transfer
         WHERE $4 = 'PREMIUM'
      )
      SELECT
        (SELECT spent FROM applied_sum) AS transferred_amount,
        (SELECT pt_amount FROM transfer) AS sender_pt_added,
        (SELECT pt_amount FROM transfer) AS recipient_pt_added,
        (SELECT week_start_date FROM transfer) AS week_start_date`,
    [
      props.senderUserId,
      props.recipientUserId,
      amount,
      props.coinType,
      props.reason ?? "coin support",
      props.source ?? "support",
      now,
      ptAmount,
      weekStartDate,
      isAnonymous
    ]
  );
  if (!result || result.transferred_amount !== amount || result.sender_pt_added !== ptAmount || result.recipient_pt_added !== ptAmount || result.week_start_date !== weekStartDate) {
    if (props.source) {
      const existingTransfer = await props.db.queryOne(
        `SELECT COALESCE(SUM(coin_amount), 0)::INTEGER AS transferred_amount,
                COALESCE(SUM(pt_amount), 0)::INTEGER AS sender_pt_added,
                COALESCE(SUM(pt_amount), 0)::INTEGER AS recipient_pt_added,
                MIN(week_start_date)::text AS week_start_date,
                BOOL_OR(is_anonymous) AS is_anonymous
           FROM coin_support_transfers
          WHERE source = $1
            AND sender_user_id = $2
            AND recipient_user_id = $3
            AND coin_type = $4`,
        [
          props.source,
          props.senderUserId,
          props.recipientUserId,
          props.coinType
        ]
      );
      if (existingTransfer && (existingTransfer.transferred_amount ?? 0) > 0 && existingTransfer.transferred_amount === amount && existingTransfer.sender_pt_added === ptAmount && existingTransfer.recipient_pt_added === ptAmount && existingTransfer.week_start_date === weekStartDate && (existingTransfer.is_anonymous ?? false) === isAnonymous) {
        return {
          ok: true,
          transferredAmount: amount,
          senderPtAdded: ptAmount,
          recipientPtAdded: ptAmount,
          weekStartDate
        };
      }
    }
    return { ok: false, code: "INSUFFICIENT_COINS" };
  }
  return {
    ok: true,
    transferredAmount: amount,
    senderPtAdded: ptAmount,
    recipientPtAdded: ptAmount,
    weekStartDate
  };
};
export var getSupportWeeklyRanking = async (props) => {
  const weekStartDate = props.weekStartDate ?? getSupportWeekStartDate();
  const offset = Math.max(0, Math.floor(props.offset ?? 0));
  const limit = Math.min(200, Math.max(1, Math.floor(props.limit ?? 100)));
  const userColumn = props.kind === "received" ? "recipient_user_id" : "sender_user_id";
  const excludeContributionUserId = props.kind === "sent" ? CONTRIBUTION_RANKING_EXCLUDED_USER_ID : null;
  if (props.kind === "sent" && props.recipientUserId) {
    const items2 = await props.db.query(
      `WITH grouped AS (
         SELECT CASE
                  WHEN is_anonymous THEN '${ANONYMOUS_SUPPORT_USER_ID}'
                  ELSE sender_user_id
                END AS "userId",
                SUM(coin_amount)::INTEGER AS "coinAmount",
                SUM(pt_amount)::INTEGER AS "ptAmount",
                SUM(CASE WHEN coin_type = 'FREE' THEN pt_amount ELSE 0 END)::INTEGER AS "freePtAmount",
                SUM(CASE WHEN coin_type = 'PREMIUM' THEN pt_amount ELSE 0 END)::INTEGER AS "premiumPtAmount",
                COUNT(*)::INTEGER AS "transferCount",
                BOOL_OR(is_anonymous) AS "isAnonymous"
           FROM coin_support_transfers
          WHERE recipient_user_id = $1
            AND sender_user_id <> $4
          GROUP BY CASE
                     WHEN is_anonymous THEN '${ANONYMOUS_SUPPORT_USER_ID}'
                     ELSE sender_user_id
                   END
       ),
       ranked AS (
         SELECT "userId",
                "coinAmount",
                "ptAmount",
                "freePtAmount",
                "premiumPtAmount",
                "transferCount",
                "isAnonymous",
                ROW_NUMBER() OVER (
                  ORDER BY "ptAmount" DESC, "transferCount" DESC, "userId" ASC
                ) AS rank
           FROM grouped
       )
       SELECT rank,
              "userId",
              "coinAmount",
              "ptAmount",
              "freePtAmount",
              "premiumPtAmount",
                  "transferCount",
                  "isAnonymous"
         FROM ranked
        ORDER BY rank ASC
        LIMIT $2
       OFFSET $3`,
      [props.recipientUserId, limit, offset, CONTRIBUTION_RANKING_EXCLUDED_USER_ID]
    );
    const countRow2 = await props.db.queryOne(
      `SELECT COUNT(*)::INTEGER AS count
         FROM (
           SELECT CASE
                    WHEN is_anonymous THEN '${ANONYMOUS_SUPPORT_USER_ID}'
                    ELSE sender_user_id
                  END AS sender_label
             FROM coin_support_transfers
            WHERE recipient_user_id = $1
              AND sender_user_id <> $2
            GROUP BY CASE
                       WHEN is_anonymous THEN '${ANONYMOUS_SUPPORT_USER_ID}'
                       ELSE sender_user_id
                     END
         ) AS grouped`,
      [props.recipientUserId, CONTRIBUTION_RANKING_EXCLUDED_USER_ID]
    );
    return {
      kind: props.kind,
      weekStartDate: "",
      items: items2,
      totalCount: countRow2?.count ?? 0,
      offset,
      limit
    };
  }
  const items = await props.db.query(
    `WITH grouped AS (
       SELECT ${userColumn} AS "userId",
              SUM(coin_amount)::INTEGER AS "coinAmount",
              SUM(pt_amount)::INTEGER AS "ptAmount",
              SUM(CASE WHEN coin_type = 'FREE' THEN pt_amount ELSE 0 END)::INTEGER AS "freePtAmount",
              SUM(CASE WHEN coin_type = 'PREMIUM' THEN pt_amount ELSE 0 END)::INTEGER AS "premiumPtAmount",
              COUNT(*)::INTEGER AS "transferCount"
         FROM coin_support_transfers
        WHERE week_start_date = $1
         AND ($4::TEXT IS NULL OR ${userColumn} <> $4)
        GROUP BY ${userColumn}
     ),
     ranked AS (
       SELECT "userId",
              "coinAmount",
              "ptAmount",
              "freePtAmount",
              "premiumPtAmount",
              "transferCount",
              ROW_NUMBER() OVER (
                ORDER BY "ptAmount" DESC, "transferCount" DESC, "userId" ASC
              ) AS rank
         FROM grouped
     )
     SELECT rank,
            "userId",
            "coinAmount",
            "ptAmount",
            "freePtAmount",
            "premiumPtAmount",
            "transferCount"
       FROM ranked
      ORDER BY rank ASC
      LIMIT $2
     OFFSET $3`,
    [weekStartDate, limit, offset, excludeContributionUserId]
  );
  const countRow = await props.db.queryOne(
    `SELECT COUNT(*)::INTEGER AS count
       FROM (
         SELECT ${userColumn}
           FROM coin_support_transfers
          WHERE week_start_date = $1
            AND ($2::TEXT IS NULL OR ${userColumn} <> $2)
          GROUP BY ${userColumn}
       ) AS grouped`,
    [weekStartDate, excludeContributionUserId]
  );
  return {
    kind: props.kind,
    weekStartDate,
    items,
    totalCount: countRow?.count ?? 0,
    offset,
    limit
  };
};
export var revertSupportTransferBySource = async (props) => {
  const now = props.now ?? getNow();
  const result = await props.db.queryOne(
    `WITH target AS (
        SELECT id,
               sender_user_id,
               recipient_user_id,
               coin_type,
               coin_amount,
               pt_amount,
               week_start_date,
               source,
               created_at
          FROM coin_support_transfers
         WHERE sender_user_id = $1
           AND recipient_user_id = $2
           AND source = $3
      ),
      free_totals AS (
        SELECT COALESCE(SUM(coin_amount), 0)::INTEGER AS coin_amount,
               COALESCE(SUM(pt_amount), 0)::BIGINT AS pt_amount
          FROM target
         WHERE coin_type = 'FREE'
      ),
      premium_totals AS (
        SELECT COALESCE(SUM(coin_amount), 0)::INTEGER AS coin_amount,
               COALESCE(SUM(pt_amount), 0)::BIGINT AS pt_amount
          FROM target
         WHERE coin_type = 'PREMIUM'
      ),
      ensured AS (
        INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        VALUES ($1, 0, 0, $4), ($2, 0, 0, $4)
        ON CONFLICT (user_id) DO NOTHING
      ),
      sender_balance AS (
        UPDATE coin_balances
           SET free_balance = coin_balances.free_balance + (SELECT coin_amount FROM free_totals),
               premium_balance = coin_balances.premium_balance + (SELECT coin_amount FROM premium_totals),
               updated_at = $4
         WHERE user_id = $1
           AND EXISTS (SELECT 1 FROM target)
      ),
      recipient_balance AS (
        UPDATE coin_balances
           SET premium_balance = GREATEST(
                 coin_balances.premium_balance - (SELECT coin_amount FROM premium_totals),
                 0
               ),
               updated_at = $4
         WHERE user_id = $2
           AND (SELECT coin_amount FROM premium_totals) > 0
      ),
      sender_free_refund_lot AS (
        INSERT INTO coin_lots(
          user_id,
          coin_type,
          remaining,
          locked_amount,
          source_kind,
          source_ref_id,
          granted_by_user_id,
          expires_at,
          created_at,
          updated_at
        )
        SELECT $1,
               'FREE',
               (SELECT coin_amount FROM free_totals),
               0,
               'ROLLBACK',
               $3,
               $2,
               NULL,
               $4,
               $4
         WHERE (SELECT coin_amount FROM free_totals) > 0
      ),
      sender_premium_refund_lot AS (
        INSERT INTO coin_lots(
          user_id,
          coin_type,
          remaining,
          locked_amount,
          source_kind,
          source_ref_id,
          granted_by_user_id,
          expires_at,
          created_at,
          updated_at
        )
        SELECT $1,
               'PREMIUM',
               (SELECT coin_amount FROM premium_totals),
               0,
               'ROLLBACK',
               $3,
               $2,
               NULL,
               $4,
               $4
         WHERE (SELECT coin_amount FROM premium_totals) > 0
      ),
      sender_free_ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1,
               'FREE',
               (SELECT coin_amount FROM free_totals),
               'GRANT',
               'support rollback refund',
               $3,
               $4,
               NULL
         WHERE (SELECT coin_amount FROM free_totals) > 0
      ),
      sender_premium_ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1,
               'PREMIUM',
               (SELECT coin_amount FROM premium_totals),
               'GRANT',
               'support rollback refund',
               $3,
               $4,
               NULL
         WHERE (SELECT coin_amount FROM premium_totals) > 0
      ),
      recipient_premium_lot_delete AS (
        DELETE FROM coin_lots
         WHERE user_id = $2
           AND coin_type = 'PREMIUM'
           AND source_kind = 'SUPPORT'
           AND source_ref_id = $3
      ),
      recipient_premium_ledger AS (
        INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $2,
               'PREMIUM',
               - (SELECT coin_amount FROM premium_totals),
               'CONSUME',
               'support rollback reversal',
               $3,
               $4,
               NULL
         WHERE (SELECT coin_amount FROM premium_totals) > 0
      ),
      sender_weekly AS (
        UPDATE coin_support_weekly_sent_points
           SET coin_amount = GREATEST(coin_support_weekly_sent_points.coin_amount - src.coin_amount, 0),
               pt_amount = GREATEST(coin_support_weekly_sent_points.pt_amount - src.pt_amount, 0),
               transfer_count = GREATEST(coin_support_weekly_sent_points.transfer_count - src.transfer_count, 0),
               updated_at = $4
          FROM (
            SELECT week_start_date,
                   sender_user_id AS user_id,
                   SUM(coin_amount)::INTEGER AS coin_amount,
                   SUM(pt_amount)::BIGINT AS pt_amount,
                   COUNT(*)::INTEGER AS transfer_count
              FROM target
             GROUP BY week_start_date, sender_user_id
          ) AS src
         WHERE coin_support_weekly_sent_points.week_start_date = src.week_start_date
           AND coin_support_weekly_sent_points.user_id = src.user_id
      ),
      recipient_weekly AS (
        UPDATE coin_support_weekly_received_points
           SET coin_amount = GREATEST(coin_support_weekly_received_points.coin_amount - src.coin_amount, 0),
               pt_amount = GREATEST(coin_support_weekly_received_points.pt_amount - src.pt_amount, 0),
               transfer_count = GREATEST(coin_support_weekly_received_points.transfer_count - src.transfer_count, 0),
               updated_at = $4
          FROM (
            SELECT week_start_date,
                   recipient_user_id AS user_id,
                   SUM(coin_amount)::INTEGER AS coin_amount,
                   SUM(pt_amount)::BIGINT AS pt_amount,
                   COUNT(*)::INTEGER AS transfer_count
              FROM target
             GROUP BY week_start_date, recipient_user_id
          ) AS src
         WHERE coin_support_weekly_received_points.week_start_date = src.week_start_date
           AND coin_support_weekly_received_points.user_id = src.user_id
      ),
      sender_totals AS (
        UPDATE coin_support_totals
           SET sent_pt_total = GREATEST(coin_support_totals.sent_pt_total - src.pt_amount, 0),
               sent_coin_total = GREATEST(coin_support_totals.sent_coin_total - src.coin_amount, 0),
               updated_at = $4
          FROM (
            SELECT sender_user_id AS user_id,
                   SUM(coin_amount)::BIGINT AS coin_amount,
                   SUM(pt_amount)::BIGINT AS pt_amount
              FROM target
             GROUP BY sender_user_id
          ) AS src
         WHERE coin_support_totals.user_id = src.user_id
      ),
      recipient_totals AS (
        UPDATE coin_support_totals
           SET received_pt_total = GREATEST(coin_support_totals.received_pt_total - src.pt_amount, 0),
               received_coin_total = GREATEST(coin_support_totals.received_coin_total - src.coin_amount, 0),
               updated_at = $4
          FROM (
            SELECT recipient_user_id AS user_id,
                   SUM(coin_amount)::BIGINT AS coin_amount,
                   SUM(pt_amount)::BIGINT AS pt_amount
              FROM target
             GROUP BY recipient_user_id
          ) AS src
         WHERE coin_support_totals.user_id = src.user_id
      ),
      deleted AS (
        DELETE FROM coin_support_transfers
         WHERE id IN (SELECT id FROM target)
         RETURNING id
      )
      SELECT (SELECT coin_amount FROM free_totals) AS free_amount,
             (SELECT coin_amount FROM premium_totals) AS premium_amount,
             (SELECT COUNT(*)::INTEGER FROM deleted) AS target_count`,
    [props.senderUserId, props.recipientUserId, props.source, now]
  );
  return {
    reversed: (result?.target_count ?? 0) > 0,
    freeAmount: result?.free_amount ?? 0,
    premiumAmount: result?.premium_amount ?? 0
  };
};
export var getSupportPeriodRanking = async (props) => {
  const offset = Math.max(0, Math.floor(props.offset ?? 0));
  const limit = Math.min(200, Math.max(1, Math.floor(props.limit ?? 100)));
  const userColumn = props.kind === "received" ? "recipient_user_id" : "sender_user_id";
  const excludeContributionUserId = props.kind === "sent" ? CONTRIBUTION_RANKING_EXCLUDED_USER_ID : null;
  const getPeriodFilter = () => {
    if (props.period === "weekly") {
      return {
        whereSql: "week_start_date = $1::date",
        params: [props.periodKey]
      };
    }
    if (props.period === "monthly") {
      return {
        whereSql: "to_char(timezone('Asia/Tokyo', to_timestamp(created_at)), 'YYYY-MM') = $1",
        params: [props.periodKey]
      };
    }
    return {
      whereSql: "to_char(timezone('Asia/Tokyo', to_timestamp(created_at)), 'YYYY-MM-DD') = $1",
      params: [props.periodKey]
    };
  };
  const { whereSql, params } = getPeriodFilter();
  const items = await props.db.query(
    `WITH grouped AS (
       SELECT ${userColumn} AS "userId",
              SUM(coin_amount)::INTEGER AS "coinAmount",
              SUM(pt_amount)::INTEGER AS "ptAmount",
              SUM(CASE WHEN coin_type = 'FREE' THEN pt_amount ELSE 0 END)::INTEGER AS "freePtAmount",
              SUM(CASE WHEN coin_type = 'PREMIUM' THEN pt_amount ELSE 0 END)::INTEGER AS "premiumPtAmount",
              COUNT(*)::INTEGER AS "transferCount"
         FROM coin_support_transfers
        WHERE ${whereSql}
         AND ($2::TEXT IS NULL OR ${userColumn} <> $2)
        GROUP BY ${userColumn}
     ),
     ranked AS (
       SELECT "userId",
              "coinAmount",
              "ptAmount",
              "freePtAmount",
              "premiumPtAmount",
              "transferCount",
              ROW_NUMBER() OVER (
                ORDER BY "ptAmount" DESC, "transferCount" DESC, "userId" ASC
              ) AS rank
         FROM grouped
     )
     SELECT rank,
            "userId",
            "coinAmount",
            "ptAmount",
            "freePtAmount",
            "premiumPtAmount",
            "transferCount"
       FROM ranked
      ORDER BY rank ASC
      LIMIT $3
     OFFSET $4`,
    [...params, excludeContributionUserId, limit, offset]
  );
  const countRow = await props.db.queryOne(
    `SELECT COUNT(*)::INTEGER AS count
       FROM (
         SELECT ${userColumn}
           FROM coin_support_transfers
          WHERE ${whereSql}
            AND ($2::TEXT IS NULL OR ${userColumn} <> $2)
          GROUP BY ${userColumn}
       ) AS grouped`,
    [...params, excludeContributionUserId]
  );
  return {
    kind: props.kind,
    period: props.period,
    periodKey: props.periodKey,
    items,
    totalCount: countRow?.count ?? 0,
    offset,
    limit
  };
};
export var getSupportAvailableWeekStartDates = async (db, limit = 8) => {
  const recentWeeks = await db.query(
    `SELECT week_start_date AS "weekStartDate"
       FROM (
         SELECT DISTINCT week_start_date
           FROM coin_support_weekly_received_points
         UNION
         SELECT DISTINCT week_start_date
           FROM coin_support_weekly_sent_points
       ) AS weeks
      ORDER BY week_start_date DESC
      LIMIT $1`,
    [Math.min(50, Math.max(1, Math.floor(limit)))]
  );
  const currentWeekStartDate = getSupportWeekStartDate();
  const weekStartDates = [
    currentWeekStartDate,
    ...recentWeeks.map((row) => row.weekStartDate)
  ];
  return Array.from(new Set(weekStartDates)).slice(0, limit);
};
export var getSupportSummary = async (props) => {
  const weekStartDate = props.weekStartDate ?? getSupportWeekStartDate();
  const totals = await props.db.queryOne(
    `SELECT sent_pt_total,
            received_pt_total,
            sent_coin_total,
            received_coin_total
       FROM coin_support_totals
      WHERE user_id = $1`,
    [props.userId]
  );
  const weeklySent = await props.db.queryOne(
    `SELECT pt_amount, coin_amount, transfer_count
       FROM coin_support_weekly_sent_points
      WHERE week_start_date = $1
        AND user_id = $2`,
    [weekStartDate, props.userId]
  );
  const weeklyReceived = await props.db.queryOne(
    `SELECT pt_amount, coin_amount, transfer_count
       FROM coin_support_weekly_received_points
      WHERE week_start_date = $1
        AND user_id = $2`,
    [weekStartDate, props.userId]
  );
  const sentRank = await props.db.queryOne(
    `WITH ranked AS (
       SELECT user_id,
              ROW_NUMBER() OVER (
                ORDER BY pt_amount DESC, transfer_count DESC, user_id ASC
              ) AS rank
         FROM coin_support_weekly_sent_points
        WHERE week_start_date = $1
          AND user_id <> $3
     )
     SELECT rank
       FROM ranked
      WHERE user_id = $2`,
    [weekStartDate, props.userId, CONTRIBUTION_RANKING_EXCLUDED_USER_ID]
  );
  const receivedRank = await props.db.queryOne(
    `WITH ranked AS (
       SELECT user_id,
              ROW_NUMBER() OVER (
                ORDER BY pt_amount DESC, transfer_count DESC, user_id ASC
              ) AS rank
         FROM coin_support_weekly_received_points
        WHERE week_start_date = $1
     )
     SELECT rank
       FROM ranked
      WHERE user_id = $2`,
    [weekStartDate, props.userId]
  );
  const availableWeekStartDates = await getSupportAvailableWeekStartDates(props.db);
  const receivedBreakdownRows = await props.db.query(
    `SELECT coin_type,
            COALESCE(SUM(coin_amount), 0)::INTEGER AS coin_amount,
            COALESCE(SUM(pt_amount), 0)::INTEGER AS pt_amount
       FROM coin_support_transfers
      WHERE recipient_user_id = $1
      GROUP BY coin_type`,
    [props.userId]
  );
  const recentReceivedTransfers = await props.db.query(
    `SELECT CASE
              WHEN is_anonymous THEN '${ANONYMOUS_SUPPORT_USER_ID}'
              ELSE sender_user_id
            END AS "senderUserId",
            is_anonymous AS "isAnonymous",
            coin_type AS "coinType",
            coin_amount AS "coinAmount",
            pt_amount AS "ptAmount",
            created_at AS "createdAt"
       FROM coin_support_transfers
      WHERE recipient_user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 20`,
    [props.userId]
  );
  const receivedFree = receivedBreakdownRows.find(
    (row) => row.coin_type === "FREE"
  );
  const receivedPremium = receivedBreakdownRows.find(
    (row) => row.coin_type === "PREMIUM"
  );
  return {
    userId: props.userId,
    weekStartDate,
    cumulativeSentPt: totals?.sent_pt_total ?? 0,
    cumulativeReceivedPt: totals?.received_pt_total ?? 0,
    cumulativeSentCoins: totals?.sent_coin_total ?? 0,
    cumulativeReceivedCoins: totals?.received_coin_total ?? 0,
    cumulativeReceivedFreeCoins: receivedFree?.coin_amount ?? 0,
    cumulativeReceivedPremiumCoins: receivedPremium?.coin_amount ?? 0,
    cumulativeReceivedFreePt: receivedFree?.pt_amount ?? 0,
    cumulativeReceivedPremiumPt: receivedPremium?.pt_amount ?? 0,
    weeklySentPt: weeklySent?.pt_amount ?? 0,
    weeklyReceivedPt: weeklyReceived?.pt_amount ?? 0,
    weeklySentCoinAmount: weeklySent?.coin_amount ?? 0,
    weeklyReceivedCoinAmount: weeklyReceived?.coin_amount ?? 0,
    weeklySentTransferCount: weeklySent?.transfer_count ?? 0,
    weeklyReceivedTransferCount: weeklyReceived?.transfer_count ?? 0,
    weeklySentRank: sentRank?.rank ?? null,
    weeklyReceivedRank: receivedRank?.rank ?? null,
    availableWeekStartDates,
    recentReceivedTransfers
  };
};
export var grantSupportCoinsAdmin = async (props) => {
  const now = props.now ?? getNow();
  const amount = Math.floor(Math.max(0, props.amount));
  if (amount <= 0) {
    throw new Error("amount must be > 0");
  }
  const ptAmount = amount * SUPPORT_PT_MULTIPLIER[props.coinType];
  const weekStartDate = getSupportWeekStartDate(now);
  const reason = props.reason ?? "admin grant support coins";
  if (props.coinType === "PREMIUM") {
    await props.db.execute(
      `WITH ensured AS (
          INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
          VALUES ($1, 0, 0, $3)
          ON CONFLICT (user_id) DO NOTHING
        ),
        lot AS (
          INSERT INTO coin_lots(
            user_id,
            coin_type,
            remaining,
            locked_amount,
            source_kind,
            source_ref_id,
            granted_by_user_id,
            expires_at,
            created_at,
            updated_at
          )
          VALUES ($1, 'PREMIUM', $2, 0, 'SUPPORT', $5, NULL, NULL, $3, $3)
        ),
        balance AS (
          UPDATE coin_balances
             SET premium_balance = premium_balance + $2, updated_at = $3
           WHERE user_id = $1
        ),
        ledger AS (
          INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
          VALUES ($1, 'PREMIUM', $2, 'GRANT', $4, 'admin-support-grant', $3, NULL)
        )
        SELECT 1`,
      [props.recipientUserId, amount, now, reason, `admin-support-grant-${now}`]
    );
  } else {
    await props.db.execute(
      `WITH ensured AS (
          INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
          VALUES ($1, 0, 0, $3)
          ON CONFLICT (user_id) DO NOTHING
        ),
        lot AS (
          INSERT INTO coin_lots(
            user_id,
            coin_type,
            remaining,
            locked_amount,
            source_kind,
            source_ref_id,
            granted_by_user_id,
            expires_at,
            created_at,
            updated_at
          )
          VALUES ($1, 'FREE', $2, 0, 'SUPPORT', $5, NULL, NULL, $3, $3)
        ),
        balance AS (
          UPDATE coin_balances
             SET free_balance = free_balance + $2, updated_at = $3
           WHERE user_id = $1
        ),
        ledger AS (
          INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
          VALUES ($1, 'FREE', $2, 'GRANT', $4, 'admin-support-grant', $3, NULL)
        )
        SELECT 1`,
      [props.recipientUserId, amount, now, reason, `admin-support-grant-${now}`]
    );
  }
  await props.db.execute(
    `INSERT INTO coin_support_totals(
        user_id,
        sent_pt_total,
        received_pt_total,
        sent_coin_total,
        received_coin_total,
        updated_at
      )
      VALUES ($1, 0, $2, 0, $3, $4)
      ON CONFLICT (user_id) DO UPDATE SET
        received_pt_total = coin_support_totals.received_pt_total + EXCLUDED.received_pt_total,
        received_coin_total = coin_support_totals.received_coin_total + EXCLUDED.received_coin_total,
        updated_at = EXCLUDED.updated_at`,
    [props.recipientUserId, ptAmount, amount, now]
  );
  await props.db.execute(
    `INSERT INTO coin_support_weekly_received_points(
        week_start_date,
        user_id,
        coin_amount,
        pt_amount,
        transfer_count,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 1, $5)
      ON CONFLICT (week_start_date, user_id) DO UPDATE SET
        coin_amount = coin_support_weekly_received_points.coin_amount + EXCLUDED.coin_amount,
        pt_amount = coin_support_weekly_received_points.pt_amount + EXCLUDED.pt_amount,
        transfer_count = coin_support_weekly_received_points.transfer_count + EXCLUDED.transfer_count,
        updated_at = EXCLUDED.updated_at`,
    [weekStartDate, props.recipientUserId, amount, ptAmount, now]
  );
  return { granted: amount, ptAmount, weekStartDate };
};
