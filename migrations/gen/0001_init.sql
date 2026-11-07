-- 自動生成: tools/pg_schema_to_sqlite.py（Neon の pg_dump から）。時刻の列は Neon と同じ文字列のまま（created_at/updated_at は UTC、request_time などは JST）

CREATE TABLE IF NOT EXISTS d1_guard (ok INTEGER NOT NULL CONSTRAINT d1_guard_failed CHECK (ok = 1));

CREATE TABLE IF NOT EXISTS amazon_exchange_requests (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  coin_amount INTEGER NOT NULL,
  amazon_point_yen INTEGER NOT NULL,
  status TEXT NOT NULL,
  amazon_gift_code TEXT,
  locked_lot_allocations_json TEXT DEFAULT '[]' NOT NULL,
  applied_at INTEGER NOT NULL,
  approved_at INTEGER,
  approved_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS analytics_daily (
  day TEXT NOT NULL,
  metrics TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day)
);
CREATE TABLE IF NOT EXISTS coin_balances (
  user_id TEXT NOT NULL,
  free_balance INTEGER DEFAULT 0 NOT NULL,
  premium_balance INTEGER DEFAULT 0 NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id)
);
CREATE TABLE IF NOT EXISTS coin_grants (
  id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  grant_key TEXT NOT NULL,
  plan_type TEXT NOT NULL,
  free_coins INTEGER DEFAULT 0 NOT NULL,
  premium_coins INTEGER DEFAULT 0 NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (user_id, grant_key)
);
CREATE TABLE IF NOT EXISTS coin_job_runs (
  job_key TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  result TEXT,
  PRIMARY KEY (job_key)
);
CREATE TABLE IF NOT EXISTS coin_ledger (
  id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  coin_type TEXT NOT NULL,
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT,
  source TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS coin_lots (
  id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  coin_type TEXT NOT NULL,
  remaining INTEGER NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  locked_amount INTEGER DEFAULT 0 NOT NULL,
  source_kind TEXT DEFAULT 'SYSTEM' NOT NULL,
  source_ref_id TEXT,
  granted_by_user_id TEXT,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS coin_pending_events (
  id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  free_coins INTEGER DEFAULT 0 NOT NULL,
  premium_coins INTEGER DEFAULT 0 NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS coin_support_request_claims (
  source TEXT NOT NULL,
  sender_user_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  coin_type TEXT NOT NULL,
  coin_amount INTEGER NOT NULL,
  pt_amount INTEGER NOT NULL,
  week_start_date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source)
);
CREATE TABLE IF NOT EXISTS coin_support_totals (
  user_id TEXT NOT NULL,
  sent_pt_total INTEGER DEFAULT 0 NOT NULL,
  received_pt_total INTEGER DEFAULT 0 NOT NULL,
  sent_coin_total INTEGER DEFAULT 0 NOT NULL,
  received_coin_total INTEGER DEFAULT 0 NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id)
);
CREATE TABLE IF NOT EXISTS coin_support_transfers (
  id INTEGER NOT NULL,
  sender_user_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  coin_type TEXT NOT NULL,
  coin_amount INTEGER NOT NULL,
  pt_amount INTEGER NOT NULL,
  week_start_date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  source TEXT,
  is_anonymous INTEGER DEFAULT 0 NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS coin_support_weekly_received_points (
  week_start_date TEXT NOT NULL,
  user_id TEXT NOT NULL,
  coin_amount INTEGER DEFAULT 0 NOT NULL,
  pt_amount INTEGER DEFAULT 0 NOT NULL,
  transfer_count INTEGER DEFAULT 0 NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (week_start_date, user_id)
);
CREATE TABLE IF NOT EXISTS coin_support_weekly_sent_points (
  week_start_date TEXT NOT NULL,
  user_id TEXT NOT NULL,
  coin_amount INTEGER DEFAULT 0 NOT NULL,
  pt_amount INTEGER DEFAULT 0 NOT NULL,
  transfer_count INTEGER DEFAULT 0 NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (week_start_date, user_id)
);
CREATE TABLE IF NOT EXISTS discord_expiry_notices (
  user_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, date_key)
);
CREATE TABLE IF NOT EXISTS discord_link_bonuses (
  user_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  free_coins INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id),
  UNIQUE (discord_user_id)
);
CREATE TABLE IF NOT EXISTS discord_links (
  user_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  discord_username TEXT,
  discord_global_name TEXT,
  discord_avatar TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at INTEGER,
  show_nickname INTEGER DEFAULT 1 NOT NULL,
  highlight_key TEXT,
  celebrate INTEGER DEFAULT 0 NOT NULL,
  expiry_dm INTEGER DEFAULT 0 NOT NULL,
  in_guild INTEGER,
  level INTEGER,
  unlocked_count INTEGER,
  is_achievement_visible INTEGER,
  nick_status TEXT,
  last_global_name TEXT,
  aipictors_name TEXT,
  aipictors_login TEXT,
  celebrated_until INTEGER,
  sync_requested_at INTEGER,
  sync_error TEXT,
  synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id),
  UNIQUE (discord_user_id)
);
CREATE TABLE IF NOT EXISTS discord_roles (
  role_key TEXT NOT NULL,
  role_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (role_key)
);
CREATE TABLE IF NOT EXISTS email_campaign_sends (
  campaign TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  resend_id TEXT,
  PRIMARY KEY (campaign, user_id)
);
CREATE TABLE IF NOT EXISTS email_optouts (
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id)
);
CREATE TABLE IF NOT EXISTS point_balances (
  user_id TEXT NOT NULL,
  balance INTEGER DEFAULT 0 NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id)
);
CREATE TABLE IF NOT EXISTS point_ledger (
  id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT,
  stripe_event_id TEXT,
  stripe_session_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS premium_coin_purchases (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  stripe_event_id TEXT,
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_charge_id TEXT,
  coins INTEGER NOT NULL,
  bonus_coins INTEGER DEFAULT 0 NOT NULL,
  total_coins INTEGER NOT NULL,
  price_yen INTEGER NOT NULL,
  lot_id INTEGER,
  expires_at INTEGER NOT NULL,
  refunded_at INTEGER,
  refund_event_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (refund_event_id),
  UNIQUE (stripe_event_id),
  UNIQUE (stripe_session_id)
);
CREATE TABLE IF NOT EXISTS pricing_settings (
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key)
);
CREATE TABLE IF NOT EXISTS subscription_cancel_reasons (
  id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  pass_type TEXT,
  reason TEXT NOT NULL,
  note TEXT,
  months REAL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER NOT NULL,
  nanoid TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  is_disabled INTEGER DEFAULT 0 NOT NULL,
  created_at INTEGER NOT NULL,
  current_period_start INTEGER NOT NULL,
  current_period_end INTEGER NOT NULL,
  trial_start INTEGER,
  trial_end INTEGER,
  stripe_subscription_id TEXT NOT NULL,
  stripe_latest_invoice_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_subscription_item_id TEXT,
  stripe_price_id TEXT,
  stripe_product_id TEXT,
  PRIMARY KEY (id),
  UNIQUE (nanoid),
  UNIQUE (stripe_subscription_id)
);
CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER NOT NULL,
  ticket_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  body TEXT NOT NULL,
  staff_user_id TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  helpful INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT DEFAULT 'ai' NOT NULL,
  category TEXT,
  summary TEXT,
  contact_email TEXT,
  user_name TEXT,
  pass_type TEXT,
  staff_unread INTEGER DEFAULT 0 NOT NULL,
  user_unread INTEGER DEFAULT 0 NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  escalated_at INTEGER,
  resolved_at INTEGER,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS user_model_reports (
  model_id TEXT NOT NULL,
  reporter_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT DEFAULT '' NOT NULL,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (model_id, reporter_user_id)
);
CREATE TABLE IF NOT EXISTS user_models (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '' NOT NULL,
  base_model TEXT DEFAULT 'OTHER' NOT NULL,
  trigger_words TEXT DEFAULT '' NOT NULL,
  recommended_weight REAL DEFAULT 0.8 NOT NULL,
  rating TEXT DEFAULT 'G' NOT NULL,
  tags TEXT DEFAULT '[]' NOT NULL,
  thumbnail_url TEXT,
  sample_image_urls TEXT DEFAULT '[]' NOT NULL,
  original_filename TEXT,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  upload_id TEXT,
  status TEXT NOT NULL,
  disabled_reason TEXT,
  verified_at INTEGER,
  use_count INTEGER DEFAULT 0 NOT NULL,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source_url TEXT,
  source_creator TEXT,
  source_license TEXT,
  source_base_model TEXT,
  import_status TEXT,
  import_parts_done INTEGER DEFAULT 0 NOT NULL,
  import_parts_total INTEGER,
  import_error TEXT,
  recommended_settings TEXT,
  recommended_settings_auto_at INTEGER,
  PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS webhook_debug (
  id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  debug_info TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (event_id)
);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  processed_at INTEGER NOT NULL,
  PRIMARY KEY (event_id)
);
CREATE INDEX IF NOT EXISTS idx_amazon_exchange_requests_status_applied_at ON amazon_exchange_requests (status, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_amazon_exchange_requests_user_status ON amazon_exchange_requests (user_id, status, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_coin_grants_user_created_at ON coin_grants (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_user_created_at ON coin_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coin_lots_expiring ON coin_lots (expires_at) WHERE (remaining > 0) AND (expires_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_coin_lots_user_expires_at ON coin_lots (user_id, expires_at, id);
CREATE INDEX IF NOT EXISTS idx_coin_lots_user_source_kind ON coin_lots (user_id, coin_type, source_kind, expires_at, id);
CREATE INDEX IF NOT EXISTS idx_coin_pending_events_user_undelivered ON coin_pending_events (user_id, id) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_coin_support_request_claims_sender_recipient ON coin_support_request_claims (sender_user_id, recipient_user_id, coin_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coin_support_totals_received_pt ON coin_support_totals (received_pt_total DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_coin_support_totals_sent_pt ON coin_support_totals (sent_pt_total DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_coin_support_transfers_recipient_week ON coin_support_transfers (recipient_user_id, week_start_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_coin_support_transfers_sender_week ON coin_support_transfers (sender_user_id, week_start_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_coin_support_transfers_source ON coin_support_transfers (source, sender_user_id, recipient_user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_coin_support_weekly_received_week_pt ON coin_support_weekly_received_points (week_start_date, pt_amount DESC, transfer_count DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_coin_support_weekly_sent_week_pt ON coin_support_weekly_sent_points (week_start_date, pt_amount DESC, transfer_count DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_discord_links_sync ON discord_links (sync_requested_at, synced_at);
CREATE INDEX IF NOT EXISTS idx_point_ledger_user_created_at ON point_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_premium_coin_purchases_payment_intent ON premium_coin_purchases (stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_premium_coin_purchases_user_created_at ON premium_coin_purchases (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_subscription_id ON subscriptions (stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_active ON subscriptions (user_id, is_disabled, current_period_end DESC);
CREATE INDEX IF NOT EXISTS idx_user_model_reports_open ON user_model_reports (resolved_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_models_sha256 ON user_models (sha256);
CREATE INDEX IF NOT EXISTS idx_user_models_status_created_at ON user_models (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_models_status_kind_use_count ON user_models (status, kind, use_count DESC);
CREATE INDEX IF NOT EXISTS idx_user_models_user_status ON user_models (user_id, status);
CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON support_messages (ticket_id, id);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_user_idx ON support_tickets (user_id, id DESC);
