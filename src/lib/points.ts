import { getNow } from '@/lib/d1'

export const getPointSummary = async (db: D1Database, userId: string) => {
  const balance = await db
    .prepare('SELECT balance FROM point_balances WHERE user_id = ?')
    .bind(userId)
    .first<{ balance: number }>()

  const ledger = await db
    .prepare(`SELECT id, delta, kind, reason, stripe_event_id as stripeEventId, stripe_session_id as stripeSessionId, created_at as createdAt
      FROM point_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100`)
    .bind(userId)
    .all<Record<string, unknown>>()

  return {
    balance: balance?.balance ?? 0,
    ledger: ledger.results ?? []
  }
}

export const applyPointDelta = async (props: {
  db: D1Database
  userId: string
  delta: number
  kind: string
  reason?: string | null
  stripeEventId?: string | null
  stripeSessionId?: string | null
}) => {
  const now = getNow()

  await props.db
    .prepare(`INSERT INTO point_balances(user_id, balance, updated_at)
      VALUES (?, 0, ?)
      ON CONFLICT(user_id) DO NOTHING`)
    .bind(props.userId, now)
    .run()

  if (props.delta < 0) {
    const result = await props.db
      .prepare(`UPDATE point_balances
        SET balance = balance + ?, updated_at = ?
        WHERE user_id = ? AND balance >= ?`)
      .bind(props.delta, now, props.userId, Math.abs(props.delta))
      .run()

    if ((result.meta.changes ?? 0) === 0) {
      return { ok: false as const, code: 'INSUFFICIENT_POINTS' as const }
    }
  } else {
    await props.db
      .prepare('UPDATE point_balances SET balance = balance + ?, updated_at = ? WHERE user_id = ?')
      .bind(props.delta, now, props.userId)
      .run()
  }

  await props.db
    .prepare(`INSERT INTO point_ledger(user_id, delta, kind, reason, stripe_event_id, stripe_session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      props.userId,
      props.delta,
      props.kind,
      props.reason ?? null,
      props.stripeEventId ?? null,
      props.stripeSessionId ?? null,
      now,
    )
    .run()

  return { ok: true as const }
}
