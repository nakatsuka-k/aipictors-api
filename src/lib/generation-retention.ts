// @ts-nocheck
/**
 * 生成画像の保存期間（プランごと）。5 分ごとに少しずつ古い順に見て、期限を過ぎたものを片付ける
 * 期限を過ぎてもすぐには消さず、RETENTION_GRACE_DAYS のあいだ画像を残す（履歴ではグレーにして、プランで戻せると案内する。
 * 期限は今のプランで決まるので、上のプランに入れば戻る）。そのあと R2 の画像だけ消し、履歴の行は生成情報として残す
 * （image_url と thumbnail_image_url を空にする）。利用者が消した行は今まで通り行ごと消す
 * 保護した画像は消さない。プランを確かめられないときは何も消さない
 * フロントの app/routes/($lang).generation._index/utils/generation-retention.ts と同じ値にする
 */

const DAY_SECONDS = 86400;

export const RETENTION_DAYS = { FREE: 90, LITE: 180, STANDARD: 365, PREMIUM: 730 };

/** 期限を過ぎてから画像を消すまで */
export const RETENTION_GRACE_DAYS = 30;

/** 解約などで終わったプランの猶予（すぐに無料の期限にしない） */
const PLAN_GRACE_SECONDS = 30 * DAY_SECONDS;

/** プランごとの期限で消し始める時刻（2027/01/01 00:00 JST）。それまでは利用者が消した分だけ片付ける */
export const RETENTION_ENFORCE_FROM = Date.parse("2026-12-31T15:00:00Z");

/**
 * 1 回（5 分ごと）に見る行の数。画像を消した行も生成情報として残る（行が減らない）ので、1 日に 1 周できる量にする
 * （5,000 行 × 288 回 = 1 日 144 万行。読むのは小さい列だけ）
 */
const BATCH_SIZE = 5000;

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

/** generation_time（日本時間の 'YYYY-MM-DD HH:MM:SS…'）をミリ秒に */
const parseGenerationTime = (value) => Date.parse(`${String(value).slice(0, 19).replace(" ", "T")}+09:00`);

/**
 * 片付け方。"delete" = 行ごと消す（利用者が消したもの）、"clear" = 画像だけ消して生成情報を残す、null = そのまま
 * 消し始める日より前に期限が来るものは、その日を期限にする（そこから猶予を数える）
 */
export const toRetentionAction = ({ row, plan, nowMs, enforce }) => {
  if (row.is_protected) return null;
  if (row.is_deleted) return "delete";
  if (!enforce) return null;
  if (!row.image_url && !row.thumbnail_image_url) return null; // もう画像を消してある
  const generatedAt = parseGenerationTime(row.generation_time);
  if (Number.isNaN(generatedAt)) return null;
  const days = RETENTION_DAYS[plan] ?? RETENTION_DAYS.FREE;
  const expiresAt = Math.max(generatedAt + days * DAY_SECONDS * 1000, RETENTION_ENFORCE_FROM);
  return nowMs >= expiresAt + RETENTION_GRACE_DAYS * DAY_SECONDS * 1000 ? "clear" : null;
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

  // 一番短い期限（と猶予）より新しい行に着いたら、今回の見回りは終わり（古い順に並んでいる）
  const oldestLimit = toSqlTime(nowMs - (RETENTION_DAYS.FREE + RETENTION_GRACE_DAYS) * DAY_SECONDS * 1000);
  const endIndex = rows.findIndex((row) => row.generation_time && row.generation_time >= oldestLimit);
  const finished = endIndex >= 0 || rows.length < BATCH_SIZE;
  const targets = (endIndex >= 0 ? rows.slice(0, endIndex) : rows).filter((row) => row.generation_time);

  const enforce = nowMs >= RETENTION_ENFORCE_FROM;
  const plans = enforce && targets.length > 0
    ? await loadPlans(env.DB, [...new Set(targets.map((row) => row.user_id))], nowSeconds)
    : new Map();
  const actions = targets.map((row) => ({
    row,
    action: toRetentionAction({ row, plan: plans.get(String(row.user_id)), nowMs, enforce }),
  }));
  const deleted = actions.filter((item) => item.action === "delete").map((item) => item.row);
  const cleared = actions.filter((item) => item.action === "clear").map((item) => item.row);
  const expired = [...deleted, ...cleared];

  if (expired.length > 0) {
    const keys = [...new Set(
      expired.flatMap((row) => [toGenerativeFileKey(row.image_url), toGenerativeFileKey(row.thumbnail_image_url)]),
    )].filter((key) => key !== null);
    for (let i = 0; i < keys.length; i += 1000) {
      await env.GENERATIVE_FILES.delete(keys.slice(i, i + 1000));
    }
    const statements = [];
    if (deleted.length > 0) {
      statements.push(
        genlog
          .prepare("DELETE FROM image_generation_results WHERE id IN (SELECT value FROM json_each(?1))")
          .bind(JSON.stringify(deleted.map((row) => row.id))),
        genlog
          .prepare("DELETE FROM generated_queues WHERE nanoid IN (SELECT value FROM json_each(?1))")
          .bind(JSON.stringify(deleted.map((row) => row.nanoid))),
      );
    }
    if (cleared.length > 0) {
      // 生成情報（request_content など）は残し、画像の URL だけ空にする（API は空の URL を「画像なし」として返す）
      statements.push(
        genlog
          .prepare(
            "UPDATE image_generation_results SET image_url = '', thumbnail_image_url = '' WHERE id IN (SELECT value FROM json_each(?1))",
          )
          .bind(JSON.stringify(cleared.map((row) => row.id))),
      );
    }
    await genlog.batch(statements);
  }

  const lastId = rows[rows.length - 1]?.id ?? cursor;
  await genlog
    .prepare(
      `INSERT INTO generation_retention_state (id, cursor_id, next_pass_at) VALUES (1, ?1, ?2)
       ON CONFLICT (id) DO UPDATE SET cursor_id = excluded.cursor_id, next_pass_at = excluded.next_pass_at`,
    )
    .bind(finished ? 0 : lastId, finished ? nowSeconds + DAY_SECONDS : 0)
    .run();
  return { scanned: rows.length, expired: expired.length, deleted: deleted.length, cleared: cleared.length, finished, enforce };
};
