-- Add invoice_type column to users table
-- Values: 'hourly' (default) or 'per_metre'
-- Henry (emeka.henry) is per_metre, everyone else hourly

ALTER TABLE users ADD COLUMN IF NOT EXISTS invoice_type text DEFAULT 'hourly';

UPDATE users SET invoice_type = 'per_metre'
WHERE email ILIKE '%emeka%' OR email ILIKE '%henry%';
