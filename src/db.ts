import pg from 'pg';
import type { AppConfig } from './config.js';

const { Pool } = pg;

export type Pool = pg.Pool;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              BIGINT PRIMARY KEY,
  username        VARCHAR(15) NOT NULL,
  name            VARCHAR(50) NOT NULL,
  description     TEXT,
  followers_count INT DEFAULT 0,
  following_count INT DEFAULT 0,
  tweet_count     INT DEFAULT 0,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS relationships (
  source_user_id BIGINT NOT NULL,
  target_user_id BIGINT NOT NULL,
  type           VARCHAR(10) NOT NULL,
  synced_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (source_user_id, target_user_id, type)
);

CREATE TABLE IF NOT EXISTS sync_state (
  user_id          BIGINT PRIMARY KEY,
  followers_cursor VARCHAR(255),
  following_cursor VARCHAR(255),
  last_synced_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships (source_user_id, type);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships (target_user_id, type);
`;

export function createPool(config: AppConfig['db']): pg.Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
  });
}

export async function initSchema(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA);
}
