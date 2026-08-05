-- Extensible runtime progress (rate limits, sync progress, etc.)
ALTER TABLE runtime_state
  ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;
