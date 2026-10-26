// @ts-nocheck -- 本番バンドル (aipictors-api 2026-06-20) から復元。型は順次付け直す
import { neon as cs } from "@neondatabase/serverless"
export var schemaStatements = [
  `CREATE TABLE IF NOT EXISTS coin_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    coin_type TEXT NOT NULL,
    delta INTEGER NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT,
    source TEXT,
    created_at BIGINT NOT NULL,
    expires_at BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS coin_balances (
    user_id TEXT PRIMARY KEY,
    free_balance INTEGER NOT NULL DEFAULT 0,
    premium_balance INTEGER NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS coin_lots (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    coin_type TEXT NOT NULL,
    remaining INTEGER NOT NULL,
    locked_amount INTEGER NOT NULL DEFAULT 0,
    source_kind TEXT NOT NULL DEFAULT 'SYSTEM',
    source_ref_id TEXT,
    granted_by_user_id TEXT,
    expires_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS coin_grants (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    grant_key TEXT NOT NULL,
    plan_type TEXT NOT NULL,
    free_coins INTEGER NOT NULL DEFAULT 0,
    premium_coins INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    UNIQUE(user_id, grant_key)
  )`,
  `CREATE TABLE IF NOT EXISTS point_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    delta INTEGER NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT,
    stripe_event_id TEXT,
    stripe_session_id TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS point_balances (
    user_id TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id BIGSERIAL PRIMARY KEY,
    nanoid TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    is_disabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    current_period_start BIGINT NOT NULL,
    current_period_end BIGINT NOT NULL,
    trial_start BIGINT,
    trial_end BIGINT,
    stripe_subscription_id TEXT NOT NULL UNIQUE,
    stripe_latest_invoice_id TEXT,
    stripe_payment_intent_id TEXT,
    stripe_subscription_item_id TEXT,
    stripe_price_id TEXT,
    stripe_product_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS pricing_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    processed_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_debug (
    id BIGSERIAL PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    debug_info TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS coin_support_transfers (
    id BIGSERIAL PRIMARY KEY,
    sender_user_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    coin_type TEXT NOT NULL,
    coin_amount INTEGER NOT NULL,
    pt_amount INTEGER NOT NULL,
    is_anonymous BOOLEAN NOT NULL DEFAULT FALSE,
    source TEXT,
    week_start_date DATE NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS coin_support_request_claims (
    source TEXT PRIMARY KEY,
    sender_user_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    coin_type TEXT NOT NULL,
    coin_amount INTEGER NOT NULL,
    pt_amount INTEGER NOT NULL,
    week_start_date DATE NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS coin_support_weekly_received_points (
    week_start_date DATE NOT NULL,
    user_id TEXT NOT NULL,
    coin_amount INTEGER NOT NULL DEFAULT 0,
    pt_amount BIGINT NOT NULL DEFAULT 0,
    transfer_count INTEGER NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (week_start_date, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS coin_support_weekly_sent_points (
    week_start_date DATE NOT NULL,
    user_id TEXT NOT NULL,
    coin_amount INTEGER NOT NULL DEFAULT 0,
    pt_amount BIGINT NOT NULL DEFAULT 0,
    transfer_count INTEGER NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (week_start_date, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS coin_support_totals (
    user_id TEXT PRIMARY KEY,
    sent_pt_total BIGINT NOT NULL DEFAULT 0,
    received_pt_total BIGINT NOT NULL DEFAULT 0,
    sent_coin_total BIGINT NOT NULL DEFAULT 0,
    received_coin_total BIGINT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS premium_coin_purchases (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    stripe_event_id TEXT UNIQUE,
    stripe_session_id TEXT UNIQUE,
    stripe_payment_intent_id TEXT,
    stripe_charge_id TEXT,
    coins INTEGER NOT NULL,
    bonus_coins INTEGER NOT NULL DEFAULT 0,
    total_coins INTEGER NOT NULL,
    price_yen INTEGER NOT NULL,
    lot_id BIGINT,
    expires_at BIGINT NOT NULL,
    refunded_at BIGINT,
    refund_event_id TEXT UNIQUE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS amazon_exchange_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    package_id TEXT NOT NULL,
    coin_amount INTEGER NOT NULL,
    amazon_point_yen INTEGER NOT NULL,
    status TEXT NOT NULL,
    amazon_gift_code TEXT,
    locked_lot_allocations_json TEXT NOT NULL DEFAULT '[]',
    applied_at BIGINT NOT NULL,
    approved_at BIGINT,
    approved_by_user_id TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_point_ledger_user_created_at
    ON point_ledger(user_id, created_at DESC)`,
  `ALTER TABLE coin_ledger ADD COLUMN IF NOT EXISTS expires_at BIGINT`,
  `ALTER TABLE coin_lots ADD COLUMN IF NOT EXISTS locked_amount INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE coin_lots ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'SYSTEM'`,
  `ALTER TABLE coin_lots ADD COLUMN IF NOT EXISTS source_ref_id TEXT`,
  `ALTER TABLE coin_lots ADD COLUMN IF NOT EXISTS granted_by_user_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_coin_ledger_user_created_at
    ON coin_ledger(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_coin_lots_user_expires_at
    ON coin_lots(user_id, expires_at ASC, id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_coin_lots_user_source_kind
    ON coin_lots(user_id, coin_type, source_kind, expires_at ASC, id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_coin_grants_user_created_at
    ON coin_grants(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_coin_lots_expiring
    ON coin_lots(expires_at) WHERE remaining > 0 AND expires_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS coin_pending_events (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    free_coins INTEGER NOT NULL DEFAULT 0,
    premium_coins INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    delivered_at BIGINT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_coin_pending_events_user_undelivered
    ON coin_pending_events(user_id, id) WHERE delivered_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS coin_job_runs (
    job_key TEXT PRIMARY KEY,
    started_at BIGINT NOT NULL,
    finished_at BIGINT,
    result TEXT
  )`,
  `ALTER TABLE coin_support_transfers ADD COLUMN IF NOT EXISTS source TEXT`,
  `ALTER TABLE coin_support_transfers ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE INDEX IF NOT EXISTS idx_coin_support_transfers_sender_week
    ON coin_support_transfers(sender_user_id, week_start_date DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_coin_support_transfers_recipient_week
    ON coin_support_transfers(recipient_user_id, week_start_date DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_coin_support_transfers_source
    ON coin_support_transfers(source, sender_user_id, recipient_user_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_coin_support_request_claims_sender_recipient
    ON coin_support_request_claims(sender_user_id, recipient_user_id, coin_type, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_coin_support_weekly_received_week_pt
    ON coin_support_weekly_received_points(week_start_date, pt_amount DESC, transfer_count DESC, user_id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_coin_support_weekly_sent_week_pt
    ON coin_support_weekly_sent_points(week_start_date, pt_amount DESC, transfer_count DESC, user_id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_coin_support_totals_sent_pt
    ON coin_support_totals(sent_pt_total DESC, user_id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_coin_support_totals_received_pt
    ON coin_support_totals(received_pt_total DESC, user_id ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_premium_coin_purchases_user_created_at
    ON premium_coin_purchases(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_premium_coin_purchases_payment_intent
    ON premium_coin_purchases(stripe_payment_intent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_amazon_exchange_requests_user_status
    ON amazon_exchange_requests(user_id, status, applied_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_amazon_exchange_requests_status_applied_at
    ON amazon_exchange_requests(status, applied_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_user_active
    ON subscriptions(user_id, is_disabled, current_period_end DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_subscription_id
    ON subscriptions(stripe_subscription_id)`,
  `INSERT INTO pricing_settings(key, value, updated_at) VALUES
    ('points.yen_per_point', '1', EXTRACT(EPOCH FROM NOW())::bigint),
    ('points.package.100.amount_jpy', '100', EXTRACT(EPOCH FROM NOW())::bigint),
    ('points.package.300.amount_jpy', '300', EXTRACT(EPOCH FROM NOW())::bigint),
    ('points.package.1000.amount_jpy', '1000', EXTRACT(EPOCH FROM NOW())::bigint),
    ('subscription.plan.LITE.amount_jpy', '480', EXTRACT(EPOCH FROM NOW())::bigint),
    ('subscription.plan.STANDARD.amount_jpy', '1980', EXTRACT(EPOCH FROM NOW())::bigint),
    ('subscription.plan.PREMIUM.amount_jpy', '3980', EXTRACT(EPOCH FROM NOW())::bigint)
    ON CONFLICT (key) DO NOTHING`
];
export var clients = /* @__PURE__ */ new Map();
export var schemaReady = /* @__PURE__ */ new Map();
export var createClient = (connectionString) => {
  const sql = cs(connectionString);
  return {
    async query(text, params = []) {
      const rows = await sql.query(text, params);
      return rows;
    },
    async queryOne(text, params = []) {
      const rows = await sql.query(text, params);
      return rows[0] ?? null;
    },
    async execute(text, params = []) {
      await sql.query(text, params);
    },
    async executeResult(text, params = []) {
      const result = await sql.query(text, params, { fullResults: true });
      return {
        rowCount: typeof result.rowCount === "number" ? result.rowCount : 0
      };
    },
    // ユーザごとのロックを取ってから 1 文を実行する（同じユーザの付与・失効・消費を直列化する）。
    // READ COMMITTED では文ごとにスナップショットが取られるので、ロック取得後の文は
    // 直前に同じロックを持っていた処理の結果を必ず見る。複数キーはハッシュ順に取るのでデッドロックしない。
    async lockedQuery(lockKeys, text, params = []) {
      const keys = [...new Set(lockKeys.map(String))];
      const [, rows] = await sql.transaction(
        [
          sql.query(
            `SELECT pg_advisory_xact_lock(h)
               FROM (SELECT DISTINCT hashtextextended(k, 0) AS h FROM unnest($1::text[]) AS k ORDER BY h) AS ordered`,
            [keys]
          ),
          sql.query(text, params)
        ],
        { isolationLevel: "ReadCommitted" }
      );
      return rows;
    },
    async lockedQueryOne(lockKeys, text, params = []) {
      const rows = await this.lockedQuery(lockKeys, text, params);
      return rows[0] ?? null;
    }
  };
};
// コイン操作用のロックキー
export var coinLockKey = (userId) => `coins:${userId}`;
// schemaStatements を変えたら上げる。適用済みのバージョンなら DDL を流さない。
// （Worker は isolate が頑繁に入れ替わる。毎回 70 文近い DDL を流すと初回リクエストが 10 秒近くかかり、
//   ALTER TABLE ... IF NOT EXISTS もテーブルロックを取るので混雑時にコインの読み書きが詰まっていた）
export var SCHEMA_VERSION = "2026-10-27.1";
export var ensureSchema = async (cacheKey, db) => {
  let ready = schemaReady.get(cacheKey);
  if (!ready) {
    ready = (async () => {
      try {
        const applied = await db.queryOne(
          "SELECT 1 AS ok FROM api_schema_versions WHERE version = $1",
          [SCHEMA_VERSION]
        );
        if (applied) {
          return;
        }
      } catch {
      }
      for (const statement of schemaStatements) {
        await db.execute(statement);
      }
      await db.execute(
        "CREATE TABLE IF NOT EXISTS api_schema_versions (version TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)"
      );
      await db.execute(
        "INSERT INTO api_schema_versions(version, applied_at) VALUES ($1, EXTRACT(EPOCH FROM NOW())::bigint) ON CONFLICT (version) DO NOTHING",
        [SCHEMA_VERSION]
      );
    })();
    schemaReady.set(cacheKey, ready);
    // 失敗したら次のリクエストでやり直す（失敗した Promise を持ち続けるとその isolate がずっとエラーになる）
    ready.catch(() => schemaReady.delete(cacheKey));
  }
  await ready;
};
export var getDb = async (env) => {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured");
  }
  let client = clients.get(env.DATABASE_URL);
  if (!client) {
    client = createClient(env.DATABASE_URL);
    clients.set(env.DATABASE_URL, client);
  }
  await ensureSchema(env.DATABASE_URL, client);
  return client;
};
export var getNow = () => Math.floor(Date.now() / 1e3);
