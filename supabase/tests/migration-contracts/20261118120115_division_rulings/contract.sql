BEGIN;
-- The labour hire successor (20261120101600) replaces this migration's
-- three-argument body, which this migration's own guard pins. On a full stack,
-- roll the successor back before the re-apply, then put it back so the shared
-- examples (which carry labour hire rows) are read against the newest rule.
SELECT (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.job_division_option(text,text,uuid)'))
         IS NOT DISTINCT FROM '387e0eb966d0e8bb02fe7546e6bbeba2' AS has_labour_hire \gset
\if :has_labour_hire
\ir ../../../rollbacks/20261120101600_labour_hire_division_down.sql
\endif
\ir ../../../migrations/20261118120115_division_rulings.sql
\ir ../../../migrations/20261120101600_labour_hire_division.sql
\ir examples.sql
ROLLBACK;
