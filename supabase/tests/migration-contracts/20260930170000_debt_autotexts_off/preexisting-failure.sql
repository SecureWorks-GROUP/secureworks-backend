-- pg_cron reports success but the job is still there (a stand-in unschedule
-- that deletes nothing). The migration must not report the thank-you path off
-- while a job that reaches it is still scheduled. This database is discarded
-- after the proof, so the stand-in may persist here.
\ir fixture.sql

CREATE OR REPLACE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean
  LANGUAGE sql AS 'SELECT true';
