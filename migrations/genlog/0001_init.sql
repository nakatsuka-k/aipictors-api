-- 自動生成: tools/pg_schema_to_sqlite.py（Neon の pg_dump から）。時刻の列は Neon と同じ文字列のまま（created_at/updated_at は UTC、request_time などは JST）

CREATE TABLE IF NOT EXISTS d1_guard (ok INTEGER NOT NULL CONSTRAINT d1_guard_failed CHECK (ok = 1));

CREATE TABLE IF NOT EXISTS generated_queues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  request_content TEXT NOT NULL,
  request_time TEXT NOT NULL,
  image_url TEXT,
  generation_time TEXT,
  progress REAL DEFAULT 0 NOT NULL,
  status TEXT NOT NULL,
  is_deleted INTEGER DEFAULT 0 NOT NULL,
  error TEXT DEFAULT '' NOT NULL,
  ip_address TEXT,
  request_to_sd_time TEXT,
  request_origin_content TEXT DEFAULT '' NOT NULL,
  thumbnail_image_url TEXT DEFAULT '' NOT NULL,
  requester INTEGER,
  priority INTEGER DEFAULT 0 NOT NULL,
  type TEXT DEFAULT 'txt2img' NOT NULL,
  rating INTEGER DEFAULT 0 NOT NULL,
  count INTEGER DEFAULT 1 NOT NULL,
  nanoid TEXT NOT NULL,
  platform TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')) NOT NULL,
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')) NOT NULL,
  is_canceled INTEGER DEFAULT 0 NOT NULL,
  is_reserved INTEGER DEFAULT 0 NOT NULL,
  sd INTEGER DEFAULT 0 NOT NULL,
  is_protected INTEGER DEFAULT 0 NOT NULL,
  cost INTEGER DEFAULT 100 NOT NULL,
  uuid TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS generated_reservation_queues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  request_content TEXT NOT NULL,
  request_origin_content TEXT NOT NULL,
  is_deleted INTEGER DEFAULT 0 NOT NULL,
  ip_address TEXT DEFAULT '' NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')) NOT NULL,
  wait_seconds INTEGER DEFAULT 300 NOT NULL,
  is_generated INTEGER DEFAULT 0 NOT NULL,
  sd INTEGER DEFAULT 0 NOT NULL,
  nanoid TEXT NOT NULL,
  cost INTEGER DEFAULT 100 NOT NULL
);
CREATE TABLE IF NOT EXISTS image_generation_endpoint_leases (
  endpoint_instance_id INTEGER NOT NULL,
  lease_token TEXT NOT NULL,
  current_task_id INTEGER,
  expires_at TEXT NOT NULL,
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')) NOT NULL,
  PRIMARY KEY (endpoint_instance_id)
);
CREATE TABLE IF NOT EXISTS image_generation_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL,
  url TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS image_generation_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  request_content TEXT NOT NULL,
  request_time TEXT NOT NULL,
  image_url TEXT,
  generation_time TEXT,
  status TEXT NOT NULL,
  is_deleted INTEGER DEFAULT 0 NOT NULL,
  ip_address TEXT,
  request_to_sd_time TEXT,
  thumbnail_image_url TEXT DEFAULT '' NOT NULL,
  requester INTEGER,
  priority INTEGER DEFAULT 0 NOT NULL,
  type TEXT DEFAULT 'txt2img' NOT NULL,
  rating INTEGER DEFAULT 0 NOT NULL,
  nanoid TEXT NOT NULL,
  platform TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')) NOT NULL,
  updated_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')) NOT NULL,
  is_canceled INTEGER DEFAULT 0 NOT NULL,
  is_reserved INTEGER DEFAULT 0 NOT NULL,
  sd INTEGER DEFAULT 0 NOT NULL,
  is_protected INTEGER DEFAULT 0 NOT NULL,
  cost INTEGER DEFAULT 100 NOT NULL,
  uuid TEXT NOT NULL,
  model_name TEXT DEFAULT '' NOT NULL,
  prompts TEXT DEFAULT '' NOT NULL,
  UNIQUE (uuid)
);
CREATE INDEX IF NOT EXISTS idx_generated_queues_created_at ON generated_queues (created_at);
CREATE INDEX IF NOT EXISTS idx_generated_queues_deleted_user_id_status_id ON generated_queues (user_id, is_deleted, status, id);
CREATE INDEX IF NOT EXISTS idx_generated_queues_generation_time ON generated_queues (generation_time);
CREATE INDEX IF NOT EXISTS idx_generated_queues_nanoid ON generated_queues (nanoid);
CREATE INDEX IF NOT EXISTS idx_generated_queues_status_id ON generated_queues (status, id);
CREATE INDEX IF NOT EXISTS idx_generated_queues_user_id_generation_time ON generated_queues (user_id, generation_time);
CREATE INDEX IF NOT EXISTS idx_generated_queues_user_id_id ON generated_queues (user_id, id);
CREATE INDEX IF NOT EXISTS idx_generated_queues_user_id_request_time ON generated_queues (user_id, request_time);
CREATE INDEX IF NOT EXISTS idx_generated_queues_uuid ON generated_queues (uuid);
CREATE INDEX IF NOT EXISTS idx_generated_reservation_queues_nanoid ON generated_reservation_queues (nanoid);
CREATE INDEX IF NOT EXISTS idx_generated_reservation_queues_user_id_created_at ON generated_reservation_queues (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_generated_reservation_queues_user_id_deleted_generated ON generated_reservation_queues (user_id, is_deleted, is_generated);
CREATE UNIQUE INDEX IF NOT EXISTS idx_image_generation_endpoints_instance_id ON image_generation_endpoints (instance_id);
CREATE INDEX IF NOT EXISTS idx_image_generation_results_generation_time ON image_generation_results (generation_time);
CREATE INDEX IF NOT EXISTS idx_image_generation_results_nanoid ON image_generation_results (nanoid);
CREATE INDEX IF NOT EXISTS idx_image_generation_results_user_id_request_time ON image_generation_results (user_id, request_time);
CREATE INDEX IF NOT EXISTS idx_image_generation_results_uuid ON image_generation_results (uuid);
