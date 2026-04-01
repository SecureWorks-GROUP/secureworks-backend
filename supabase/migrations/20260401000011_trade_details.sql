-- Trade profile details (bank, licence, GST, business name)
ALTER TABLE users ADD COLUMN IF NOT EXISTS trade_details jsonb;
