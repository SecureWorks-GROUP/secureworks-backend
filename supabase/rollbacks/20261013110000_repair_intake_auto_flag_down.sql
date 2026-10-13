-- Rollback for 20261013110000_repair_intake_auto_flag.sql: removes the switch.
-- A missing flag reads as off, so intake is back to every repair draft waiting
-- for a person. No draft, case or job is touched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DELETE FROM public.feature_flags
WHERE flag_name = 'repair_intake_auto_v1';
