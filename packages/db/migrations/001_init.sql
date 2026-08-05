-- auto-x core schema (PostgreSQL 16)

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS x_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  protected BOOLEAN NOT NULL DEFAULT FALSE,
  followers_count INTEGER,
  following_count INTEGER,
  tweet_count INTEGER,
  raw_json JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_x_users_username_lower ON x_users (lower(username));

CREATE TABLE IF NOT EXISTS followers (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  connected_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lost_at TIMESTAMPTZ,
  sync_gen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_followers_sync_gen ON followers(account_id, sync_gen) WHERE lost_at IS NULL;

CREATE TABLE IF NOT EXISTS following (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  connected_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lost_at TIMESTAMPTZ,
  source TEXT,
  pending_follow BOOLEAN NOT NULL DEFAULT FALSE,
  sync_gen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_following_sync_gen ON following(account_id, sync_gen) WHERE lost_at IS NULL;

CREATE TABLE IF NOT EXISTS observations (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'watching',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_obs_due ON observations(status, expires_at);

CREATE TABLE IF NOT EXISTS follow_candidates (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, user_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  target_user_id TEXT,
  source TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  stats_charged BOOLEAN NOT NULL DEFAULT FALSE,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_pair
  ON jobs(account_id, type, target_user_id)
  WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_jobs_claim
  ON jobs(status, next_run_at, priority);
CREATE INDEX IF NOT EXISTS idx_jobs_cooldown
  ON jobs(type, status, target_user_id, finished_at);

CREATE TABLE IF NOT EXISTS sync_cursors (
  account_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  cursor TEXT,
  phase TEXT NOT NULL DEFAULT 'idle',
  walk_gen INTEGER NOT NULL DEFAULT 0,
  last_completed_walk_gen INTEGER NOT NULL DEFAULT 0,
  pages_done INTEGER NOT NULL DEFAULT 0,
  full_sync_completed BOOLEAN NOT NULL DEFAULT FALSE,
  last_full_sync_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, stream)
);

CREATE TABLE IF NOT EXISTS daily_counters (
  account_id TEXT NOT NULL,
  day DATE NOT NULL,
  follows INTEGER NOT NULL DEFAULT 0,
  unfollows INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);

CREATE TABLE IF NOT EXISTS hourly_counters (
  account_id TEXT NOT NULL,
  hour TIMESTAMPTZ NOT NULL,
  follows INTEGER NOT NULL DEFAULT 0,
  unfollows INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, hour)
);

CREATE TABLE IF NOT EXISTS app_config (
  account_id TEXT NOT NULL DEFAULT 'default',
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);

CREATE TABLE IF NOT EXISTS runtime_state (
  account_id TEXT PRIMARY KEY DEFAULT 'default',
  automation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  graph_consistent BOOLEAN NOT NULL DEFAULT FALSE,
  followers_sync_ok BOOLEAN NOT NULL DEFAULT FALSE,
  following_sync_ok BOOLEAN NOT NULL DEFAULT FALSE,
  needs_bootstrap BOOLEAN NOT NULL DEFAULT TRUE,
  last_error TEXT,
  capabilities JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_log (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT,
  level TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_log_created ON event_log(created_at DESC);

INSERT INTO runtime_state (account_id) VALUES ('default') ON CONFLICT DO NOTHING;
