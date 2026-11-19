-- Rollback of the cost-lines cutover writer (P2-01.8). Drops only its two
-- functions, and only over the bodies the migration made. The marker row and
-- any stamps a completion wrote stay: a stamp records what the owner did, and
-- the switch job_cost_events_from_cost_lines_v1 still decides what Job Profit
-- reads.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $guard$
DECLARE h text;
BEGIN
  SELECT md5(p.prosrc) INTO h FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.job_cost_events_cutover_check(uuid,date)');
  IF h IS NOT NULL AND h <> 'e21f4ab58a295a1d300826af84237f5d' THEN
    RAISE EXCEPTION 'job_cost_events_cutover_check_body_changed';
  END IF;
  SELECT md5(p.prosrc) INTO h FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.job_cost_events_cutover_complete(uuid,date,boolean)');
  IF h IS NOT NULL AND h <> '753a125fad2af39f77d7f683f93a96b2' THEN
    RAISE EXCEPTION 'job_cost_events_cutover_complete_body_changed';
  END IF;
END
$guard$;
DROP FUNCTION IF EXISTS public.job_cost_events_cutover_complete(uuid, date, boolean);
DROP FUNCTION IF EXISTS public.job_cost_events_cutover_check(uuid, date);
