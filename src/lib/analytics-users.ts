// @ts-nocheck -- 周りのファイルに合わせて型は付けていない

/**
 * 分析ページ用の利用者の数字（登録・ログイン・投稿やいいねをした人）
 * サイト本体の DB（SYSTEM_CORE）を読むだけ。日別は analytics_daily の users、月別は analytics_monthly に保存する
 *
 * サイト本体の日時は 2 通りある:
 * - wp_users.user_registered は UTC
 * - works.time / favorited_works.favTime / user_login_streaks の日付は日本時間をそのまま書いたもの（末尾は +00:00）
 */

var toNumber = (value) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** "2026-11-05" の n 日後 */
export var addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** "2026-11" の次の月 */
export var nextMonth = (month) => {
  const [year, m] = month.split("-").map(Number);
  return new Date(Date.UTC(year, m, 1)).toISOString().slice(0, 7);
};

/** 日本時間の日付の 00:00 を UTC の文字列に（user_registered と比べる） */
var jstDayStartAsUtcText = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 9 * 3600000).toISOString().slice(0, 19);

var first = async (core, sql, params) => (await core.prepare(sql).bind(...params).first()) ?? {};

var column = async (core, sql, params) => {
  const { results } = await core.prepare(sql).bind(...params).all();
  return (results ?? []).map((row) => toNumber(Object.values(row)[0]));
};

/**
 * 登録者: その期間の新規と、期間の終わりまでの累計（退会した人は除く。過去の日も今の退会の状態で数える）
 * user_registered に索引はないが 20 万行ほどなので全件を 1 回読む
 */
var collectRegistered = async (core, fromDay, toDay) => {
  const row = await first(
    core,
    `SELECT
      count(*) FILTER (WHERE user_registered >= ?1 AND user_registered < ?2) AS new_users,
      count(*) FILTER (WHERE user_registered < ?2 AND is_deleted = 0) AS total
    FROM wp_users`,
    [jstDayStartAsUtcText(fromDay), jstDayStartAsUtcText(toDay)]
  );
  return { new: toNumber(row.new_users), total: toNumber(row.total) };
};

/**
 * 投稿した人・いいねした人（どちらも日時の索引でその期間だけ読む）
 * active はどちらかをした人。見ただけの人は入らないので、ログインした人数（login）より少ない
 */
var collectActivity = async (core, fromDay, toDay) => {
  const range = [`${fromDay}T00:00:00`, `${toDay}T00:00:00`];
  const [posters, likers, counts] = await Promise.all([
    column(core, `SELECT DISTINCT userId FROM works WHERE time >= ?1 AND time < ?2`, range),
    column(core, `SELECT DISTINCT userId FROM favorited_works WHERE favTime >= ?1 AND favTime < ?2 AND userId > 0`, range),
    first(
      core,
      `SELECT
        (SELECT count(*) FROM works WHERE time >= ?1 AND time < ?2) AS posts,
        (SELECT count(*) FROM favorited_works WHERE favTime >= ?1 AND favTime < ?2) AS likes`,
      range
    ),
  ]);
  return {
    active: new Set([...posters, ...likers]).size,
    posters: posters.length,
    likers: likers.length,
    posts: toNumber(counts.posts),
    likes: toNumber(counts.likes),
  };
};

/**
 * ログインした人数（その日・その日までの 7 日・30 日）。サイトを開いた日を 1 人 1 行で持つ user_login_streaks から数える
 * 表には最後に開いた日とその前の日しかないので、その日の翌日のうちに数えたときだけ正しい（それより後は null を返す）
 */
var collectLogin = async (core, day, today) => {
  if (today !== day && today !== addDays(day, 1)) return null;
  const row = await first(
    core,
    `SELECT
      count(*) FILTER (WHERE last = ?1 OR (last > ?1 AND previous = ?1)) AS dau,
      count(*) FILTER (WHERE (last <= ?1 AND last >= ?2) OR (last > ?1 AND previous >= ?2)) AS wau,
      count(*) FILTER (WHERE (last <= ?1 AND last >= ?3) OR (last > ?1 AND previous >= ?3)) AS mau
    FROM (SELECT substr(last_login_date, 1, 10) AS last, substr(previous_login_date, 1, 10) AS previous FROM user_login_streaks)`,
    [day, addDays(day, -6), addDays(day, -29)]
  );
  return { dau: toNumber(row.dau), wau: toNumber(row.wau), mau: toNumber(row.mau) };
};

/** 1 日分。login は翌日を過ぎると数えられないので、そのときは保存済みの値を残す（previous） */
export var collectUsersDay = async (core, day, today, previous) => {
  if (!core) return null;
  const [registered, activity, login] = await Promise.all([
    collectRegistered(core, day, addDays(day, 1)),
    collectActivity(core, day, addDays(day, 1)),
    collectLogin(core, day, today),
  ]);
  return { registered, ...activity, login: login ?? previous?.login ?? null };
};

/** 1 か月分（"2026-11"）を数えて保存する。今月は途中までの数字 */
export var collectUsersMonth = async (core, db, month) => {
  const from = `${month}-01`;
  const to = `${nextMonth(month)}-01`;
  const [registered, activity] = await Promise.all([collectRegistered(core, from, to), collectActivity(core, from, to)]);
  const metrics = { registered, ...activity };
  await db.execute(
    `INSERT INTO analytics_monthly (month, metrics, updated_at) VALUES ($1, $2, $3)
    ON CONFLICT (month) DO UPDATE SET metrics = EXCLUDED.metrics, updated_at = EXCLUDED.updated_at`,
    [month, JSON.stringify(metrics), Math.floor(Date.now() / 1000)]
  );
  return { month, ...metrics };
};

/** 保存済みの月別の数字（古い順） */
export var listUsersMonths = async (db) => {
  const rows = await db.query(`SELECT month, metrics, updated_at FROM analytics_monthly ORDER BY month ASC`, []);
  return rows.map((row) => ({
    month: row.month,
    updatedAt: toNumber(row.updated_at),
    ...(typeof row.metrics === "string" ? JSON.parse(row.metrics) : row.metrics),
  }));
};
