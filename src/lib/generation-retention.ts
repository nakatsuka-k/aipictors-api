// @ts-nocheck
/**
 * 生成画像の保存期間（プランごと）。5 分ごとに少しずつ古い順に見て、期限を過ぎたものを R2 と履歴から消す
 * 保護した画像は消さない。プランを確かめられないときは何も消さない
 */

const DAY_SECONDS = 86400;

export const RETENTION_DAYS = { FREE: 90, LITE: 180, STANDARD: 365, PREMIUM: 730 };

/** 解約などで終わったプランの猶予（すぐに無料の期限にしない） */
const PLAN_GRACE_SECONDS = 30 * DAY_SECONDS;

/** プランごとの期限で消し始める時刻（2027/01/01 00:00 JST）。それまでは利用者が消した分だけ片付ける */
export const RETENTION_ENFORCE_FROM = Date.parse("2026-12-31T15:00:00Z");

const BATCH_SIZE = 1000;

const FILE_URL = /^https:\/\/generative[-.]files\.aipictors\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.thumbnail)?)(?:\?.*)?$/;

export const toGenerativeFileKey = (url) => FILE_URL.exec(url ?? "")?.[1] ?? null;

const toSqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

const planRank = (type) => Object.keys(RETENTION_DAYS).indexOf(type);

/** 利用者ごとのプラン（有料でない人は入らない） */
const loadPlans = async (db, userIds, nowSeconds) => {
  const { results } = await db
    .prepare(
      `SELECT user_id, type FROM subscriptions
       WHERE user_id IN (SELECT value FROM json_each(?1))
         AND is_disabled = 0 AND current_period_end + ?2 > ?3`,
    )
    .bind(JSON.stringify(userIds.map(String)), PLAN_GRACE_SECONDS, nowSeconds)
    .all();
  const plans = new Map();
  for (const row of results) {
    const current = plans.get(String(row.user_id));
    if (current === undefined || planRank(row.type) > planRank(current)) {
      plans.set(String(row.user_id), row.type);
    }
  }
  return plans;
};

/** 期限を過ぎているか。generation_time は文字列で比べる（'YYYY-MM-DD HH:MM:SS…'） */
export const isExpired = ({ row, plan, nowMs, enforce }) => {
  if (row.is_protected) return false;
  if (row.is_deleted) return true;
  if (!enforce) return false;
  const days = RETENTION_DAYS[plan] ?? RETENTION_DAYS.FREE;
  return row.generation_time < toSqlTime(nowMs - days * DAY_SECONDS * 1000);
};

export const runGenerationRetention = async (env, nowMs = Date.now()) => {
  if (!env.GENLOG || !env.DB || !env.GENERATIVE_FILES) return null;
  const genlog = env.GENLOG;
  const nowSeconds = Math.floor(nowMs / 1000);
  const state = await genlog
    .prepare("SELECT cursor_id, next_pass_at FROM generation_retention_state WHERE id = 1")
    .first();
  if (state && state.next_pass_at > nowSeconds) return null;
  const cursor = state?.cursor_id ?? 0;

  const { results: rows } = await genlog
    .prepare(
      `SELECT id, nanoid, user_id, image_url, thumbnail_image_url, generation_time, is_deleted, is_protected
       FROM image_generation_results WHERE id > ?1 ORDER BY id LIMIT ?2`,
    )
    .bind(cursor, BATCH_SIZE)
    .all();

  // 一番短い期限より新しい行に着いたら、今回の見回りは終わり（古い順に並んでいる）
  const oldestLimit = toSqlTime(nowMs - RETENTION_DAYS.FREE * DAY_SECONDS * 1000);
  const endIndex = rows.findIndex((row) => row.generation_time && row.generation_time >= oldestLimit);
  const finished = endIndex >= 0 || rows.length < BATCH_SIZE;
  const targets = (endIndex >= 0 ? rows.slice(0, endIndex) : rows).filter((row) => row.generation_time);

  const enforce = nowMs >= RETENTION_ENFORCE_FROM;
  const plans = enforce && targets.length > 0
    ? await loadPlans(env.DB, [...new Set(targets.map((row) => row.user_id))], nowSeconds)
    : new Map();
  const expired = targets.filter((row) =>
    isExpired({ row, plan: plans.get(String(row.user_id)), nowMs, enforce }),
  );

  if (expired.length > 0) {
    const keys = [...new Set(
      expired.flatMap((row) => [toGenerativeFileKey(row.image_url), toGenerativeFileKey(row.thumbnail_image_url)]),
    )].filter((key) => key !== null);
    for (let i = 0; i < keys.length; i += 1000) {
      await env.GENERATIVE_FILES.delete(keys.slice(i, i + 1000));
    }
    await genlog.batch([
      genlog
        .prepare("DELETE FROM image_generation_results WHERE id IN (SELECT value FROM json_each(?1))")
        .bind(JSON.stringify(expired.map((row) => row.id))),
      genlog
        .prepare("DELETE FROM generated_queues WHERE nanoid IN (SELECT value FROM json_each(?1))")
        .bind(JSON.stringify(expired.map((row) => row.nanoid))),
    ]);
  }

  const lastId = rows[rows.length - 1]?.id ?? cursor;
  await genlog
    .prepare(
      `INSERT INTO generation_retention_state (id, cursor_id, next_pass_at) VALUES (1, ?1, ?2)
       ON CONFLICT (id) DO UPDATE SET cursor_id = excluded.cursor_id, next_pass_at = excluded.next_pass_at`,
    )
    .bind(finished ? 0 : lastId, finished ? nowSeconds + DAY_SECONDS : 0)
    .run();
  return { scanned: rows.length, expired: expired.length, finished, enforce };
};
