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
              max(is_anonymous) AS is_anonymous
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
    if (existingTransfer && (existingTransfer.transferred_amount ?? 0) > 0 && existingTransfer.transferred_amount === amount && existingTransfer.sender_pt_added === ptAmount && existingTransfer.recipient_pt_added === ptAmount && existingTransfer.week_start_date === weekStartDate && Boolean(existingTransfer.is_anonymous) === isAnonymous) {
      return {
        ok: true,
        transferredAmount: amount,
        senderPtAdded: ptAmount,
        recipientPtAdded: ptAmount,
        weekStartDate
      };
    }
  }
  // D1: 1 つのトランザクション（batch）で実行する。使う量は「使う前のロット」から計算し、
  // 受付（source の重複なし）と残高が足りるときだけ d1_guard に 1 行入れて、以降の文はその行があるときだけ書く（最後に消す）
  const updatesSql = `SELECT id,
               min(remaining, max($3 - (cumulative - remaining), 0)) AS spend
          FROM (
            SELECT id,
                   remaining,
                   SUM(remaining) OVER (ORDER BY expires_at ASC NULLS LAST, id ASC) AS cumulative
              FROM coin_lots
             WHERE user_id = $1
               AND coin_type = $4
               AND remaining > 0
          )
         WHERE max($3 - (cumulative - remaining), 0) > 0`;
  const spentSql = `(SELECT COALESCE(SUM(spend), 0) FROM (${updatesSql}))`;
  const guarded = "EXISTS (SELECT 1 FROM d1_guard)";
  const params = [
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
  ];
  const upsertWeekly = (table, userParam) => ({
    text: `INSERT INTO ${table}(week_start_date, user_id, coin_amount, pt_amount, transfer_count, updated_at)
        SELECT $9, ${userParam}, $3, $8, 1, $7 WHERE ${guarded}
        ON CONFLICT (week_start_date, user_id) DO UPDATE SET
          coin_amount = ${table}.coin_amount + EXCLUDED.coin_amount,
          pt_amount = ${table}.pt_amount + EXCLUDED.pt_amount,
          transfer_count = ${table}.transfer_count + EXCLUDED.transfer_count,
          updated_at = EXCLUDED.updated_at`,
    params
  });
  const results = await props.db.batch([
    {
      text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        VALUES ($1, 0, 0, $7), ($2, 0, 0, $7)
        ON CONFLICT (user_id) DO NOTHING`,
      params
    },
    {
      text: `INSERT INTO coin_support_request_claims(source, sender_user_id, recipient_user_id, coin_type, coin_amount, pt_amount, week_start_date, created_at)
        SELECT $6, $1, $2, $4, $3, $8, $9, $7
         WHERE $6 IS NOT NULL
        ON CONFLICT (source) DO NOTHING`,
      params
    },
    // changes() は直前の文（受付の INSERT）で入った行数
    { text: `INSERT INTO d1_guard(ok) SELECT 1 WHERE ($6 IS NULL OR changes() = 1) AND ${spentSql} = $3`, params },
    {
      text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, $4, -$3, 'CONSUME', $5, $6, $7, NULL WHERE ${guarded}`,
      params
    },
    {
      text: `INSERT INTO coin_support_transfers(sender_user_id, recipient_user_id, coin_type, coin_amount, pt_amount, is_anonymous, source, week_start_date, created_at)
        SELECT $1, $2, $4, $3, $8, $10, $6, $9, $7 WHERE ${guarded}`,
      params
    },
    upsertWeekly("coin_support_weekly_sent_points", "$1"),
    upsertWeekly("coin_support_weekly_received_points", "$2"),
    {
      text: `INSERT INTO coin_support_totals(user_id, sent_pt_total, received_pt_total, sent_coin_total, received_coin_total, updated_at)
        SELECT $1, $8, 0, $3, 0, $7 WHERE ${guarded}
        ON CONFLICT (user_id) DO UPDATE SET
          sent_pt_total = coin_support_totals.sent_pt_total + EXCLUDED.sent_pt_total,
          sent_coin_total = coin_support_totals.sent_coin_total + EXCLUDED.sent_coin_total,
          updated_at = EXCLUDED.updated_at`,
      params
    },
    {
      text: `INSERT INTO coin_support_totals(user_id, sent_pt_total, received_pt_total, sent_coin_total, received_coin_total, updated_at)
        SELECT $2, 0, $8, 0, $3, $7 WHERE ${guarded}
        ON CONFLICT (user_id) DO UPDATE SET
          received_pt_total = coin_support_totals.received_pt_total + EXCLUDED.received_pt_total,
          received_coin_total = coin_support_totals.received_coin_total + EXCLUDED.received_coin_total,
          updated_at = EXCLUDED.updated_at`,
      params
    },
    {
      text: `UPDATE coin_balances
           SET premium_balance = coin_balances.premium_balance + $3,
               updated_at = $7
         WHERE user_id = $2
           AND $4 = 'PREMIUM'
           AND ${guarded}`,
      params
    },
    {
      text: `INSERT INTO coin_lots(user_id, coin_type, remaining, locked_amount, source_kind, source_ref_id, granted_by_user_id, expires_at, created_at, updated_at)
        SELECT $2, 'PREMIUM', $3, 0, 'SUPPORT', $6, $1, NULL, $7, $7
         WHERE $4 = 'PREMIUM' AND ${guarded}`,
      params
    },
    {
      text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $2, 'PREMIUM', $3, 'GRANT', COALESCE($5, 'coin support received'), $6, $7, NULL
         WHERE $4 = 'PREMIUM' AND ${guarded}`,
      params
    },
    {
      text: `UPDATE coin_balances
           SET ${balanceColumn} = max(coin_balances.${balanceColumn} - $3, 0),
               updated_at = $7
         WHERE user_id = $1
           AND ${guarded}`,
      params
    },
    // 送る人のロットは最後に減らす（ここまでの文は減らす前のロットで計算している）
    {
      text: `UPDATE coin_lots
           SET remaining = coin_lots.remaining - updates.spend,
               updated_at = $7
          FROM (${updatesSql}) AS updates
         WHERE coin_lots.id = updates.id
           AND updates.spend > 0
           AND ${guarded}`,
      params
    },
    { text: `SELECT ${guarded} AS ok` },
    { text: "DELETE FROM d1_guard" }
  ]);
  const transferred = Boolean(results[results.length - 2].rows[0]?.ok);
  const result = transferred
    ? { transferred_amount: amount, sender_pt_added: ptAmount, recipient_pt_added: ptAmount, week_start_date: weekStartDate }
    : null;
  if (!result || result.transferred_amount !== amount || result.sender_pt_added !== ptAmount || result.recipient_pt_added !== ptAmount || result.week_start_date !== weekStartDate) {
    if (props.source) {
      const existingTransfer = await props.db.queryOne(
        `SELECT COALESCE(SUM(coin_amount), 0) AS transferred_amount,
                COALESCE(SUM(pt_amount), 0) AS sender_pt_added,
                COALESCE(SUM(pt_amount), 0) AS recipient_pt_added,
                MIN(week_start_date) AS week_start_date,
                max(is_anonymous) AS is_anonymous
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
      if (existingTransfer && (existingTransfer.transferred_amount ?? 0) > 0 && existingTransfer.transferred_amount === amount && existingTransfer.sender_pt_added === ptAmount && existingTransfer.recipient_pt_added === ptAmount && existingTransfer.week_start_date === weekStartDate && Boolean(existingTransfer.is_anonymous) === isAnonymous) {
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
  const targetSql = `SELECT id, sender_user_id, recipient_user_id, coin_type, coin_amount, pt_amount, week_start_date, source, created_at
          FROM coin_support_transfers
         WHERE sender_user_id = $1
           AND recipient_user_id = $2
           AND source = $3`;
  const freeAmountSql = `(SELECT COALESCE(SUM(coin_amount), 0) FROM (${targetSql}) WHERE coin_type = 'FREE')`;
  const premiumAmountSql = `(SELECT COALESCE(SUM(coin_amount), 0) FROM (${targetSql}) WHERE coin_type = 'PREMIUM')`;
  const params = [props.senderUserId, props.recipientUserId, props.source, now];
  const refundLot = (coinType, amountSql) => ({
    text: `INSERT INTO coin_lots(user_id, coin_type, remaining, locked_amount, source_kind, source_ref_id, granted_by_user_id, expires_at, created_at, updated_at)
        SELECT $1, '${coinType}', ${amountSql}, 0, 'ROLLBACK', $3, $2, NULL, $4, $4
         WHERE ${amountSql} > 0`,
    params
  });
  const refundLedger = (coinType, amountSql) => ({
    text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $1, '${coinType}', ${amountSql}, 'GRANT', 'support rollback refund', $3, $4, NULL
         WHERE ${amountSql} > 0`,
    params
  });
  const weekly = (table, userColumn) => ({
    text: `UPDATE ${table}
           SET coin_amount = max(${table}.coin_amount - src.coin_amount, 0),
               pt_amount = max(${table}.pt_amount - src.pt_amount, 0),
               transfer_count = max(${table}.transfer_count - src.transfer_count, 0),
               updated_at = $4
          FROM (
            SELECT week_start_date, ${userColumn} AS user_id, SUM(coin_amount) AS coin_amount, SUM(pt_amount) AS pt_amount, COUNT(*) AS transfer_count
              FROM (${targetSql})
             GROUP BY week_start_date, ${userColumn}
          ) AS src
         WHERE ${table}.week_start_date = src.week_start_date
           AND ${table}.user_id = src.user_id`,
    params
  });
  const totals = (userColumn, ptColumn, coinColumn) => ({
    text: `UPDATE coin_support_totals
           SET ${ptColumn} = max(coin_support_totals.${ptColumn} - src.pt_amount, 0),
               ${coinColumn} = max(coin_support_totals.${coinColumn} - src.coin_amount, 0),
               updated_at = $4
          FROM (
            SELECT ${userColumn} AS user_id, SUM(coin_amount) AS coin_amount, SUM(pt_amount) AS pt_amount
              FROM (${targetSql})
             GROUP BY ${userColumn}
          ) AS src
         WHERE coin_support_totals.user_id = src.user_id`,
    params
  });
  // 送金の記録（target）を読む文をすべて先に実行し、記録の削除を最後にする（同じトランザクション内）
  const results = await props.db.batch([
    {
      text: `SELECT ${freeAmountSql} AS free_amount, ${premiumAmountSql} AS premium_amount, (SELECT COUNT(*) FROM (${targetSql})) AS target_count`,
      params
    },
    {
      text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at)
        VALUES ($1, 0, 0, $4), ($2, 0, 0, $4)
        ON CONFLICT (user_id) DO NOTHING`,
      params
    },
    {
      text: `UPDATE coin_balances
           SET free_balance = coin_balances.free_balance + ${freeAmountSql},
               premium_balance = coin_balances.premium_balance + ${premiumAmountSql},
               updated_at = $4
         WHERE user_id = $1
           AND EXISTS (${targetSql})`,
      params
    },
    {
      text: `UPDATE coin_balances
           SET premium_balance = max(coin_balances.premium_balance - ${premiumAmountSql}, 0),
               updated_at = $4
         WHERE user_id = $2
           AND ${premiumAmountSql} > 0`,
      params
    },
    refundLot("FREE", freeAmountSql),
    refundLot("PREMIUM", premiumAmountSql),
    refundLedger("FREE", freeAmountSql),
    refundLedger("PREMIUM", premiumAmountSql),
    {
      text: `DELETE FROM coin_lots
         WHERE user_id = $2
           AND coin_type = 'PREMIUM'
           AND source_kind = 'SUPPORT'
           AND source_ref_id = $3`,
      params
    },
    {
      text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
        SELECT $2, 'PREMIUM', -${premiumAmountSql}, 'CONSUME', 'support rollback reversal', $3, $4, NULL
         WHERE ${premiumAmountSql} > 0`,
      params
    },
    weekly("coin_support_weekly_sent_points", "sender_user_id"),
    weekly("coin_support_weekly_received_points", "recipient_user_id"),
    totals("sender_user_id", "sent_pt_total", "sent_coin_total"),
    totals("recipient_user_id", "received_pt_total", "received_coin_total"),
    { text: `DELETE FROM coin_support_transfers WHERE id IN (SELECT id FROM (${targetSql}))`, params }
  ]);
  const result = results[0].rows[0];
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
    await props.db.batch([
      { text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at) VALUES ($1, 0, 0, $3) ON CONFLICT (user_id) DO NOTHING`, params: [props.recipientUserId, amount, now] },
      {
        text: `INSERT INTO coin_lots(user_id, coin_type, remaining, locked_amount, source_kind, source_ref_id, granted_by_user_id, expires_at, created_at, updated_at)
          VALUES ($1, 'PREMIUM', $2, 0, 'SUPPORT', $3, NULL, NULL, $4, $4)`,
        params: [props.recipientUserId, amount, `admin-support-grant-${now}`, now]
      },
      { text: `UPDATE coin_balances SET premium_balance = premium_balance + $2, updated_at = $3 WHERE user_id = $1`, params: [props.recipientUserId, amount, now] },
      {
        text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
          VALUES ($1, 'PREMIUM', $2, 'GRANT', $4, 'admin-support-grant', $3, NULL)`,
        params: [props.recipientUserId, amount, now, reason]
      }
    ]);
  } else {
    await props.db.batch([
      { text: `INSERT INTO coin_balances(user_id, free_balance, premium_balance, updated_at) VALUES ($1, 0, 0, $3) ON CONFLICT (user_id) DO NOTHING`, params: [props.recipientUserId, amount, now] },
      {
        text: `INSERT INTO coin_lots(user_id, coin_type, remaining, locked_amount, source_kind, source_ref_id, granted_by_user_id, expires_at, created_at, updated_at)
          VALUES ($1, 'FREE', $2, 0, 'SUPPORT', $3, NULL, NULL, $4, $4)`,
        params: [props.recipientUserId, amount, `admin-support-grant-${now}`, now]
      },
      { text: `UPDATE coin_balances SET free_balance = free_balance + $2, updated_at = $3 WHERE user_id = $1`, params: [props.recipientUserId, amount, now] },
      {
        text: `INSERT INTO coin_ledger(user_id, coin_type, delta, kind, reason, source, created_at, expires_at)
          VALUES ($1, 'FREE', $2, 'GRANT', $4, 'admin-support-grant', $3, NULL)`,
        params: [props.recipientUserId, amount, now, reason]
      }
    ]);
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
