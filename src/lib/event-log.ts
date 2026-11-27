// @ts-nocheck -- 周りのファイルに合わせて型は付けていない
// 操作の記録の日別のまとめ。
// フロント（aipictors の app/utils/event-log.ts）が POST /api/ev にまとめて送ったイベントは、
// フロントの Worker が Workers Analytics Engine のデータセット aipictors_events に 1 イベント 1 行で書く（生は 90 日で消える）。
// 毎日 00:30 JST に前日分を SQL API で読み、日別・イベント別・ページ別・ファネル別のまとめを D1（migrations/gen/0030）に、
// 生のイベントを R2（バケット aipictors-analytics の events/YYYY/MM/DD.ndjson.gz）に保存する（どちらも期限なし）
import { jstDayBefore, toJstDayRange } from "./analytics"

var ACCOUNT_ID = "7f2a200bf2994f36f45e733751a30be6";
export var EVENT_DATASET = "aipictors_events";

/** Analytics Engine の blob1〜15 の名前（フロントの app/lib/event-log-server.ts と同じ順） */
export var EVENT_COLUMNS = [
  "event",
  "source",
  "page",
  "path",
  "referrer",
  "sid",
  "user",
  "auth",
  "device",
  "os",
  "lang",
  "country",
  "traffic",
  "extra",
  "visit",
];

var UPSELL_VIEW =
  /^(shortage_view|plan_gate_view_.*|model_limit_view|gen_wait_view|gen_done_view|trial_view|upsell_view|lite_day_view|lite_day_followup_view|standard_upgrade_offer_view|member_guide_view|ending_view|plus_view|plus_nav_view)$/;
var UPSELL_CLICK =
  /^(shortage_plans|shortage_coins|plan_gate_plans|model_limit_plans|trial_click|upsell_click|gen_wait_click|gen_done_click|lite_day_click|lowcoin_click|plus_nav_click|member_upsell_click_.*|ending_plans|ending_click|plus_persona_cta|standard_upgrade_offer_click)$/;
var CHECKOUT =
  /^(begin_checkout|trial_checkout|prepaid_checkout_.*|shortage_checkout_.*|member_extra_coins_checkout|lite_day_followup_checkout|lite_day_start)$/;
var PAID = /^(purchase|trial_started)$/;

var is = (name) => (e) => e.event === name;
var view = (page) => (e) => e.event === "page_view" && e.page === page;
var match = (pattern) => (e) => pattern.test(e.event);

/**
 * ファネル: その日のセッションのうち、段階を順に（あいだに他の操作があってもよい）進んだ数を数える。
 * 段階を変えたら過去の日は集め直す（POST /internal/analytics/events/rollup、生が残っている 90 日まで）
 */
export var FUNNELS = {
  // 生成画面 → 生成 → 課金の案内を見た → 案内を押した → 決済を始めた → 課金・お試し開始
  generate_to_paid: [
    ["generation_view", view("generation")],
    ["generate", is("generate_success")],
    ["upsell_view", match(UPSELL_VIEW)],
    ["upsell_click", match(UPSELL_CLICK)],
    ["checkout", match(CHECKOUT)],
    ["paid", match(PAID)],
  ],
  // コイン不足の案内 → プラン・コイン・お試しを押した → 決済を始めた → 課金
  coin_shortage: [
    ["shortage_view", is("shortage_view")],
    ["shortage_click", match(/^(shortage_plans|shortage_coins|trial_click|lite_day_click|lite_day_start)$/)],
    ["checkout", match(CHECKOUT)],
    ["paid", match(PAID)],
  ],
  // 課金の案内（どこでも）→ 押した → 決済 → 課金
  upsell: [
    ["upsell_view", match(UPSELL_VIEW)],
    ["upsell_click", match(UPSELL_CLICK)],
    ["checkout", match(CHECKOUT)],
    ["paid", match(PAID)],
  ],
  // プランのページ → 決済 → 課金
  plus_page: [
    ["plus_view", view("plus")],
    ["checkout", match(CHECKOUT)],
    ["paid", match(PAID)],
  ],
  // 来た → 生成画面 → 生成した
  visit_to_generate: [
    ["visit", is("page_view")],
    ["generation_view", view("generation")],
    ["generate", is("generate_success")],
  ],
  // 来た → 登録 → 生成 → 投稿
  signup: [
    ["visit", is("page_view")],
    ["sign_up", is("sign_up")],
    ["generate", is("generate_success")],
    ["post", is("post_complete")],
  ],
  // 投稿画面 → 投稿した
  post: [
    ["post_form_view", (e) => e.event === "page_view" && /^(\/en)?\/new(\/|$)/.test(e.path)],
    ["post", is("post_complete")],
  ],
};

/**
 * 流入元ごとのサブスク加入までの到達（event_source_funnel_daily）。
 * セッションの流入元（最初のページ表示の referrer）× 端末ごとに、どの段階まで進んだかを数える。
 * 順番は問わず「いちばん先まで進んだ段階」を取り、それより前の段階も通ったものとする
 * （プランのページに直接来て加入した人も、案内を見た・押したに数える）。コインの購入はサブスクに数えない
 */
var COIN_CHECKOUT = /^(member_extra_coins_checkout)$/;
var isPlanCheckout = (e) => match(CHECKOUT)(e) && !COIN_CHECKOUT.test(e.event) && e.item !== "coins";
/** サブスク加入の内訳: 有料プラン（月額・年額）・前払いパス・無料お試しの開始 */
var subscriptionKind = (e) => {
  if (e.event === "trial_started") return "trial";
  if (e.event !== "purchase") return null;
  if (e.item === "pass") return "pass";
  if (e.item === "prepaid_pass") return "prepaid";
  return null;
};
export var SOURCE_FUNNEL_STEPS = ["visit", "explore", "upsell_view", "plan", "checkout", "subscribe"];
export var SOURCE_FUNNEL_KINDS = { pass: 91, prepaid: 92, trial: 93 };
/** 画面に出ただけの表示（サイドバーのプランのリンク・広告枠など）。回遊・案内を見たには数えない */
var isImpression = (e) => e.event !== "page_view" && e.event.endsWith("_view");
/** サイドバー・メニューのプランへのリンクはほぼ全ページに出ているので、案内を見たに数えない */
var PASSIVE_UPSELL_VIEW = /^plus_nav_view$/;
var sourceDepth = (e, index) => {
  if (subscriptionKind(e)) return 6;
  if (isPlanCheckout(e)) return 5;
  if (match(UPSELL_CLICK)(e) || view("plus")(e)) return 4;
  if (match(UPSELL_VIEW)(e) && !PASSIVE_UPSELL_VIEW.test(e.event)) return 3;
  if (index > 0 && !isImpression(e)) return 2;
  return e.event === "page_view" ? 1 : 0;
};
/** セッションの流入元。サイト内の移動から始まったセッション（30 分空いて切り替わったなど）は internal */
var sessionSource = (views) => {
  if (views.length === 0) return "unknown";
  const referrer = views[0].referrer || "direct";
  return referrer.startsWith("nav:") ? "internal" : referrer;
};

/** Analytics Engine の SQL API（読み取りの権限があるトークン） */
var queryEvents = async (token, sql) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: sql,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`analytics engine ${response.status}: ${text.slice(0, 200)}`);
  return text;
};

var toSqlTime = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ");

var WINDOW_LIMIT = 50000;

/** start〜end（UNIX 秒）の生のイベント（JSONEachRow の文字列）を onText に渡す。多すぎたら時間を半分に分けて読む */
var readWindow = async (token, start, end, onText) => {
  const columns = EVENT_COLUMNS.map((name, i) => `blob${i + 1} AS ${name}`).join(", ");
  const text = await queryEvents(
    token,
    `SELECT toUnixTimestamp(timestamp) AS ts, ${columns}, double1 AS value, double2 AS client_ms, _sample_interval AS weight
    FROM ${EVENT_DATASET}
    WHERE timestamp >= toDateTime('${toSqlTime(start)}') AND timestamp < toDateTime('${toSqlTime(end)}')
    ORDER BY ts
    LIMIT ${WINDOW_LIMIT}
    FORMAT JSONEachRow`
  );
  let count = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count += 1;
  if (!text.endsWith("\n") && text.trim() !== "") count += 1;
  if (count >= WINDOW_LIMIT && end - start > 60) {
    const middle = start + Math.floor((end - start) / 2);
    await readWindow(token, start, middle, onText);
    await readWindow(token, middle, end, onText);
    return;
  }
  if (text.trim() !== "") await onText(text.endsWith("\n") ? text : `${text}\n`);
};

/** その日（日本時間）の生のイベントを 1 時間ずつ読み、文字列のまま onText に渡す */
export var readEventDay = async (token, day, onText) => {
  const { start, end } = toJstDayRange(day);
  for (let t = start; t < end; t += 3600) await readWindow(token, t, t + 3600, onText);
};

var toNumber = (value) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 生のイベントを 1 行ずつ受け取ってまとめる。
 * 1 日 数十万行になるので、まとめに使う列だけを、同じ文字列は 1 つにして持つ（Worker のメモリは 128MB）
 */
/** extra（JSON）の item（purchase・begin_checkout の pass / prepaid_pass / coins）だけを取り出す */
var itemOf = (extra) => {
  if (typeof extra !== "string" || !extra.includes('"item"')) return "";
  const found = /"item":"([a-z_]{1,32})"/.exec(extra);
  return found ? found[1] : "";
};

export var createEventSummarizer = () => {
  const sessions = new Map();
  const strings = new Map();
  const intern = (value) => {
    const text = typeof value === "string" ? value : "";
    const known = strings.get(text);
    if (known !== undefined) return known;
    strings.set(text, text);
    return text;
  };
  let dcEvents = 0;
  let anonymous = 0;
  const add = (raw) => {
    if (raw.traffic === "dc") {
      dcEvents += 1;
      return;
    }
    const sid = raw.sid ? intern(raw.sid) : `_${(anonymous += 1)}`;
    const row = {
      order: toNumber(raw.client_ms) || toNumber(raw.ts) * 1000,
      weight: Math.max(1, toNumber(raw.weight)),
      event: intern(raw.event),
      source: intern(raw.source),
      page: intern(raw.page),
      path: intern(raw.path),
      referrer: intern(raw.referrer),
      user: intern(raw.user),
      auth: intern(raw.auth),
      device: intern(raw.device),
      item: intern(itemOf(raw.extra)),
    };
    let session = sessions.get(sid);
    if (!session) {
      session = { sid, events: [], user: "", device: row.device };
      sessions.set(sid, session);
    }
    session.events.push(row);
    if (row.user) session.user = row.user;
  };
  return { add, finish: () => finishSummary(sessions, dcEvents) };
};

/** 生のイベント（行の配列）→ まとめ（テストで直接呼ぶ） */
export var summarizeEvents = (rows) => {
  const summarizer = createEventSummarizer();
  for (const row of rows) summarizer.add(row);
  return summarizer.finish();
};

var finishSummary = (sessions, dcEvents) => {
  const allUsers = new Set();
  const eventKeys = new Map();
  const pages = new Map();
  const paths = new Map();
  const entries = new Map();
  const sources = new Map();
  const funnels = Object.fromEntries(
    Object.entries(FUNNELS).map(([name, steps]) => [name, steps.map(() => ({ sessions: 0, users: new Set() }))])
  );
  let events = 0;

  const bump = (map, key, init) => {
    let value = map.get(key);
    if (!value) {
      value = init();
      map.set(key, value);
    }
    return value;
  };

  for (const session of sessions.values()) {
    session.events.sort((a, b) => a.order - b.order);
    if (session.user) allUsers.add(session.user);
    const views = [];
    for (const e of session.events) {
      events += e.weight;
      const key = [e.event, e.source ?? "", e.page ?? "", e.device ?? "", e.auth ?? ""].join("\u0001");
      const item = bump(eventKeys, key, () => ({ events: 0, sessions: new Set(), users: new Set() }));
      item.events += e.weight;
      item.sessions.add(session.sid);
      if (e.user || session.user) item.users.add(e.user || session.user);
      if (e.event === "page_view") views.push(e);
    }
    if (views.length > 0) {
      const first = views[0];
      const last = views[views.length - 1];
      const bounce = views.length === 1;
      for (const v of views) {
        const page = bump(pages, v.page, () => ({ views: 0, sessions: new Set(), entries: 0, exits: 0, bounces: 0 }));
        page.views += v.weight;
        page.sessions.add(session.sid);
        const path = bump(paths, v.path, () => ({ views: 0, sessions: new Set(), exits: 0 }));
        path.views += v.weight;
        path.sessions.add(session.sid);
      }
      pages.get(first.page).entries += 1;
      pages.get(last.page).exits += 1;
      paths.get(last.path).exits += 1;
      if (bounce) pages.get(first.page).bounces += 1;
      const entry = bump(entries, [first.referrer || "", first.page, session.device].join("\u0001"), () => ({ sessions: 0, bounces: 0 }));
      entry.sessions += 1;
      if (bounce) entry.bounces += 1;
    }
    let depth = 0;
    const kinds = new Set();
    session.events.forEach((e, index) => {
      depth = Math.max(depth, sourceDepth(e, index));
      const kind = subscriptionKind(e);
      if (kind) kinds.add(kind);
    });
    if (depth > 0) {
      const sourceKey = [sessionSource(views), session.device || ""].join("\u0001");
      const steps = bump(sources, sourceKey, () => ({
        steps: SOURCE_FUNNEL_STEPS.map(() => ({ sessions: 0, users: new Set() })),
        kinds: Object.fromEntries(Object.keys(SOURCE_FUNNEL_KINDS).map((kind) => [kind, { sessions: 0, users: new Set() }])),
      }));
      for (let i = 0; i < depth; i++) {
        steps.steps[i].sessions += 1;
        if (session.user) steps.steps[i].users.add(session.user);
      }
      for (const kind of kinds) {
        steps.kinds[kind].sessions += 1;
        if (session.user) steps.kinds[kind].users.add(session.user);
      }
    }
    for (const [name, steps] of Object.entries(FUNNELS)) {
      let reached = 0;
      for (const e of session.events) {
        if (reached < steps.length && steps[reached][1](e)) reached += 1;
        if (reached === steps.length) break;
      }
      for (let i = 0; i < reached; i++) {
        funnels[name][i].sessions += 1;
        if (session.user) funnels[name][i].users.add(session.user);
      }
    }
  }

  return {
    totals: { events, dcEvents, sessions: sessions.size, users: allUsers.size },
    events: [...eventKeys.entries()].map(([key, v]) => {
      const [event, source, page, device, auth] = key.split("\u0001");
      return { event, source, page, device, auth, events: v.events, sessions: v.sessions.size, users: v.users.size };
    }),
    pages: [...pages.entries()].map(([page, v]) => ({
      page,
      views: v.views,
      sessions: v.sessions.size,
      entries: v.entries,
      exits: v.exits,
      bounces: v.bounces,
    })),
    paths: [...paths.entries()]
      .map(([path, v]) => ({ path, views: v.views, sessions: v.sessions.size, exits: v.exits }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 500),
    entries: [...entries.entries()].map(([key, v]) => {
      const [referrer, page, device] = key.split("\u0001");
      return { referrer, page, device, sessions: v.sessions, bounces: v.bounces };
    }),
    sources: [...sources.entries()].flatMap(([key, value]) => {
      const [referrer, device] = key.split("\u0001");
      return [
        ...value.steps.map((step, i) => ({
          referrer,
          device,
          step: i + 1,
          stepName: SOURCE_FUNNEL_STEPS[i],
          sessions: step.sessions,
          users: step.users.size,
        })),
        ...Object.entries(SOURCE_FUNNEL_KINDS)
          .filter(([kind]) => value.kinds[kind].sessions > 0)
          .map(([kind, step]) => ({
            referrer,
            device,
            step,
            stepName: kind,
            sessions: value.kinds[kind].sessions,
            users: value.kinds[kind].users.size,
          })),
      ];
    }),
    funnels: Object.entries(funnels).flatMap(([funnel, steps]) =>
      steps.map((step, i) => ({ funnel, step: i + 1, stepName: FUNNELS[funnel][i][0], sessions: step.sessions, users: step.users.size }))
    ),
  };
};

/** 何行かずつ 1 つの INSERT にまとめる（D1 は 1 文の引数が 100 まで） */
var insertStatements = (table, columns, rows) => {
  const perStatement = Math.max(1, Math.floor(100 / columns.length));
  const statements = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    const params = [];
    const values = chunk.map((row) => {
      const holders = columns.map((column) => {
        params.push(row[column]);
        return `$${params.length}`;
      });
      return `(${holders.join(", ")})`;
    });
    statements.push({ text: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values.join(", ")}`, params });
  }
  return statements;
};

/** まとめを D1 に書く（その日の分を消してから入れ直す） */
export var saveEventSummary = async (db, day, summary, archiveKey) => {
  const withDay = (rows) => rows.map((row) => ({ ...row, day }));
  const statements = [
    ...[
      "event_daily",
      "event_page_daily",
      "event_path_daily",
      "event_funnel_daily",
      "event_entry_daily",
      "event_source_funnel_daily",
    ].map((table) => ({
      text: `DELETE FROM ${table} WHERE day = $1`,
      params: [day],
    })),
    ...insertStatements(
      "event_daily",
      ["day", "event", "source", "page", "device", "auth", "events", "sessions", "users"],
      withDay(summary.events)
    ),
    ...insertStatements("event_page_daily", ["day", "page", "views", "sessions", "entries", "exits", "bounces"], withDay(summary.pages)),
    ...insertStatements("event_path_daily", ["day", "path", "views", "sessions", "exits"], withDay(summary.paths)),
    ...insertStatements(
      "event_funnel_daily",
      ["day", "funnel", "step", "step_name", "sessions", "users"],
      withDay(summary.funnels.map((row) => ({ ...row, step_name: row.stepName })))
    ),
    ...insertStatements("event_entry_daily", ["day", "referrer", "page", "device", "sessions", "bounces"], withDay(summary.entries)),
    ...insertStatements(
      "event_source_funnel_daily",
      ["day", "referrer", "device", "step", "step_name", "sessions", "users"],
      withDay((summary.sources ?? []).map((row) => ({ ...row, step_name: row.stepName })))
    ),
    {
      text: `INSERT INTO event_rollup_runs (day, events, dc_events, sessions, users, archive_key, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (day) DO UPDATE SET events = EXCLUDED.events, dc_events = EXCLUDED.dc_events, sessions = EXCLUDED.sessions,
        users = EXCLUDED.users, archive_key = EXCLUDED.archive_key, updated_at = EXCLUDED.updated_at`,
      params: [
        day,
        summary.totals.events,
        summary.totals.dcEvents,
        summary.totals.sessions,
        summary.totals.users,
        archiveKey,
        Math.floor(Date.now() / 1000),
      ],
    },
  ];
  // 1 回の batch は 1 つのトランザクション。消してから入れるまでを分けないよう、文が多い日も 1 回で流す
  await db.batch(statements);
  return statements.length;
};

/** 生のイベントを gzip の NDJSON にする（読んだ文字列を順に書き足す）。R2 には 1 日 1 ファイル */
var createArchive = () => {
  const compression = new CompressionStream("gzip");
  const writer = compression.writable.getWriter();
  const output = new Response(compression.readable).arrayBuffer();
  const encoder = new TextEncoder();
  return {
    write: (text) => writer.write(encoder.encode(text)),
    finish: async () => {
      await writer.close();
      return output;
    },
  };
};

export var archiveKeyOf = (day) => `events/${day.slice(0, 4)}/${day.slice(5, 7)}/${day.slice(8, 10)}.ndjson.gz`;

var eventsToken = (env) => env.CF_EVENTS_TOKEN || env.CF_ANALYTICS_TOKEN || env.CF_BILLING_TOKEN || null;

/** 1 日分を読み、R2 に残し、まとめを D1 に書く */
export var rollupEventDay = async (env, db, day) => {
  const token = eventsToken(env);
  if (!token) throw new Error("no token for analytics engine (CF_EVENTS_TOKEN)");
  const summarizer = createEventSummarizer();
  const archive = createArchive();
  let rows = 0;
  await readEventDay(token, day, async (text) => {
    await archive.write(text);
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      summarizer.add(JSON.parse(line));
      rows += 1;
    }
  });
  const body = await archive.finish();
  // 生が消えた日（90 日より前）や読めなかった日に、保存済みのまとめを空で上書きしない
  if (rows === 0) return { day, rows, skipped: "no rows" };
  let archiveKey = null;
  if (env.EVENT_ARCHIVE) {
    archiveKey = archiveKeyOf(day);
    await env.EVENT_ARCHIVE.put(archiveKey, body, {
      httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
      customMetadata: { rows: String(rows) },
    });
  }
  const summary = summarizer.finish();
  const statements = await saveEventSummary(db, day, summary, archiveKey);
  return { day, rows, archiveKey, archiveBytes: body.byteLength, statements, totals: summary.totals };
};

/** 前日分（00:30 JST の cron から） */
export var rollupYesterdayEvents = async (env, db, nowSeconds) => rollupEventDay(env, db, jstDayBefore(nowSeconds, 1));

/** 保存済みのまとめを読む（/internal/analytics/events） */
export var listEventSummary = async (db, { from, to, kind, event }) => {
  const range = [from, to];
  if (kind === "funnels") {
    return db.query(
      `SELECT day, funnel, step, step_name, sessions, users FROM event_funnel_daily WHERE day BETWEEN $1 AND $2 ORDER BY day, funnel, step`,
      range
    );
  }
  if (kind === "pages") {
    return db.query(
      `SELECT day, page, views, sessions, entries, exits, bounces FROM event_page_daily WHERE day BETWEEN $1 AND $2 ORDER BY day, views DESC`,
      range
    );
  }
  if (kind === "paths") {
    return db.query(
      `SELECT day, path, views, sessions, exits FROM event_path_daily WHERE day BETWEEN $1 AND $2 ORDER BY day, views DESC`,
      range
    );
  }
  if (kind === "entries") {
    return db.query(
      `SELECT day, referrer, page, device, sessions, bounces FROM event_entry_daily WHERE day BETWEEN $1 AND $2 ORDER BY day, sessions DESC`,
      range
    );
  }
  if (kind === "sources") {
    return db.query(
      `SELECT referrer, device, step, step_name, SUM(sessions) AS sessions, SUM(users) AS users, COUNT(DISTINCT day) AS days
      FROM event_source_funnel_daily WHERE day BETWEEN $1 AND $2 GROUP BY referrer, device, step, step_name ORDER BY referrer, device, step`,
      range
    );
  }
  if (kind === "runs") {
    return db.query(`SELECT * FROM event_rollup_runs WHERE day BETWEEN $1 AND $2 ORDER BY day`, range);
  }
  // events: 端末・ログイン中かを足し合わせた日 × イベント × 出どころ × ページ（event は前方一致）
  return db.query(
    `SELECT day, event, source, page, SUM(events) AS events, SUM(sessions) AS sessions, SUM(users) AS users
    FROM event_daily WHERE day BETWEEN $1 AND $2 AND event LIKE $3
    GROUP BY day, event, source, page ORDER BY day, events DESC`,
    [from, to, `${event ?? ""}%`]
  );
};
