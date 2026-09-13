-- Capture completeness and deployable grants. Service-role/private table only.
-- Do not grant machine-local roles. Do not apply to production from this lane.
ALTER TABLE sales_booking_conversation_captures ADD COLUMN IF NOT EXISTS completeness text;
ALTER TABLE sales_booking_conversation_captures ADD COLUMN IF NOT EXISTS coverage jsonb;
UPDATE sales_booking_conversation_captures SET completeness = 'unknown' WHERE completeness IS NULL;
ALTER TABLE sales_booking_conversation_captures ALTER COLUMN completeness SET DEFAULT 'unknown';

REVOKE ALL ON TABLE sales_booking_conversation_captures FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE sales_booking_conversation_captures TO service_role;
