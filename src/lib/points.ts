// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { getNow } from "./db"
export var getPointSummary = async (db, userId) => {
  const [balance, ledger] = await Promise.all([
  db.queryOne(
    "SELECT balance FROM point_balances WHERE user_id = $1",
    [userId]
  ),
  db.query(
    `SELECT id, delta, kind, reason, stripe_event_id AS "stripeEventId", stripe_session_id AS "stripeSessionId", created_at AS "createdAt"
      FROM point_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 100`,
    [userId]
  )
  ]);
  return {
    balance: balance?.balance ?? 0,
    ledger
  };
};
export var applyPointDelta = async (props) => {
  const now = getNow();
  if (props.delta < 0) {
    const params = [
      props.userId,
      now,
      props.delta,
      Math.abs(props.delta),
      props.kind,
      props.reason ?? null,
      props.stripeEventId ?? null,
      props.stripeSessionId ?? null
    ];
    // 残高が足りたときだけ減らし、その行数（changes()）で台帳を書くか決める（1 つのトランザクション）
    const results = await props.db.batch([
      { text: `INSERT INTO point_balances(user_id, balance, updated_at) VALUES ($1, 0, $2) ON CONFLICT (user_id) DO NOTHING`, params },
      { text: `UPDATE point_balances SET balance = balance + $3, updated_at = $2 WHERE user_id = $1 AND balance >= $4`, params },
      {
        text: `INSERT INTO point_ledger(user_id, delta, kind, reason, stripe_event_id, stripe_session_id, created_at)
          SELECT $1, $3, $5, $6, $7, $8, $2 WHERE changes() = 1`,
        params
      }
    ]);
    const result = { ok: results[1].changes === 1 };
    if (!result?.ok) {
      return { ok: false, code: "INSUFFICIENT_POINTS" };
    }
    return { ok: true };
  }
  const params = [
    props.userId,
    props.delta,
    now,
    props.kind,
    props.reason ?? null,
    props.stripeEventId ?? null,
    props.stripeSessionId ?? null
  ];
  await props.db.batch([
    {
      text: `INSERT INTO point_balances(user_id, balance, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE SET
          balance = point_balances.balance + EXCLUDED.balance,
          updated_at = EXCLUDED.updated_at`,
      params
    },
    {
      text: `INSERT INTO point_ledger(user_id, delta, kind, reason, stripe_event_id, stripe_session_id, created_at)
        VALUES ($1, $2, $4, $5, $6, $7, $3)`,
      params
    }
  ]);
  return { ok: true };
};
