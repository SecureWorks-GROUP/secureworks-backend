-- Rollback for 20261013170000_makesafe_notify_repair_recipients.sql: removes
-- the repair recipient list. Deploy an ops-api that does not read the column
-- first: with the column gone, the repair text's recipient read fails, so a
-- new repair job sends no staff text and records
-- repair_recipient_config_read_failed. Make-safe texts do not read the column
-- and are unaffected. No job, draft or sent-text record is touched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.makesafe_notify_settings
  DROP COLUMN IF EXISTS repair_new_job_user_ids;
