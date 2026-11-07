// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
// 感謝コインを送る・戻す・運営から付与する
import { getNow } from "../db"
import { SUPPORT_PT_MULTIPLIER, getBalanceColumn, getSupportWeekStartDate } from "./common"
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
      `SELECT COALESCE(SUM(coin_amount), 0) AS transferred_amount,
              COALESCE(SUM(pt_amount), 0) AS sender_pt_added,
              COALESCE(SUM(pt_amount), 0) AS recipient_pt_added,
              MIN(week_start_date) AS week_start_date,
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
        SELECT $6, $1, $2, $4, $3, $8, $9, $7
         WHERE $6 IS NOT NULL
        ON CONFLICT (source) DO NOTHING
        RETURNING source
      ),
      request_gate AS (
        SELECT TRUE AS allowed
         WHERE $6 IS NULL
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
               min(remaining, max($3 - (cumulative - remaining), 0)) AS spend
          FROM candidate_lots
         WHERE max($3 - (cumulative - remaining), 0) > 0
      ),
      spent_sum AS (
        SELECT COALESCE(SUM(spend), 0) AS spent
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
        SELECT COALESCE(SUM(spend), 0) AS spent
          FROM applied_lots
      ),
      updated_balance AS (
        UPDATE coin_balances
           SET ${balanceColumn} = max(coin_balances.${balanceColumn} - (SELECT spent FROM applied_sum), 0),
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
        `SELECT COALESCE(SUM(coin_amount), 0) AS transferred_amount,
                COALESCE(SUM(pt_amount), 0) AS sender_pt_added,
                COALESCE(SUM(pt_amount), 0) AS recipient_pt_added,
                MIN(week_start_date) AS week_start_date,
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
        SELECT COALESCE(SUM(coin_amount), 0) AS coin_amount,
               COALESCE(SUM(pt_amount), 0) AS pt_amount
          FROM target
         WHERE coin_type = 'FREE'
      ),
      premium_totals AS (
        SELECT COALESCE(SUM(coin_amount), 0) AS coin_amount,
               COALESCE(SUM(pt_amount), 0) AS pt_amount
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
           SET premium_balance = max(
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
           SET coin_amount = max(coin_support_weekly_sent_points.coin_amount - src.coin_amount, 0),
               pt_amount = max(coin_support_weekly_sent_points.pt_amount - src.pt_amount, 0),
               transfer_count = max(coin_support_weekly_sent_points.transfer_count - src.transfer_count, 0),
               updated_at = $4
          FROM (
            SELECT week_start_date,
                   sender_user_id AS user_id,
                   SUM(coin_amount) AS coin_amount,
                   SUM(pt_amount) AS pt_amount,
                   COUNT(*) AS transfer_count
              FROM target
             GROUP BY week_start_date, sender_user_id
          ) AS src
         WHERE coin_support_weekly_sent_points.week_start_date = src.week_start_date
           AND coin_support_weekly_sent_points.user_id = src.user_id
      ),
      recipient_weekly AS (
        UPDATE coin_support_weekly_received_points
           SET coin_amount = max(coin_support_weekly_received_points.coin_amount - src.coin_amount, 0),
               pt_amount = max(coin_support_weekly_received_points.pt_amount - src.pt_amount, 0),
               transfer_count = max(coin_support_weekly_received_points.transfer_count - src.transfer_count, 0),
               updated_at = $4
          FROM (
            SELECT week_start_date,
                   recipient_user_id AS user_id,
                   SUM(coin_amount) AS coin_amount,
                   SUM(pt_amount) AS pt_amount,
                   COUNT(*) AS transfer_count
              FROM target
             GROUP BY week_start_date, recipient_user_id
          ) AS src
         WHERE coin_support_weekly_received_points.week_start_date = src.week_start_date
           AND coin_support_weekly_received_points.user_id = src.user_id
      ),
      sender_totals AS (
        UPDATE coin_support_totals
           SET sent_pt_total = max(coin_support_totals.sent_pt_total - src.pt_amount, 0),
               sent_coin_total = max(coin_support_totals.sent_coin_total - src.coin_amount, 0),
               updated_at = $4
          FROM (
            SELECT sender_user_id AS user_id,
                   SUM(coin_amount) AS coin_amount,
                   SUM(pt_amount) AS pt_amount
              FROM target
             GROUP BY sender_user_id
          ) AS src
         WHERE coin_support_totals.user_id = src.user_id
      ),
      recipient_totals AS (
        UPDATE coin_support_totals
           SET received_pt_total = max(coin_support_totals.received_pt_total - src.pt_amount, 0),
               received_coin_total = max(coin_support_totals.received_coin_total - src.coin_amount, 0),
               updated_at = $4
          FROM (
            SELECT recipient_user_id AS user_id,
                   SUM(coin_amount) AS coin_amount,
                   SUM(pt_amount) AS pt_amount
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
             (SELECT COUNT(*) FROM deleted) AS target_count`,
    [props.senderUserId, props.recipientUserId, props.source, now]
  );
  return {
    reversed: (result?.target_count ?? 0) > 0,
    freeAmount: result?.free_amount ?? 0,
    premiumAmount: result?.premium_amount ?? 0
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
