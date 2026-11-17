\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='120s';
CREATE FUNCTION public.fu21_slow_profit() RETURNS boolean LANGUAGE plpgsql AS $f$
/* function block */ BEGIN PERFORM pg_sleep(1); RETURN true; END $f$;
DO $instrument$ DECLARE d text:=pg_get_viewdef('public.v_job_profit'::regclass,true); BEGIN
 EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS SELECT * FROM ('||rtrim(d,E';\n ')||') p WHERE public.fu21_slow_profit()';
END $instrument$;
-- The timeout is installed before the refresh statement starts. Cancellation
-- aborts this transaction, including the view instrumentation and all writes.
SET LOCAL statement_timeout='50ms';
SELECT public.job_profit_refresh('ffffffff-ffff-4fff-8fff-ffffffffff01');
