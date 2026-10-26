// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { getNow } from "./db"
export var getPointSummary = async (db, userId) => {
  const balance = await db.queryOne(
    "SELECT balance FROM point_balances WHERE user_id = $1",
    [userId]
  );
  const ledger = await db.query(
    `SELECT id, delta, kind, reason, stripe_event_id AS "stripeEventId", stripe_session_id AS "stripeSessionId", created_at AS "createdAt"
      FROM point_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 100`,
    [userId]
  );
  return {
    balance: balance?.balance ?? 0,
    ledger
  };
};
export var applyPointDelta = async (props) => {
  const now = getNow();
  if (props.delta < 0) {
    const result = await props.db.queryOne(
      `WITH ensured AS (
          INSERT INTO point_balances(user_id, balance, updated_at)
          VALUES ($1, 0, $2)
          ON CONFLICT (user_id) DO NOTHING
        ),
        updated AS (
          UPDATE point_balances
          SET balance = balance + $3, updated_at = $2
          WHERE user_id = $1 AND balance >= $4
          RETURNING user_id
        ),
        ledger_insert AS (
          INSERT INTO point_ledger(user_id, delta, kind, reason, stripe_event_id, stripe_session_id, created_at)
          SELECT $1, $3, $5, $6, $7, $8, $2
          FROM updated
        )
        SELECT EXISTS(SELECT 1 FROM updated) AS ok`,
      [
        props.userId,
        now,
        props.delta,
        Math.abs(props.delta),
        props.kind,
        props.reason ?? null,
        props.stripeEventId ?? null,
        props.stripeSessionId ?? null
      ]
    );
    if (!result?.ok) {
      return { ok: false, code: "INSUFFICIENT_POINTS" };
    }
    return { ok: true };
  }
  await props.db.execute(
    `WITH upserted AS (
        INSERT INTO point_balances(user_id, balance, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE SET
          balance = point_balances.balance + EXCLUDED.balance,
          updated_at = EXCLUDED.updated_at
      )
      INSERT INTO point_ledger(user_id, delta, kind, reason, stripe_event_id, stripe_session_id, created_at)
      VALUES ($1, $2, $4, $5, $6, $7, $3)`,
    [
      props.userId,
      props.delta,
      now,
      props.kind,
      props.reason ?? null,
      props.stripeEventId ?? null,
      props.stripeSessionId ?? null
    ]
  );
  return { ok: true };
};
