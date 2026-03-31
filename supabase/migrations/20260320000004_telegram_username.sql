-- Add telegram_username column to users table
-- telegram_id already exists (added manually), but telegram_username was missed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username text;

-- Ensure the unique index on telegram_id exists (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id) WHERE telegram_id IS NOT NULL;
