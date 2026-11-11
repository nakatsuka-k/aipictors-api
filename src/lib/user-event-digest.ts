// ユーザー主催のお題（aipictors-system の user_events）の主催者へ、前日の参加数をまとめて知らせる（毎日 10:00 JST）。
// 参加のたびに通知を書くと D1 の書き込みが増えるので、お題ごとに 1 日 1 件だけ。主催者自身の作品と公式の枠は数えない
import { OFFICIAL_USER_ID } from "./user-model-pickups"

const JST = 9 * 3600

const jstYmd = (sec: number) => new Date((sec + JST) * 1000).toISOString().slice(0, 10)
const wall = (ymd: string) => `${ymd}T00:00:00.000+00:00`

type EventRow = { id: number; user_id: number; title: string; slug: string; main_tag: string }

export const runUserEventDigest = async (system: { core: D1Database; activity: D1Database }, nowSec: number) => {
  const today = jstYmd(nowSec)
  const yesterday = jstYmd(nowSec - 86400)
  const events =
    (
      await system.core
        .prepare(
          `SELECT id, user_id, title, slug, main_tag FROM user_events
            WHERE visibility_type = 'PUBLIC' AND user_id <> ?1
              AND (start_at IS NULL OR start_at < ?3) AND (end_at IS NULL OR end_at >= ?2)
            LIMIT 300`,
        )
        .bind(OFFICIAL_USER_ID, wall(yesterday), wall(today))
        .all<EventRow>()
    ).results ?? []
  if (events.length === 0) return { events: 0, notified: 0 }

  const counts =
    (
      await system.core
        .prepare(
          `SELECT c.category AS tag, w.userId AS user_id, COUNT(DISTINCT w.id) AS n
             FROM categories c JOIN works w ON w.id = c.worksId
            WHERE c.category IN (SELECT value FROM json_each(?1))
              AND w.is_deleted = 0 AND w.adminViewMode = 0 AND w.viewMode IN (0, 1)
              AND w.time >= ?2 AND w.time < ?3
            GROUP BY c.category, w.userId`,
        )
        .bind(JSON.stringify(events.map((e) => e.main_tag)), wall(yesterday), wall(today))
        .all<{ tag: string; user_id: number; n: number }>()
    ).results ?? []

  const notifyTime = `${new Date((nowSec + JST) * 1000).toISOString().slice(0, 23)}+00:00`
  const statements: D1PreparedStatement[] = []
  for (const event of events) {
    const rows = counts.filter((c) => c.tag.toLowerCase() === event.main_tag.toLowerCase() && Number(c.user_id) !== Number(event.user_id))
    const works = rows.reduce((sum, c) => sum + Number(c.n), 0)
    if (works === 0) continue
    const title = event.title.length > 40 ? `${event.title.slice(0, 39)}…` : event.title
    const message = `あなたが主催するお題「${title}」に、昨日 ${rows.length} 人から ${works} 件の参加がありました。/events/${event.slug}`
    statements.push(
      system.activity
        .prepare(
          `INSERT INTO notifications (userId, workId, comment, stampId, ownerUserId, notifyInnerCount, notifyType, notifyTime, commentId)
           VALUES (?1, 0, ?2, -1, -1, 0, 0, ?3, -1)`,
        )
        .bind(Number(event.user_id), message, notifyTime),
    )
  }
  if (statements.length > 0) await system.activity.batch(statements)
  return { events: events.length, notified: statements.length }
}
